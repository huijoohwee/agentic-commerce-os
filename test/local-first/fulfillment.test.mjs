import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';
import { FULFILLMENT_AGENT, digest } from '../../src/local-first/fulfillment-contract.ts';
import { CHECKOUT_OFFER } from '../../src/local-first/checkout-offer.ts';
import { stripeFixture } from './stripe-fixture.ts';

const origin = 'https://airvio.co', base = origin + '/agentic-commerce-os';
const env = { RELEASE_CANDIDATE_SHA: 'a'.repeat(40), CHECKOUT_MODE: 'sandbox',
  STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32), STOREFRONT_SESSION_SECRET: 'sandbox-test-secret-longer-than-32-characters',
  ASSETS: { fetch: async () => new Response('# Education materials') } };
const draft = { draftId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), revision: 1,
  title: 'Ceramic mug', description: 'Blue, 300 ml.' };
const terms = { offerId: CHECKOUT_OFFER.id, confirmed: true };
function fixture() {
  const runs = new Map(), calls = [];
  return { runs, calls, async invoke(operation, input, context) {
    calls.push({ operation, input, context });
    let run = runs.get(input.runId);
    if (!run && operation === 'start') {
      run = { owner: context.principalId, value: { runId: input.runId, status: 'running', agent: FULFILLMENT_AGENT } };
      runs.set(input.runId, run);
    }
    if (!run) return { runId: input.runId, status: 'blocked', reasonCode: 'run_missing' };
    if (run.owner !== context.principalId) return { runId: input.runId, status: 'blocked', reasonCode: 'run_forbidden' };
    if (operation === 'cancel') run.value.status = 'canceled';
    return structuredClone(run.value);
  }, complete(runId, text = 'Ceramic mug\n- Blue\n- 300 ml') {
    Object.assign(runs.get(runId).value, { status: 'completed', output: { text, privateProviderField: 'never expose' },
      events: [{ privatePrompt: 'not a product read model' }] });
  } };
}
function client(runtime = fixture(), stripe = stripeFixture()) {
  let cookie = '', token;
  return { runtime, stripe, async call(path, body, headers = {}) {
    const response = await fetchLocalFirst(new Request(base + path, { method: body ? 'POST' : 'GET',
      headers: { cookie, ...(body ? { origin, 'content-type': 'application/json', 'x-commerce-csrf': token } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) }), env, stripe.transport, runtime);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    if (value.csrfToken) token = value.csrfToken;
    return { status: response.status, value };
  } };
}
async function prepared(c) {
  await c.call('/checkout');
  const started = await c.call('/fulfillment/start', draft);
  assert.equal(started.status, 202); c.runtime.complete(started.value.runId);
  const result = await c.call('/fulfillment/status', { runId: started.value.runId });
  return { runId: result.value.runId, outputDigest: result.value.outputDigest };
}
test('a saved draft replays one principal-bound job and returns only reviewed output fields', async () => {
  const c = client(); await c.call('/checkout');
  const one = await c.call('/fulfillment/start', draft), two = await c.call('/fulfillment/start', draft);
  assert.equal(one.value.runId, two.value.runId); assert.equal(c.runtime.runs.size, 1);
  c.runtime.complete(one.value.runId);
  const value = (await c.call('/fulfillment/status', { runId: one.value.runId })).value;
  assert.equal(value.reviewRequired, true); assert.equal(value.outputDigest, await digest(value.text));
  assert.deepEqual(Object.keys(value).sort(), ['ok', 'outputDigest', 'reviewRequired', 'runId', 'status', 'text']);
  const next = await c.call('/fulfillment/start', { ...draft, revision: 2 });
  assert.notEqual(next.value.runId, one.value.runId);
  assert.equal(c.runtime.calls[0].input.maxParallel, 1);
  assert.match(c.runtime.calls[0].context.principalId, /^commerce-[a-f0-9]{64}$/u);
});
test('reviewed output binds one test payment, replayed receipt and private deliverable', async () => {
  const c = client(), fulfillment = await prepared(c), body = { ...terms, fulfillment, reviewed: true };
  const started = await c.call('/checkout/start', body), replay = await c.call('/checkout/start', body);
  assert.equal(started.status, 200); assert.deepEqual(replay.value, started.value);
  assert.equal(c.stripe.sessions.size, 1);
  assert.equal((await c.call('/checkout/download')).status, 409);
  c.stripe.complete(started.value.order.orderId);
  const receipt = await c.call('/checkout/receipt');
  assert.equal(receipt.value.realMoney, false); assert.equal(receipt.value.chargeMinor, 0);
  assert.deepEqual(receipt.value.fulfillment, { ...fulfillment, status: 'available' });
  assert.deepEqual((await c.call('/checkout/receipt')).value, receipt.value);
  assert.match((await c.call('/checkout/download')).value, /Your reviewed listing\n\nCeramic mug/);
});
test('missing review, incomplete output or stale digest cannot create a payment', async () => {
  const c = client(), fulfillment = await prepared(c);
  for (const reviewed of [false, null]) assert.equal((await c.call('/checkout/start', { ...terms, fulfillment, reviewed })).status, 400);
  assert.equal((await c.call('/checkout/start', { ...terms, fulfillment: { ...fulfillment, outputDigest: 'f'.repeat(64) }, reviewed: true })).status, 409);
  c.runtime.runs.get(fulfillment.runId).value.status = 'running';
  assert.equal((await c.call('/checkout/start', { ...terms, fulfillment, reviewed: true })).status, 409);
  assert.equal(c.stripe.calls.length, 0);
});
test('another signed session cannot read, cancel, retry or purchase an existing result', async () => {
  const owner = client(), fulfillment = await prepared(owner), other = client(owner.runtime, owner.stripe);
  await other.call('/checkout');
  for (const operation of ['status', 'cancel', 'retry']) {
    const body = { runId: fulfillment.runId, ...(operation === 'retry' ? { operationId: crypto.randomUUID() } : {}) };
    const response = await other.call('/fulfillment/' + operation, body);
    assert.equal(response.status, 403); assert.equal(response.value.text, undefined);
  }
  assert.equal((await other.call('/checkout/start', { ...terms, fulfillment, reviewed: true })).status, 403);
  assert.equal(owner.stripe.calls.length, 0);
});
test('input cannot choose a principal, agent, endpoint, task or authorization', async () => {
  const c = client(); await c.call('/checkout');
  for (const extra of [{ principalId: 'other' }, { agent: FULFILLMENT_AGENT }, { endpoint: 'https://other.test' }, { approved: true }])
    assert.equal((await c.call('/fulfillment/start', { ...draft, ...extra })).status, 400);
  for (const headers of [{ origin: 'https://other.test' }, { 'x-commerce-csrf': 'forged' }, { 'content-encoding': 'gzip' }])
    assert.equal((await c.call('/fulfillment/start', draft, headers)).status, 403);
  assert.equal((await c.call('/fulfillment/start', { ...draft, description: 'x'.repeat(17000) })).status, 413);
  assert.equal(c.runtime.calls.length, 0);
});
test('changed provider fulfillment metadata cannot unlock a paid result', async () => {
  const c = client(), fulfillment = await prepared(c);
  const started = await c.call('/checkout/start', { ...terms, fulfillment, reviewed: true });
  c.stripe.complete(started.value.order.orderId);
  c.stripe.sessions.get(started.value.order.orderId).metadata.fulfillment_digest = 'f'.repeat(64);
  assert.equal((await c.call('/checkout/download')).status, 503);
  assert.equal((await c.call('/checkout/receipt')).status, 503);
});
test('uncertain checkout retries the original binding without a second session', async () => {
  const c = client(), fulfillment = await prepared(c), original = c.stripe.transport;
  let lose = true;
  c.stripe.transport = async request => {
    const response = await original(request);
    if (request.method === 'POST' && lose) { lose = false; throw Error('lost response'); }
    return response;
  };
  const body = { ...terms, fulfillment, reviewed: true };
  assert.equal((await c.call('/checkout/start', body)).status, 503);
  assert.equal((await c.call('/checkout/start', body)).status, 200);
  assert.equal(c.stripe.sessions.size, 1);
  assert.equal((await c.call('/checkout/start', terms)).status, 409);
});
test('wrong definition, malformed output and unconfigured production composition fail closed', async () => {
  const c = client(), fulfillment = await prepared(c), run = c.runtime.runs.get(fulfillment.runId).value;
  run.agent = { ...FULFILLMENT_AGENT, revision: 'wrong' };
  assert.equal((await c.call('/fulfillment/status', { runId: fulfillment.runId })).status, 503);
  run.agent = FULFILLMENT_AGENT; run.output.text = 'x'.repeat(16001);
  assert.equal((await c.call('/fulfillment/status', { runId: fulfillment.runId })).status, 503);
  const response = await fetchLocalFirst(new Request(base + '/fulfillment/start', { method: 'POST' }), env);
  assert.equal(response.status, 503);
});
