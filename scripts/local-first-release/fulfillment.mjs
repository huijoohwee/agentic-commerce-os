import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createFulfillmentRelay, parseListingHostPins } from '../../src/local-first/fulfillment-relay.ts';
import { fetchGitHubJson } from '../production-release/human-authorization.ts';

export const FULFILLMENT_CONFIG = 'deployment/local-first-fulfillment.json';
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), keys.sort());

/** Committed operator pins are part of the reviewed source artifact; credentials stay private. */
export function parseFulfillmentRelease(value) {
  exact(value, ['schema', 'pins', 'reader']);
  assert.equal(value.schema, 'commerce.fulfillment-release/v1');
  const pins = parseListingHostPins(value.pins), reader = value.reader;
  exact(reader, ['sourceRevision', 'versionId', 'runId']);
  assert.match(reader.sourceRevision, /^[a-f0-9]{40}$/);
  assert(!/^0+$/.test(reader.sourceRevision));
  assert.match(reader.versionId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert(Number.isSafeInteger(reader.runId) && reader.runId > 0);
  return Object.freeze({ schema: value.schema, pins, reader: Object.freeze({ ...reader }) });
}

export function readFulfillmentRelease(file = FULFILLMENT_CONFIG) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192, 'Invalid fulfillment release file');
  return parseFulfillmentRelease(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function validateReaderRun(reader, run, jobs) {
  assert(run.id === reader.runId && run.head_sha === reader.sourceRevision
    && run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1
    && run.head_branch === 'main' && run.event === 'workflow_dispatch'
    && run.path === '.github/workflows/local-first-release.yml'
    && run.name === 'Local-first Production Release', 'Compatible reader run mismatch');
  assert.equal(run.repository.full_name, 'huijoohwee/agentic-commerce-os');
  const owner = run.repository.owner;
  assert(owner.type === 'User' && owner.login === 'huijoohwee' && owner.id > 0);
  for (const actor of [run.actor, run.triggering_actor]) {
    assert(actor.type === 'User' && actor.id === owner.id && actor.login === owner.login);
  }
  const release = jobs.jobs.filter(job => job.name === 'Authorized Local-first Production Release');
  assert(release.length === 1 && release[0].conclusion === 'success');
  for (const name of ['Verify scoped owner policy and actual run approval',
    'Deploy sandbox Worker and verify the exact public release']) {
    const steps = release[0].steps.filter(step => step.name === name);
    assert(steps.length === 1 && steps[0].conclusion === 'success', 'Compatible reader verification missing');
  }
}

export async function verifyFulfillmentRelease(release, { provider, routeAuthority, token, bearer,
  send = fetch, github = fetchGitHubJson, rendezvous = null } = {}) {
  if (!release) return null;
  const config = parseFulfillmentRelease(release);
  assert.equal(routeAuthority.mode, 'steady-state', 'Fulfillment requires the deployed compatible reader');
  // This rejects relay bindings on the fallback and verifies its source tag on the retained version.
  const readerVersion = await provider.version(config.reader.versionId, config.reader.sourceRevision, 'sandbox', null);
  const base = `https://api.github.com/repos/huijoohwee/agentic-commerce-os/actions/runs/${config.reader.runId}`;
  const [run, jobs] = await Promise.all([github(base, token), github(base + '/jobs', token)]);
  validateReaderRun(config.reader, run, jobs);
  const runtime = createFulfillmentRelay({ LISTING_HOST_PINS_JSON: JSON.stringify(config.pins),
    LISTING_HOST_BEARER: bearer }, send);
  const host = rendezvous ? await waitForFulfillmentHost({ ...rendezvous, pins: config.pins, bearer, send })
    : await runtime.ready(AbortSignal.timeout(20000));
  return { config, readerVersion, host, verifiedAt: new Date().toISOString() };
}

const temporaryNetworkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);

// Observe transport facts around the existing strict identity validator. Never
// classify its generic listing_host_unavailable error as a retry instruction.
async function probeHost(pins, { bearer, send, signal, budgetMs }) {
  let status, redirected, transportCode, host, error;
  const runtime = createFulfillmentRelay({ LISTING_HOST_PINS_JSON: JSON.stringify(pins), LISTING_HOST_BEARER: bearer },
    async request => {
      try {
        const response = await send(request);
        status = response.status; redirected = response.redirected;
        return response;
      } catch (failure) {
        const code = failure?.cause?.code ?? failure?.code;
        if (temporaryNetworkCodes.has(code)) transportCode = code;
        throw failure;
      }
    });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, budgetMs);
  let onAbort;
  try {
    if (signal?.aborted) cancel();
    if (controller.signal.aborted) throw Error('cancelled');
    host = await Promise.race([runtime.ready(controller.signal), new Promise((_, reject) => {
      onAbort = () => reject(Error('probe_timeout'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    })]);
  } catch (failure) { error = failure; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) return { classification: 'cancelled', fatal: true };
  if (host) return { classification: 'ready', host };
  if (redirected || status >= 300 && status < 400) return { classification: 'redirect', status, fatal: true };
  if (status === 403) return { classification: 'denied', status };
  if (status === 502 || status === 503) return { classification: 'temporary-http', status };
  if (status === undefined && (transportCode || controller.signal.aborted))
    return { classification: 'temporary-transport', ...(transportCode ? { transportCode } : { transportCode: 'PROBE_TIMEOUT' }) };
  return { classification: error?.message === 'listing_host_identity_mismatch' ? 'identity-mismatch'
    : status === undefined ? 'unclassified-transport' : 'invalid-response', ...(status === undefined ? {} : { status }), fatal: true };
}

/** Release-only rendezvous. A pending transport observation establishes no host
 * identity; only strict candidate readiness permits the caller to continue. */
export async function waitForFulfillmentHost({ pins: inputPins, previousPins: inputPreviousPins, bearer,
  send = fetch, signal, observe = () => {}, now = () => performance.timeOrigin + performance.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }), timeoutMs = 300000, intervalMs = 5000 }) {
  const pins = parseListingHostPins(inputPins), previousPins = parseListingHostPins(inputPreviousPins);
  assert(JSON.stringify(pins) !== JSON.stringify(previousPins), 'Host rendezvous requires changed exact pins');
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000
    && Number.isInteger(intervalMs) && intervalMs > 0 && intervalMs <= 5000, 'Invalid host rendezvous bound');
  const started = now(), deadline = started + timeoutMs;
  const evidence = { schema: 'commerce.fulfillment-host-rendezvous/v1', candidatePins: pins, previousPins,
    startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString(),
    timeoutMs, status: 'waiting', observations: [] };
  const checkpoint = () => {
    if (signal?.aborted) throw Error('host_rendezvous_cancelled');
    if (now() >= deadline) throw Error('host_rendezvous_deadline');
  };
  const probe = async (target, selected, attempt) => {
    checkpoint();
    const result = await probeHost(selected, { bearer, send, signal, budgetMs: Math.min(15000, deadline - now()) });
    const { host, fatal, ...observation } = result;
    evidence.observations.push({ attempt, target, ...observation, observedAt: new Date(now()).toISOString() });
    observe(structuredClone(evidence)); checkpoint();
    if (fatal) throw Error('host_rendezvous_' + result.classification);
    return result;
  };
  try {
    observe(structuredClone(evidence));
    for (let attempt = 1; ; attempt++) {
      const candidate = await probe('candidate', pins, attempt);
      if (candidate.host) { evidence.status = 'ready'; return candidate.host; }
      if (candidate.classification === 'denied') {
        const previous = await probe('predecessor', previousPins, attempt);
        if (previous.classification === 'denied') {
          // Cutover may finish between the two requests. One strict candidate
          // recheck distinguishes the new host from an unexplained denial pair.
          const recheck = await probe('candidate', pins, attempt);
          if (recheck.host) { evidence.status = 'ready'; return recheck.host; }
          if (recheck.classification === 'denied') throw Error('host_rendezvous_unexplained_denial');
        }
        // The operator may stop the old host between these sequential probes.
        // Its classified gap is pending, not evidence authenticating the 403.
        else if (!previous.host && !['temporary-http', 'temporary-transport'].includes(previous.classification))
          throw Error('host_rendezvous_unexplained_denial');
      }
      checkpoint();
      await sleep(Math.min(intervalMs, deadline - now()), signal);
    }
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = signal?.aborted ? 'host_rendezvous_cancelled'
      : /^host_rendezvous_[a-z_-]+$/.test(error.message) ? error.message : 'host_rendezvous_failed';
    throw Error(evidence.error);
  } finally { evidence.finishedAt = new Date(now()).toISOString(); observe(structuredClone(evidence)); }
}
