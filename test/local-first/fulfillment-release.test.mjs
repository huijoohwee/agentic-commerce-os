import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFulfillmentRelease, parseFulfillmentRelease, validateReaderRun,
  verifyFulfillmentRelease, waitForFulfillmentHost } from '../../scripts/local-first-release/fulfillment.mjs';
import { listingHostIdentity } from '../../src/local-first/fulfillment-relay.ts';
import { createProvider } from '../../scripts/local-first-release/provider.mjs';
import { deployLocalFirst, selectFailureRecovery } from '../../scripts/local-first-release/deployment.mjs';

const config = readFulfillmentRelease(), bearer = '1'.repeat(64);
const source = 'c'.repeat(40), zone = 'd'.repeat(32);
const previousPins = { ...config.pins, bundleSha256: 'a'.repeat(64), sourceRevision: 'b'.repeat(40) };
function readerFixture() {
  const owner = { id: 17, login: 'huijoohwee', type: 'User' };
  const run = { id: config.reader.runId, head_sha: config.reader.sourceRevision,
    status: 'completed', conclusion: 'success', run_attempt: 1, head_branch: 'main',
    event: 'workflow_dispatch', path: '.github/workflows/local-first-release.yml',
    name: 'Local-first Production Release', actor: owner, triggering_actor: owner,
    repository: { full_name: 'huijoohwee/agentic-commerce-os', owner } };
  const jobs = { jobs: [{ name: 'Authorized Local-first Production Release', conclusion: 'success',
    steps: ['Verify scoped owner policy and actual run approval',
      'Deploy sandbox Worker and verify the exact public release'].map(name => ({ name, conclusion: 'success' })) }] };
  return { run, jobs };
}

test('committed fulfillment pins require a bounded regular file and exact closed configuration', t => {
  assert.equal(parseFulfillmentRelease(config).pins.sourceRevision, config.pins.sourceRevision);
  for (const value of [{ ...config, credential: bearer }, { ...config, reader: { ...config.reader, runId: 0 } },
    { ...config, pins: { ...config.pins, origin: 'http://localhost' } },
    { ...config, reader: { ...config.reader, sourceRevision: '0'.repeat(40) } }]) {
    assert.throws(() => parseFulfillmentRelease(value));
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, 'config.json');
  assert.equal(readFulfillmentRelease(file), null);
  fs.writeFileSync(file, ' '.repeat(8193)); assert.throws(() => readFulfillmentRelease(file));
  fs.symlinkSync(file, path.join(directory, 'link')); assert.throws(() => readFulfillmentRelease(path.join(directory, 'link')));
});

test('compatible reader proof refuses changed source, owner, attempt, approval and failed browser release', () => {
  const good = readerFixture(); assert.doesNotThrow(() => validateReaderRun(config.reader, good.run, good.jobs));
  for (const mutate of [
    f => { f.run.head_sha = source; }, f => { f.run.run_attempt = 2; },
    f => { f.run.conclusion = 'failure'; }, f => { f.run.actor = { ...f.run.actor, id: 19 }; },
    f => { f.jobs.jobs[0].steps[0].conclusion = 'skipped'; },
    f => { f.jobs.jobs[0].steps[1].conclusion = 'failure'; },
  ]) { const f = readerFixture(); mutate(f); assert.throws(() => validateReaderRun(config.reader, f.run, f.jobs)); }
});

test('activation verifies the retained reader and authenticated exact host; offline and changed hosts refuse', async () => {
  const { run, jobs } = readerFixture(); let state = 'ready', probes = 0;
  const options = { token: 'fixture-only', bearer, routeAuthority: { mode: 'steady-state' },
    provider: { async version(...args) {
      assert.deepEqual(args, [config.reader.versionId, config.reader.sourceRevision, 'sandbox', null]);
      return { fulfillmentPins: null, sourceRevision: config.reader.sourceRevision };
    } }, github: async url => url.endsWith('/jobs') ? jobs : run,
    send: async request => {
      probes++; assert.equal(request.headers.get('authorization'), 'Bearer ' + bearer);
      assert.equal(request.headers.get('x-commerce-host-source'), config.pins.sourceRevision);
      if (state === 'offline') throw Error('disconnected');
      const host = listingHostIdentity(config.pins);
      return Response.json(state === 'changed' ? { ...host, bundleSha256: 'e'.repeat(64) } : host,
        { headers: { 'cache-control': 'no-store' } });
    } };
  const proof = await verifyFulfillmentRelease(config, options);
  assert.deepEqual(proof.host, listingHostIdentity(config.pins));
  for (state of ['offline', 'changed']) await assert.rejects(verifyFulfillmentRelease(config, options));
  assert.equal(probes, 3);
  await assert.rejects(verifyFulfillmentRelease(config, { ...options, routeAuthority: { mode: 'bootstrap' } }));
  assert.equal(probes, 3); assert.equal(await verifyFulfillmentRelease(null), null);
});

test('provider distinguishes reader and relay profiles and rejects changed pins or unknown bindings', async t => {
  const base = [{ name: 'ASSETS', type: 'assets' }, { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    { name: 'RELEASE_CANDIDATE_SHA', type: 'plain_text', text: source },
    { name: 'CHECKOUT_MODE', type: 'plain_text', text: 'sandbox' },
    { name: 'STOREFRONT_SESSION_SECRET', type: 'secret_text' }, { name: 'STRIPE_TEST_SECRET_KEY', type: 'secret_text' }];
  const relay = [{ name: 'LISTING_HOST_PINS_JSON', type: 'plain_text', text: JSON.stringify(config.pins) },
    { name: 'LISTING_HOST_BEARER', type: 'secret_text' }];
  let bindings = [...base, ...relay];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true,
    result: { resources: { bindings }, annotations: { 'workers/tag': source } } }));
  const provider = createProvider({ accountId: zone, zoneId: zone, token: 'fixture-only' });
  assert.deepEqual((await provider.version('version', source, 'sandbox', config.pins)).fulfillmentPins, config.pins);
  await assert.rejects(provider.version('version', source, 'sandbox', null), /pins mismatch/);
  bindings = base;
  await assert.rejects(provider.version('version', source, 'sandbox', config.pins), /pins mismatch/);
  assert.equal((await provider.version('reader', source, 'sandbox', null)).fulfillmentPins, null);
  bindings = [...base, relay[0]]; await assert.rejects(provider.version('partial'), /local-first profile/);
  bindings = [...base, ...relay, { name: 'UNKNOWN', type: 'secret_text' }];
  await assert.rejects(provider.version('foreign'), /local-first profile/);
});

test('a late public host failure restores the exact reader without overwriting peer activity', async () => {
  for (const peer of [false, true]) {
    const before = { deploymentId: 'reader-deployment', versionId: config.reader.versionId };
    const candidate = { deploymentId: 'candidate-deployment', versionId: 'candidate-version' };
    const route = { id: 'b'.repeat(32), pattern: 'airvio.co/agentic-commerce-os*', script: 'agentic-commerce-edge-production', state: 'bound' };
    let active = before; const calls = [], journal = {};
    const provider = { active: async () => active, route: async () => route,
      version: async (id, _source, _checkout, pins) => {
        if (id === before.versionId) return { sourceRevision: config.reader.sourceRevision, fulfillmentPins: null };
        assert.equal(id, candidate.versionId); assert.deepEqual(pins, config.pins);
        return { sourceRevision: source, fulfillmentPins: config.pins };
      },
      exposure: async () => ({ enabled: false, previews_enabled: false }) };
    await assert.rejects(deployLocalFirst({ provider, before: { active: before, route }, journal,
      routeAuthority: { schema: 'agentic-commerce-production-route-authority/v2', mode: 'steady-state',
        zoneId: zone, zoneName: 'airvio.co', routeId: route.id, pattern: route.pattern, script: route.script },
      revision: source, fulfillment: config, secretsFile: '/fixture/private.json', checkMain() {}, record() {},
      wrangler(args) {
        calls.push(args);
        if (args[0] === 'deploy') { assert(args.includes('LISTING_HOST_PINS_JSON:' + JSON.stringify(config.pins))); active = candidate; }
        else active = before;
      }, async verifyLive() { if (peer) active = { deploymentId: 'peer', versionId: 'peer' }; throw Error('host offline'); },
    }), /host offline/);
    assert.equal(calls.length, peer ? 1 : 2);
    assert.equal(journal.outcome, peer ? 'preserve-required' : 'failed-previous-version-restored');
  }
});

function rendezvousFixture(sequence, timeoutMs = 30000) {
  let time = 0;
  const requests = [], evidence = [], sleeps = [];
  const options = { pins: config.pins, previousPins, bearer, timeoutMs, now: () => time,
    observe: item => evidence.push(item), sleep: async ms => { sleeps.push(ms); time += ms; },
    send: async request => {
      requests.push(request);
      assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.get('authorization'), 'Bearer ' + bearer);
      assert.equal(new URL(request.url).pathname, '/agentic-commerce-os/fulfillment/host-ready');
      const next = sequence.shift(); assert(next, 'Unexpected extra host probe');
      const expected = next.previous ? previousPins : config.pins;
      assert.equal(request.headers.get('x-commerce-host-source'), expected.sourceRevision);
      if (next.error) throw next.error;
      if (next.raw) return next.raw;
      return Response.json(next.body ?? listingHostIdentity(expected), { status: next.status ?? 200,
        headers: { 'cache-control': 'no-store' } });
    } };
  return { options, requests, evidence, sleeps };
}

test('approved changed-host rendezvous verifies the reader once, then old host, gap and exact candidate', async () => {
  const f = rendezvousFixture([{ status: 403 }, { previous: true }, { status: 503 },
    { error: new TypeError('fetch failed', { cause: Object.assign(Error('connection refused'), { code: 'ECONNREFUSED' }) }) }, {}]);
  const { run, jobs } = readerFixture(); let readerChecks = 0, githubReads = 0;
  const proof = await verifyFulfillmentRelease(config, { bearer, routeAuthority: { mode: 'steady-state' },
    provider: { async version() { readerChecks++; assert.equal(f.requests.length, 0); return { fulfillmentPins: null }; } },
    github: async url => { githubReads++; return url.endsWith('/jobs') ? jobs : run; }, send: f.options.send,
    rendezvous: f.options });
  assert.deepEqual(proof.host, listingHostIdentity(config.pins));
  assert.equal(readerChecks, 1); assert.equal(githubReads, 2); assert.equal(f.requests.length, 5);
  assert.deepEqual(f.sleeps, [5000, 5000, 5000]);
  const final = f.evidence.at(-1);
  assert.equal(final.status, 'ready');
  assert.deepEqual(final.observations.map(item => [item.target, item.classification]), [
    ['candidate', 'denied'], ['predecessor', 'ready'], ['candidate', 'temporary-http'],
    ['candidate', 'temporary-transport'], ['candidate', 'ready']]);
  assert(!JSON.stringify(final).includes(bearer));
});

test('a classified initial connection gap needs no invented predecessor observation', async () => {
  for (const first of [{ status: 502 }, { status: 503 },
    { error: Object.assign(Error('reset'), { code: 'ECONNRESET' }) }]) {
    const f = rendezvousFixture([first, {}]);
    assert.deepEqual(await waitForFulfillmentHost(f.options), listingHostIdentity(config.pins));
    assert.equal(f.requests.length, 2);
    assert(f.evidence.at(-1).observations.every(item => item.target === 'candidate'));
  }
});

test('a cutover gap between candidate denial and the predecessor probe remains pending without an identity grant', async () => {
  for (const gap of [{ status: 502 }, { status: 503 },
    { error: Object.assign(Error('old host closed'), { code: 'ECONNREFUSED' }) }]) {
    const f = rendezvousFixture([{ status: 403 }, { previous: true, ...gap }, {}]);
    assert.deepEqual(await waitForFulfillmentHost(f.options), listingHostIdentity(config.pins));
    assert.equal(f.requests.length, 3); assert.deepEqual(f.sleeps, [5000]);
    const observations = f.evidence.at(-1).observations;
    assert.equal(observations[1].target, 'predecessor');
    assert.match(observations[1].classification, /^temporary-/);
    assert.equal(observations.filter(item => item.classification === 'ready').length, 1);
    assert.equal(observations.at(-1).target, 'candidate');
  }
});

test('a denial pair gets one strict candidate recheck for fast cutover; a third denial is fatal', async () => {
  for (const next of [{}, { status: 403 }, { status: 503 }]) {
    const f = rendezvousFixture([{ status: 403 }, { previous: true, status: 403 }, next,
      ...(next.status === 503 ? [{}] : [])]);
    if (next.status === 403) await assert.rejects(waitForFulfillmentHost(f.options), /unexplained_denial/);
    else assert.deepEqual(await waitForFulfillmentHost(f.options), listingHostIdentity(config.pins));
    assert.equal(f.requests.length, next.status === 503 ? 4 : 3);
    assert.deepEqual(f.sleeps, next.status === 503 ? [5000] : []);
    assert.equal(f.evidence.at(-1).status, next.status === 403 ? 'failed' : 'ready');
  }
});

test('host rendezvous uses one absolute deadline and bounds its final interval', async () => {
  const f = rendezvousFixture([{ status: 503 }, { status: 502 }], 7000);
  await assert.rejects(waitForFulfillmentHost(f.options), /host_rendezvous_deadline/);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.sleeps, [5000, 2000]);
  assert(f.evidence.every(item => item.deadlineAt === new Date(7000).toISOString()));
  assert.equal(f.evidence.at(-1).status, 'failed');
  assert.equal(f.evidence.at(-1).error, 'host_rendezvous_deadline');
});

test('host redirects, invalid identity/body, auth failures and unknown errors stop without retry', async () => {
  for (const sequence of [
    [{ body: { ...listingHostIdentity(config.pins), bundleSha256: '0'.repeat(64) } }],
    [{ raw: new Response('{', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) }],
    [{ raw: Response.redirect('https://elsewhere.invalid/', 302) }],
    [{ raw: Response.json(listingHostIdentity(config.pins)) }],
    [{ status: 401 }], [{ status: 500 }],
    [{ error: new TypeError('fetch failed') }],
    [{ error: Object.assign(Error('certificate refused'), { code: 'CERT_HAS_EXPIRED' }) }],
    [{ status: 403 }, { previous: true, body: listingHostIdentity(config.pins) }],
  ]) {
    const count = sequence.length, f = rendezvousFixture(sequence);
    await assert.rejects(waitForFulfillmentHost(f.options), /host_rendezvous_/);
    assert.equal(f.requests.length, count); assert.deepEqual(f.sleeps, []);
    assert.equal(f.evidence.at(-1).status, 'failed');
  }
});

test('cancelled rendezvous aborts its current probe and never issues an additional request', async () => {
  for (const preAborted of [false, true]) {
    const controller = new AbortController(), evidence = [];
    let calls = 0, requestSignal, complete;
    if (preAborted) controller.abort();
    const pending = waitForFulfillmentHost({ pins: config.pins, previousPins, bearer, signal: controller.signal,
      observe: item => evidence.push(item), send: request => {
        calls++; requestSignal = request.signal;
        queueMicrotask(() => controller.abort());
        return new Promise(resolve => { complete = resolve; });
      } });
    await assert.rejects(pending, /host_rendezvous_cancelled/);
    assert.equal(calls, preAborted ? 0 : 1);
    if (requestSignal) assert.equal(requestSignal.aborted, true);
    complete?.(Response.json(listingHostIdentity(config.pins), { headers: { 'cache-control': 'no-store' } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, preAborted ? 0 : 1); assert.equal(evidence.at(-1).status, 'failed');
  }
});

test('a noncooperative host and backward wall-clock step cannot extend the remaining deadline', async t => {
  let calls = 0, requestSignal; const evidence = [];
  const wallClock = Date.now.bind(Date), controller = new AbortController(); let clockShift = 0;
  t.mock.method(Date, 'now', () => wallClock() + clockShift);
  const safety = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(waitForFulfillmentHost({ pins: config.pins, previousPins, bearer,
      signal: controller.signal, timeoutMs: 25, observe: item => evidence.push(item), send: request => {
        calls++; requestSignal = request.signal; clockShift = -3600000; return new Promise(() => {});
      } }), /host_rendezvous_deadline/);
  } finally { clearTimeout(safety); }
  assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
  assert.equal(evidence.at(-1).status, 'failed');
});

test('only changed sandbox predecessor pins select rendezvous; normal verification stays single-shot', async () => {
  const input = { checkout: 'sandbox', mode: 'steady-state', predecessor: { fulfillmentPins: previousPins }, fulfillment: config };
  assert.deepEqual(selectFailureRecovery(input).previousPins, previousPins);
  for (const override of [{ checkout: 'live' }, { checkout: 'live-reader' }, { mode: 'bootstrap' },
    { predecessor: { fulfillmentPins: config.pins } }, { predecessor: { fulfillmentPins: null } }])
    assert.equal(selectFailureRecovery({ ...input, ...override }), null);
  const { run, jobs } = readerFixture(); let calls = 0;
  const options = { bearer, routeAuthority: { mode: 'steady-state' }, provider: { version: async () => ({}) },
    github: async url => url.endsWith('/jobs') ? jobs : run,
    send: async () => { calls++; return new Response('', { status: 503 }); } };
  await assert.rejects(verifyFulfillmentRelease(config, options), /listing_host_unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(verifyFulfillmentRelease(config, { ...options, rendezvous: { previousPins },
    provider: { version: async () => { throw Error('reader invalid'); } } }), /reader invalid/);
  assert.equal(calls, 1);
  await assert.rejects(waitForFulfillmentHost({ pins: config.pins, previousPins: config.pins, bearer }), /changed exact pins/);
  await assert.rejects(waitForFulfillmentHost({ pins: config.pins, previousPins, bearer, timeoutMs: 300001 }), /Invalid host rendezvous bound/);
});
