import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFulfillmentRelease, parseFulfillmentRelease, validateReaderRun,
  verifyFulfillmentRelease } from '../../scripts/local-first-release/fulfillment.mjs';
import { listingHostIdentity } from '../../src/local-first/fulfillment-relay.ts';
import { createProvider } from '../../scripts/local-first-release/provider.mjs';
import { deployLocalFirst } from '../../scripts/local-first-release/deployment.mjs';

const config = readFulfillmentRelease(), bearer = '1'.repeat(64);
const source = 'c'.repeat(40), zone = 'd'.repeat(32);
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
      version: async (_id, _source, _checkout, pins) => assert.deepEqual(pins, config.pins),
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
