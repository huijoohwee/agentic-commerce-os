import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';
import { FULFILLMENT_AGENT, digest } from '../../src/local-first/fulfillment-contract.ts';
import { CHECKOUT_OFFER } from '../../src/local-first/checkout-offer.ts';
import { stripeFixture } from './stripe-fixture.ts';

const origin = 'https://airvio.co', base = origin + '/agentic-commerce-os';
const terms = { confirmed: true, offerId: CHECKOUT_OFFER.id };
const env = { RELEASE_CANDIDATE_SHA: 'a'.repeat(40), CHECKOUT_MODE: 'sandbox',
  STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32), STOREFRONT_SESSION_SECRET: 'checkout-binding-fixture-secret-at-least-32',
  ASSETS: { fetch: async () => new Response('# Sample') } };
const text = 'Ceramic mug\n- Blue\n- 300 ml';
async function fixture() {
  const stripe = stripeFixture(), principals = new Set();
  const binding = { runId: 'listing-' + 'a'.repeat(64), outputDigest: await digest(text) };
  let cookie = '', token, loseResponse = false;
  const events = [{ sequence: 1, type: 'run_planned', at: new Date().toISOString() }];
  const runtime = { async invoke(operation, input, context) {
    assert.equal(operation, 'status'); principals.add(context.principalId);
    return { runId: input.runId, status: 'completed', agent: FULFILLMENT_AGENT, output: { text }, events };
  } };
  const transport = async request => {
    const response = await stripe.transport(request);
    if (loseResponse && request.method === 'POST') { loseResponse = false; throw Error('lost response'); }
    return response;
  };
  async function call(path, body) {
    const response = await fetchLocalFirst(new Request(base + path, {
      method: body ? 'POST' : 'GET', headers: { cookie,
        ...(body ? { origin, 'content-type': 'application/json', 'x-commerce-csrf': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, transport, runtime);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json(); if (value.csrfToken) token = value.csrfToken;
    return { status: response.status, value };
  }
  await call('/checkout');
  // Admission follows session issuance, including on a slow test runner.
  events[0].at = new Date(Date.now()).toISOString();
  return { call, stripe, binding, principals, events, lose() { loseResponse = true; } };
}
test('a reviewed listing replaces a completed generic test order without losing the job principal or duplicating a payment', async () => {
  const f = await fixture(), previous = (await f.call('/checkout/start', terms)).value.order;
  f.stripe.complete(previous.orderId);
  const previousReceipt = (await f.call('/checkout/receipt')).value;
  await f.call('/fulfillment/status', { runId: f.binding.runId });
  const body = { ...terms, fulfillment: f.binding, reviewed: true };
  f.lose();
  assert.equal((await f.call('/checkout/start', body)).status, 503);
  const next = await f.call('/checkout/start', body);
  assert.equal(next.status, 200); assert.notEqual(next.value.order.orderId, previous.orderId);
  assert.equal(f.stripe.sessions.size, 2);
  assert.deepEqual((await f.call('/checkout/start', body)).value, next.value);
  assert.equal(f.stripe.sessions.get(previous.orderId).payment_status, 'paid');
  assert.equal(previousReceipt.fulfillment, undefined);
  f.stripe.complete(next.value.order.orderId);
  const receipt = (await f.call('/checkout/receipt')).value;
  assert.deepEqual(receipt.fulfillment, { ...f.binding, status: 'available' });
  assert.equal(receipt.realMoney, false);
  assert.deepEqual((await f.call('/checkout/receipt')).value, receipt);
  await f.call('/fulfillment/status', { runId: f.binding.runId });
  assert.equal(f.principals.size, 1);
  assert.equal((await f.call('/checkout/start', terms)).status, 409);
  assert.equal(f.stripe.sessions.size, 2);
});
test('pending, unpaid, unreviewed or stale output cannot replace an existing test order', async () => {
  const f = await fixture(), previous = (await f.call('/checkout/start', terms)).value.order;
  const body = { ...terms, fulfillment: f.binding, reviewed: true };
  assert.equal((await f.call('/checkout/start', body)).status, 409);
  f.stripe.sessions.get(previous.orderId).status = 'complete';
  assert.equal((await f.call('/checkout/start', body)).status, 409);
  f.stripe.complete(previous.orderId);
  assert.equal((await f.call('/checkout/start', { ...body, reviewed: false })).status, 400);
  assert.equal((await f.call('/checkout/start', { ...body, fulfillment: { ...f.binding, outputDigest: 'f'.repeat(64) } })).status, 409);
  assert.equal(f.stripe.sessions.size, 1);
});
test('expired orders may be replaced only by an explicitly reviewed different listing', async () => {
  const f = await fixture(), previous = (await f.call('/checkout/start', terms)).value.order;
  await f.call('/checkout/cancel', terms);
  const body = { ...terms, fulfillment: f.binding, reviewed: true };
  const next = await f.call('/checkout/start', body);
  assert.equal(next.status, 200); assert.notEqual(next.value.order.orderId, previous.orderId);
  assert.equal(f.stripe.sessions.get(previous.orderId).status, 'expired');
  assert.equal(f.stripe.sessions.size, 2);
});

test('a new listing in an older signed session gets its own bounded checkout window', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(), previous = (await f.call('/checkout/start', terms)).value.order;
  f.stripe.complete(previous.orderId);
  await f.call('/fulfillment/status', { runId: f.binding.runId });
  now += 2 * 86400000; f.events[0].at = new Date(now).toISOString();
  const body = { ...terms, fulfillment: f.binding, reviewed: true };
  f.lose();
  assert.equal((await f.call('/checkout/start', body)).status, 503);
  now += 3600000;
  const next = await f.call('/checkout/start', body);
  assert.equal(next.status, 200); assert.equal(f.stripe.sessions.size, 2);
  f.stripe.complete(next.value.order.orderId);
  now += 24 * 3600000;
  assert.deepEqual((await f.call('/checkout/start', body)).value.order.fulfillment,
    { ...f.binding, status: 'available' });
  assert.equal((await f.call('/checkout/receipt')).value.orderId, next.value.order.orderId);
  assert.equal(f.principals.size, 1); assert.equal(f.stripe.sessions.size, 2);
});

test('an uncertain separate order cannot create another after its fixed replay window', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(), previous = (await f.call('/checkout/start', terms)).value.order;
  f.stripe.complete(previous.orderId);
  now += 2 * 86400000; f.events[0].at = new Date(now).toISOString();
  const body = { ...terms, fulfillment: f.binding, reviewed: true };
  f.lose();
  assert.equal((await f.call('/checkout/start', body)).status, 503);
  const calls = f.stripe.calls.length;
  now += 23 * 3600000;
  assert.equal((await f.call('/checkout/start', body)).value.code, 'checkout_session_expired');
  assert.equal(f.stripe.sessions.size, 2);
  assert.equal(f.stripe.calls.slice(calls).filter(c => c.method === 'POST').length, 0);
});

test('missing, future, stale or replaced planning events cannot extend the payment window', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(), previous = (await f.call('/checkout/start', terms)).value.order;
  f.stripe.complete(previous.orderId);
  for (const event of [undefined, { sequence: 2, type: 'run_planned', at: new Date(now).toISOString() },
    { sequence: 1, type: 'run_planned', at: new Date(now + 1).toISOString() },
    { sequence: 1, type: 'run_planned', at: new Date(now - 23 * 3600000).toISOString() },
    { sequence: 1, type: 'task_completed', at: new Date(now).toISOString() }]) {
    f.events.splice(0, f.events.length, ...(event ? [event] : []));
    const result = await f.call('/checkout/start', { ...terms, fulfillment: f.binding, reviewed: true });
    assert.equal(result.value.code, 'checkout_session_expired'); assert.equal(f.stripe.sessions.size, 1);
  }
});
