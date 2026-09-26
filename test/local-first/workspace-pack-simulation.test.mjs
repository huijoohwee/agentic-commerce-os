import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SCENARIOS, startSimulation, selectStage, applyRecovery, inspectSimulation, rejectRecovery, CONSOLE_TOOLS, toolGate, validateToolInput, customerPreview } from '../../public/local-first/workspace-pack.simulation.js';
import { handleWorkspacePack } from '../../src/local-first/workspace-pack.ts';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { createWorkspaceProgramPack, WORKSPACE_PACK_SCHEMA } from '../../src/generated/graph-workspace-pack.js';
import { handleCheckout } from '../../src/local-first/checkout.ts';
import { CHECKOUT_OFFER } from '../../src/local-first/checkout-offer.ts';
import { stripeFixture } from './stripe-fixture.ts';

const origin = 'https://airvio.co', packUrl = origin + '/agentic-commerce-os/services/workspace-pack';
const source = 'print(1)\n', input = { title: 'Rehearsal check', source,
  sourceDigest: createHash('sha256').update(source).digest('hex') };
const request = () => new Request(packUrl + '/api', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
function checkoutClient() {
  const fixture = stripeFixture(); let cookie = '', csrf = '';
  const env = { CHECKOUT_MODE: 'sandbox', STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32),
    STOREFRONT_SESSION_SECRET: 'simulation-test-secret-longer-than-32-characters',
    ASSETS: { fetch: async () => new Response('# Test deliverable') } };
  return { fixture, async call(route = '', body, headers = {}) {
    const response = await handleCheckout(new Request(origin + '/agentic-commerce-os/checkout' + route, {
      method: body ? 'POST' : 'GET', headers: { cookie, ...(body ? { origin, 'content-type': 'application/json',
        'x-commerce-csrf': csrf } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, fixture.transport);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (!route) csrf = (await response.clone().json()).csrfToken;
    return response;
  } };
}
const terms = { offerId: CHECKOUT_OFFER.id, confirmed: true };
test('rehearsal stages carry no live effects and reject unknown, stale or repeated recovery', () => {
  assert.deepEqual(Object.keys(SCENARIOS), ['calm', 'checkout', 'timeout', 'payment', 'backlog']);
  for (const scenario of Object.keys(SCENARIOS)) {
    const initial = startSimulation(scenario, 1);
    assert.equal(inspectSimulation(initial).outcome.status, SCENARIOS[scenario].before.status);
    assert.throws(() => applyRecovery(initial, 1), /not_reviewable/);
    assert.throws(() => applyRecovery(selectStage(initial, 'diagnosis'), 1), /not_reviewable/);
    const review = selectStage(initial, 'recovery');
    assert.throws(() => applyRecovery(review, 2), /not_reviewable/);
    const result = applyRecovery(review, 1);
    assert.equal(inspectSimulation(result).outcome.status, SCENARIOS[scenario].after.status);
    assert.throws(() => applyRecovery(result, 1), /not_reviewable/);
    assert.equal(initial.recovered, false);
    assert.equal(inspectSimulation(selectStage(result, 'triage')).outcome.status, SCENARIOS[scenario].before.status);
    assert.throws(() => { SCENARIOS[scenario].before.status = 999; }, TypeError);
  }
  assert.throws(() => startSimulation('unknown', 1), /state_invalid/);
  assert.throws(() => startSimulation('calm', 0), /state_invalid/);
  assert.throws(() => selectStage(startSimulation('calm', 1), 'publish'), /stage_invalid/);
});
test('Calm and Timeout fixtures match native service readiness, deadline and a fresh conversion', async t => {
  const ready = await handleWorkspacePack(new Request(packUrl + '/service.json'), 'a'.repeat(40));
  assert.equal(ready.status, SCENARIOS.calm.before.status);
  const descriptor = await ready.json();
  assert.equal(descriptor.price.mode, 'free');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let interrupted = false;
  const pending = handleWorkspacePack(new Request(packUrl + '/api', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ cancel() { interrupted = true; } }), duplex: 'half',
  }), 'a'.repeat(40));
  t.mock.timers.tick(descriptor.limits.deadlineMs);
  assert.equal((await pending).status, SCENARIOS.timeout.before.status);
  t.mock.timers.reset();
  assert.equal(interrupted, true);
  const retry = await handleWorkspacePack(request(), 'a'.repeat(40));
  assert.equal(retry.status, SCENARIOS.timeout.after.status);
  assert.equal((await retry.json()).files.length, 4);
});
test('Checkout fixture matches native confirmation refusal before provider access and a reviewed test request', async () => {
  const client = checkoutClient(); await client.call();
  const refused = await client.call('/start', terms, { 'x-commerce-csrf': 'invalid-fixture' });
  assert.equal(refused.status, SCENARIOS.checkout.before.status);
  assert.equal((await refused.json()).code, SCENARIOS.checkout.before.code);
  assert.equal(client.fixture.calls.length, 0);
  const accepted = await client.call('/start', terms);
  assert.equal(accepted.status, SCENARIOS.checkout.after.status);
  assert.equal((await accepted.json()).order.status, 'pending');
});
test('Payment fixture matches pending-delivery refusal and the verified test-payment gate', async () => {
  const client = checkoutClient(); await client.call();
  const started = await (await client.call('/start', terms)).json();
  const refused = await client.call('/download');
  assert.equal(refused.status, SCENARIOS.payment.before.status);
  assert.equal((await refused.json()).code, SCENARIOS.payment.before.code);
  client.fixture.complete(started.order.orderId);
  assert.equal((await client.call('/download')).status, SCENARIOS.payment.after.status);
});
test('Backlog fixture matches actual bounded local-host concurrency and explicit retry after completion', { timeout: 10000 }, async () => {
  const require = createRequire(import.meta.url), toolRequire = createRequire(require.resolve('wrangler/package.json'));
  await fs.mkdir('node_modules/.cache', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('node_modules/.cache/console-host-check-'));
  const file = path.join(directory, 'host.mjs');
  await toolRequire('esbuild').build({ entryPoints: ['src/local-host/workspace-pack-host.ts'], bundle: true,
    packages: 'external', platform: 'node', format: 'esm', outfile: file });
  const { startWorkspacePackHost } = await import(pathToFileURL(file).href);
  const pack = await createWorkspaceProgramPack({ schema: WORKSPACE_PACK_SCHEMA, ...input });
  const waiters = []; let busy = false, entered;
  const atCapacity = new Promise(resolve => { entered = resolve; });
  const host = await startWorkspacePackHost({ assets: path.resolve('public/local-first'), adapterDigest: 'a'.repeat(64),
    adapter: async () => { if (busy) await new Promise(resolve => { waiters.push(resolve); if (waiters.length === 4) entered(); }); return pack; } });
  const invoke = () => fetch(host.url + 'api', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
  let active = [];
  try {
    busy = true; active = Array.from({ length: 4 }, invoke);
    await Promise.race([atCapacity, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('test_capacity_not_reached')), 3000); timer.unref();
    })]);
    const refused = await invoke();
    assert.equal(refused.status, SCENARIOS.backlog.before.status);
    assert.equal((await refused.json()).code, SCENARIOS.backlog.before.code);
    busy = false; waiters.forEach(resolve => resolve());
    for (const response of await Promise.all(active)) { assert.equal(response.status, 200); await response.arrayBuffer(); }
    const retry = await invoke(); assert.equal(retry.status, SCENARIOS.backlog.after.status); await retry.arrayBuffer();
  } finally { busy = false; waiters.forEach(resolve => resolve()); await Promise.allSettled(active); await host.close(); await fs.rm(directory, { recursive: true }); }
});

test('Console capability gates, schemas and previews follow the exact current simulated run', () => {
  assert.equal(CONSOLE_TOOLS.length, 5);
  assert.equal(CONSOLE_TOOLS.some(tool => /approve|apply/.test(tool.name)), false);
  assert.equal(toolGate('inspect', null), null);
  assert.equal(toolGate('stage', null), 'Run a rehearsal first');
  validateToolInput('inspect', {}, null);
  assert.throws(() => validateToolInput('inspect', { source: 'private' }, null), /input_invalid/);
  assert.throws(() => validateToolInput('rehearse', { scenario: 'production' }, null), /input_invalid/);
  const triage = startSimulation('payment', 8);
  assert.throws(() => validateToolInput('propose', { runId: 8 }, triage), /Needs Recovery/);
  assert.throws(() => validateToolInput('diagnose', { runId: 8 }, triage), /Needs Diagnosis/);
  const recovery = selectStage(triage, 'recovery');
  validateToolInput('propose', { runId: 8 }, recovery);
  assert.throws(() => validateToolInput('stage', { runId: 7, stage: 'triage' }, recovery), /run_stale/);
  assert.throws(() => validateToolInput('stage', { runId: 8, stage: 'triage', approved: true }, recovery), /input_invalid/);
  const declined = rejectRecovery(recovery, 8);
  assert.throws(() => applyRecovery(declined, 8), /not_reviewable/);
  assert.throws(() => validateToolInput('propose', { runId: 8 }, declined), /Decision recorded/);
  assert.equal(inspectSimulation(declined).outcome.status, 409);
  assert.match(customerPreview(declined).decision, /unchanged/);
  assert.equal(customerPreview(applyRecovery(recovery, 8)).tone, 'ready');
  assert.equal(recovery.rejected, false);
});
