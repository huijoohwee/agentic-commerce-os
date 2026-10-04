import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { fetchLocalFirst } from '../../src/local-first/worker.ts';

const env = { RELEASE_CANDIDATE_SHA: 'a'.repeat(40), CHECKOUT_MODE: 'sandbox',
  STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32), STOREFRONT_SESSION_SECRET: 'readiness-fixture-secret-at-least-32',
  CF_VERSION_METADATA: { id: 'candidate-version' }, ASSETS: { fetch() { throw Error('No asset dispatch'); } } };
const base = 'https://airvio.co/agentic-commerce-os';
const request = (options) => new Request(base + '/readyz', options);
const runtime = ready => ({ ready, invoke() { assert.fail('Readiness must not execute a job'); } });

test('configured fulfillment health changes HTTP readiness without changing sandbox checkout identity', async () => {
  let available = false, probes = 0;
  const host = runtime(async signal => {
    probes++; assert.equal(signal.aborted, false);
    if (!available) throw Error('private host transport details');
    return { ok: true };
  });
  const unavailable = await fetchLocalFirst(request(), env, undefined, host);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.has('set-cookie'), false);
  const body = await unavailable.json();
  assert.equal(body.ok, false); assert.equal(body.checkout, 'sandbox');
  assert.equal(body.fulfillment, 'unavailable');
  assert.equal(JSON.stringify(body).includes('private'), false);
  available = true;
  const healthy = await fetchLocalFirst(request(), env, undefined, host);
  assert.equal(healthy.status, 200); assert.equal((await healthy.json()).fulfillment, 'ready');
  assert.equal(probes, 2, 'Every observation checks the current host; no stale shared cache');
  available = false;
  const head = await fetchLocalFirst(request({ method: 'HEAD' }), env, undefined, host);
  assert.equal(head.status, 503); assert.equal(await head.text(), '');
});

test('disabled local fulfillment is explicit while malformed configured fulfillment fails closed', async () => {
  const disabled = await worker.fetch(request(), env);
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).fulfillment, 'disabled');
  const broken = await worker.fetch(request(), { ...env, LISTING_HOST_PINS_JSON: '{}' });
  assert.equal(broken.status, 503); assert.equal((await broken.json()).fulfillment, 'unavailable');
  const unverifiable = await fetchLocalFirst(request(), env, undefined, runtime(undefined));
  assert.equal(unverifiable.status, 503);
  const invalid = await fetchLocalFirst(request(), { ...env, STRIPE_TEST_SECRET_KEY: undefined }, undefined,
    runtime(() => assert.fail('Invalid configuration must not probe a dependency')));
  assert.equal(invalid.status, 503);
});

test('request cancellation stops a readiness observation even when its adapter ignores cancellation', async () => {
  const controller = new AbortController();
  let started;
  const observing = new Promise(resolve => { started = resolve; });
  const response = fetchLocalFirst(request({ signal: controller.signal }), env, undefined,
    runtime(async signal => { started(signal); return new Promise(() => {}); }));
  const signal = await observing;
  controller.abort();
  assert.equal((await response).status, 503); assert.equal(signal.aborted, true);
});

test('unresponsive readiness is bounded independently of the host adapter', async () => {
  const start = Date.now(); let probeSignal;
  const response = await fetchLocalFirst(request(), env, undefined,
    runtime(signal => { probeSignal = signal; return new Promise(() => {}); }));
  assert.equal(response.status, 503); assert.equal(probeSignal.aborted, true);
  assert(Date.now() - start < 4500, 'Readiness must finish before the browser tool deadline');
});

test('environment tool returns the same degraded evidence without creating sessions or jobs', async () => {
  const response = await fetchLocalFirst(new Request(base + '/services/workspace/api', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'commerce.workspace.environment.read', arguments: {} }) }), env, undefined,
  runtime(async () => { throw Error('host unavailable'); }));
  assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false);
  const result = await response.json();
  assert.equal(result.readOnly, true); assert.equal(result.provenance, 'runtime-observation');
  assert.equal(result.value.ok, false); assert.equal(result.value.fulfillment, 'unavailable');
  assert.equal(result.value.sourceRevision, env.RELEASE_CANDIDATE_SHA);
});
