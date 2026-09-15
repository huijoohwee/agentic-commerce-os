import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  send = fetch, github = fetchGitHubJson } = {}) {
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
  const host = await runtime.ready(AbortSignal.timeout(20000));
  return { config, readerVersion, host, verifiedAt: new Date().toISOString() };
}
