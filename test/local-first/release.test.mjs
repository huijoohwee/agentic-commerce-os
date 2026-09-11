import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertLocalFirstConfig, WORKER } from '../../scripts/local-first-release/artifact.mjs';
import { createProvider } from '../../scripts/local-first-release/provider.mjs';
import { observeBefore, deployLocalFirst } from '../../scripts/local-first-release/deployment.mjs';

const revision = 'a'.repeat(40), routeId = 'b'.repeat(32), zoneId = 'c'.repeat(32);
const authority = { schema: 'agentic-commerce-production-route-authority/v2', mode: 'bootstrap',
  zoneId, zoneName: 'airvio.co', routeId: null, pattern: 'airvio.co/agentic-commerce-os*', script: WORKER };
const absent = { id: null, pattern: authority.pattern, script: null, state: 'absent' };
const bound = { id: routeId, pattern: authority.pattern, script: WORKER, state: 'bound' };
const candidate = { deploymentId: 'candidate-deployment', versionId: 'candidate-version' };
const prior = { deploymentId: 'prior-deployment', versionId: 'prior-version' };

test('local-first configuration refuses provider bindings, paid resources and premature routes', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.local-first.jsonc'));
  assert.doesNotThrow(() => assertLocalFirstConfig(config));
  for (const key of ['services', 'r2_buckets', 'd1_databases', 'durable_objects', 'containers', 'routes', 'observability']) {
    assert.throws(() => assertLocalFirstConfig({ ...config, [key]: [] }));
  }
  assert.throws(() => assertLocalFirstConfig({ ...config, workers_dev: true }));
  assert.throws(() => assertLocalFirstConfig({ ...config, vars: { ...config.vars, PAYMENT_KEY: 'value' } }));
});

test('a local process cannot execute protected release effects', () => {
  const result = spawnSync(process.execPath, ['scripts/local-first-release/execute.mjs'], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Protected first-attempt release context required/);
});

test('provider absence requires the precise not-found response; auth failure is never absence', async t => {
  let status = 404, code = 10007;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false, errors: [{ code }] }, { status }));
  const provider = createProvider({ accountId: zoneId, zoneId, token: 'fixture-only' });
  assert.equal(await provider.active(), null);
  for (const pair of [[401, 10007], [403, 10000], [404, 10000], [500, 10007]]) {
    [status, code] = pair;
    await assert.rejects(provider.active(), /Provider GET/);
  }
});

test('provider readback refuses foreign source tags and any additional binding', async t => {
  const bindings = [{ name: 'ASSETS', type: 'assets' }, { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    { name: 'RELEASE_CANDIDATE_SHA', type: 'plain_text', text: revision }];
  let result = { resources: { bindings }, annotations: { 'workers/tag': revision } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, result }));
  const provider = createProvider({ accountId: zoneId, zoneId, token: 'fixture-only' });
  assert.equal((await provider.version('version', revision)).sourceRevision, revision);
  await assert.rejects(provider.version('version', 'd'.repeat(40)), /source mismatch/);
  result = { ...result, resources: { bindings: [...bindings, { name: 'CORE', type: 'service' }] } };
  await assert.rejects(provider.version('version'), /asset-only/);
});

function fixture(mode = 'bootstrap', options = {}) {
  let active = mode === 'bootstrap' ? null : prior, route = mode === 'bootstrap' ? absent : bound;
  const calls = [], journal = { outcome: 'pending', active: null, route: null };
  const provider = {
    active: async () => active, route: async () => route,
    version: async (_id, sha) => { if (sha && options.foreignVersion) throw Error('source mismatch'); },
    exposure: async () => ({ enabled: false, previews_enabled: false }),
    bindRoute: async () => { calls.push('bind'); route = bound; if (options.lostRouteResponse) throw Error('route response lost'); },
    removeRoute: async () => { calls.push('remove'); route = absent; },
  };
  return { provider, journal, revision, calls, routeAuthority: { ...authority, mode, routeId: mode === 'bootstrap' ? null : routeId },
    checkMain() { calls.push('source-check'); }, record(stage) { calls.push(stage); },
    wrangler(args) {
      calls.push(args[0]);
      if (args[0] === 'deploy') { active = candidate; if (options.lostUploadResponse) throw Error('upload response lost'); }
      else active = prior;
    },
    async verifyLive() {
      calls.push('browser');
      if (options.peer) active = { deploymentId: 'peer-deployment', versionId: 'peer-version' };
      if (options.browserFailure || options.peer) throw Error('browser failure');
    },
  };
}
test('bootstrap verifies privately before binding the route and running live browser checks', async () => {
  const input = fixture(); input.before = await observeBefore(input.provider, input.routeAuthority);
  await deployLocalFirst(input);
  assert(input.calls.indexOf('version-verified') < input.calls.indexOf('bind'));
  assert(input.calls.indexOf('bind') < input.calls.indexOf('browser'));
  assert.deepEqual(input.journal.route, bound);
});
test('late bootstrap failure restores only the exact newly bound route and retains the Worker', async () => {
  const input = fixture('bootstrap', { browserFailure: true });
  input.before = await observeBefore(input.provider, input.routeAuthority);
  await assert.rejects(deployLocalFirst(input), /browser failure/);
  assert.equal(input.journal.outcome, 'failed-route-restored-worker-retained');
  assert.deepEqual(await input.provider.route(), absent); assert.deepEqual(await input.provider.active(), candidate);
});
test('steady-state browser failure restores the exact prior local-first version', async () => {
  const input = fixture('steady-state', { browserFailure: true });
  input.before = await observeBefore(input.provider, input.routeAuthority);
  await assert.rejects(deployLocalFirst(input), /browser failure/);
  assert.equal(input.journal.outcome, 'failed-previous-version-restored');
  assert.deepEqual(await input.provider.active(), prior); assert(!input.calls.includes('remove'));
});
test('lost provider responses, foreign versions and peer deployments are preserved without replay', async () => {
  for (const [mode, options] of [['bootstrap', { lostUploadResponse: true }], ['bootstrap', { lostRouteResponse: true }],
    ['steady-state', { foreignVersion: true }], ['steady-state', { peer: true }]]) {
    const input = fixture(mode, options); input.before = await observeBefore(input.provider, input.routeAuthority);
    await assert.rejects(deployLocalFirst(input));
    assert.equal(input.journal.outcome, 'preserve-required');
    assert.equal(input.calls.filter(call => call === 'deploy').length, 1);
    assert(!input.calls.includes('remove')); assert(!input.calls.includes('versions'));
  }
});
test('bootstrap cannot reuse an existing Worker and steady state cannot adopt a full-provider Worker', async () => {
  const input = fixture('steady-state');
  await assert.rejects(observeBefore({ ...input.provider, route: async () => absent }, authority), /Bootstrap Worker already exists/);
  await assert.rejects(observeBefore({ ...input.provider, version: async () => { throw Error('asset-only profile required'); } }, input.routeAuthority), /asset-only/);
});
