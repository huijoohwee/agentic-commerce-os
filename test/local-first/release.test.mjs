import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertLocalFirstConfig, WORKER } from '../../scripts/local-first-release/artifact.mjs';
import { createProvider } from '../../scripts/local-first-release/provider.mjs';
import { observeBefore, deployLocalFirst } from '../../scripts/local-first-release/deployment.mjs';
import { validateLocalFirstAuthorization, parseLocalFirstAuthorization } from '../../scripts/local-first-release/authorization.mjs';
import { validateHumanAuthorization, parseHumanAuthorizationReceipt } from '../../scripts/production-release/human-authorization.ts';
import { parseRetainedBaseline, validateRetainedRun } from '../../scripts/local-first-release/retained-baseline.mjs';

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
  await assert.rejects(provider.version('version'), /local-first profile/);
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
  return { provider, journal, revision, calls, secretsFile: '/fixture/secrets.json', routeAuthority: { ...authority, mode, routeId: mode === 'bootstrap' ? null : routeId },
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
  await assert.rejects(observeBefore({ ...input.provider, version: async () => { throw Error('owned local-first profile required'); } }, input.routeAuthority), /local-first profile/);
});

function ownerApprovalFixture() {
  const owner = { login: 'huijoohwee', id: 17, type: 'User' };
  const environment = { name: 'production', protection_rules: [{ type: 'required_reviewers',
    prevent_self_review: false, reviewers: [{ type: 'User', reviewer: owner }] }] };
  const reviews = [{ state: 'approved', environments: [{ name: 'production' }], user: owner }];
  const run = { id: 42, head_sha: revision, run_attempt: 1, head_branch: 'main', event: 'workflow_dispatch',
    name: 'Local-first Production Release', path: '.github/workflows/local-first-release.yml',
    repository: { full_name: 'huijoohwee/agentic-commerce-os', owner }, actor: owner, triggering_actor: owner };
  const expected = { releaseMode: 'bootstrap', candidateSha: revision, runId: 42, runAttempt: 1, artifactDigest: 'b'.repeat(64) };
  return { environment, reviews, run, expected, config: JSON.parse(fs.readFileSync('wrangler.local-first.jsonc')) };
}
const authorizeOwner = f => validateLocalFirstAuthorization(f.reviews, f.environment, f.run, f.config, f.expected);

test('owner approval is admitted only as a distinct local-first receipt; full-provider policy stays strict', () => {
  const f = ownerApprovalFixture();
  assert.throws(() => validateHumanAuthorization(f.reviews, f.environment, f.expected), /self_review_not_prevented/);
  const receipt = authorizeOwner(f);
  assert.equal(parseLocalFirstAuthorization(receipt, f.expected).approval.approver.id, 17);
  assert.throws(() => parseHumanAuthorizationReceipt(receipt, f.expected), /receipt_shape_invalid/);
  f.environment.protection_rules[0].prevent_self_review = true;
  assert.equal(validateHumanAuthorization(f.reviews, f.environment, f.expected).decision, 'approved');
});
test('owner approval cannot authorize another workflow, actor, source, attempt or provider profile', () => {
  for (const mutate of [
    f => { f.run.name = 'Production Release'; },
    f => { f.run.path = '.github/workflows/production.yml'; },
    f => { f.run.actor = { ...f.run.actor, id: 18 }; },
    f => { f.run.triggering_actor = { ...f.run.actor, type: 'Bot' }; },
    f => { f.run.repository.owner.type = 'Organization'; },
    f => { f.run.head_sha = 'c'.repeat(40); },
    f => { f.run.head_branch = 'feature'; },
    f => { f.run.run_attempt = 2; },
    f => { f.run.event = 'push'; },
    f => { f.config.services = []; },
  ]) {
    const f = ownerApprovalFixture(); mutate(f); assert.throws(() => authorizeOwner(f));
  }
});
test('owner policy still refuses missing, duplicated, unconfigured and non-owner approvals', () => {
  for (const mutate of [
    f => { f.reviews = []; },
    f => { f.reviews.push(structuredClone(f.reviews[0])); },
    f => { f.environment.protection_rules[0].reviewers = []; },
    f => { f.environment.protection_rules[0].prevent_self_review = undefined; },
    f => { f.reviews[0].user = { login: 'another-user', id: 18, type: 'User' };
      f.environment.protection_rules[0].reviewers.push({ type: 'User', reviewer: f.reviews[0].user }); },
  ]) {
    const f = ownerApprovalFixture(); mutate(f); assert.throws(() => authorizeOwner(f));
  }
});
test('local-first receipt refuses changed artifacts, source, run identity and checkout scope', () => {
  const f = ownerApprovalFixture(), receipt = authorizeOwner(f);
  for (const expected of [{ ...f.expected, artifactDigest: 'c'.repeat(64) },
    { ...f.expected, candidateSha: 'd'.repeat(40) }, { ...f.expected, runId: 43 }, { ...f.expected, runAttempt: 2 }]) {
    assert.throws(() => parseLocalFirstAuthorization(receipt, expected));
  }
  assert.throws(() => parseLocalFirstAuthorization({ ...receipt, checkout: 'enabled' }, f.expected));
  assert.throws(() => parseLocalFirstAuthorization(receipt.approval, f.expected));
});

const retained = { failedRunId: 42, sourceRevision: revision,
  deploymentId: '11111111-1111-1111-1111-111111111111', versionId: '22222222-2222-2222-2222-222222222222' };
test('retained bootstrap requires the exact failed owner-authorized production run', () => {
  const run = { ...ownerApprovalFixture().run, status: 'completed', conclusion: 'failure' };
  const jobs = { jobs: [{ name: 'Authorized Local-first Production Release', conclusion: 'failure', steps: [
    { name: 'Verify scoped owner policy and actual run approval', conclusion: 'success' },
    { name: 'Deploy asset-only Worker and verify the exact public release', conclusion: 'failure' },
  ] }] };
  assert.deepEqual(validateRetainedRun(retained, run, jobs), retained);
  for (const changed of [{ ...run, head_sha: 'c'.repeat(40) }, { ...run, conclusion: 'success' },
    { ...run, run_attempt: 2 }, { ...run, actor: { ...run.actor, id: 18 } }]) {
    assert.throws(() => validateRetainedRun(retained, changed, jobs));
  }
  jobs.jobs[0].steps[0].conclusion = 'failure';
  assert.throws(() => validateRetainedRun(retained, run, jobs));
  assert.throws(() => parseRetainedBaseline({ ...retained, extra: true }));
  assert.equal(parseRetainedBaseline(''), null);
});
test('a retained bootstrap still refuses absent, moved, foreign or already routed provider state', async () => {
  const active = { deploymentId: retained.deploymentId, versionId: retained.versionId };
  const provider = { active: async () => active, route: async () => absent,
    version: async (id, sha) => { assert.equal(id, retained.versionId); assert.equal(sha, revision); } };
  assert.deepEqual(await observeBefore(provider, authority, retained), { active, route: absent });
  await assert.rejects(observeBefore(provider, authority), /Bootstrap Worker already exists/);
  for (const override of [{ active: async () => null },
    { active: async () => ({ ...active, deploymentId: '33333333-3333-3333-3333-333333333333' }) },
    { version: async () => { throw Error('foreign source or service binding'); } }, { route: async () => bound }]) {
    await assert.rejects(observeBefore({ ...provider, ...override }, authority, retained));
  }
});
test('candidate readback requires both sandbox secrets and never accepts the deferred predecessor as the new version', async t => {
  const legacy = [{ name: 'ASSETS', type: 'assets' }, { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    { name: 'RELEASE_CANDIDATE_SHA', type: 'plain_text', text: revision }];
  let bindings = legacy;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true,
    result: { resources: { bindings }, annotations: { 'workers/tag': revision } } }));
  const provider = createProvider({ accountId: zoneId, zoneId, token: 'fixture-only' });
  await assert.rejects(provider.version('version', revision, 'sandbox'), /Sandbox profile required/);
  bindings = [...legacy, { name: 'CHECKOUT_MODE', type: 'plain_text', text: 'sandbox' },
    { name: 'STOREFRONT_SESSION_SECRET', type: 'secret_text' }, { name: 'STRIPE_TEST_SECRET_KEY', type: 'secret_text' }];
  await provider.version('version', revision, 'sandbox');
  bindings[3].text = 'live'; await assert.rejects(provider.version('version', revision, 'sandbox'));
  bindings[3].text = 'sandbox'; bindings[5] = { name: 'PAYMENTS', type: 'service' };
  await assert.rejects(provider.version('version', revision, 'sandbox'));
});
