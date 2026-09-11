import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';
import { CHECKOUT_OFFER } from '../../src/local-first/checkout-offer.ts';
import { stripeFixture } from './stripe-fixture.ts';
const origin = 'https://airvio.co', base = origin + '/agentic-commerce-os/checkout';
const env = { RELEASE_CANDIDATE_SHA: 'a'.repeat(40), CHECKOUT_MODE: 'sandbox',
  STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32), STOREFRONT_SESSION_SECRET: 'sandbox-test-secret-longer-than-32-characters',
  ASSETS: { async fetch(request) { assert.equal(new URL(request.url).pathname, '/education-materials.md');
    assert.deepEqual([...request.headers], []); return new Response('# Sample educational download'); } } };
function client(overrides = {}, fixture = stripeFixture()) {
  let cookie = '', csrf;
  return { fixture, get cookie() { return cookie; }, set cookie(value) { cookie = value; },
    async call(path = '', body, headers = {}, raw) {
      const response = await fetchLocalFirst(new Request(base + path, { method: body ? 'POST' : 'GET',
        headers: { cookie, ...(body ? { origin, 'content-type': 'application/json', 'x-commerce-csrf': csrf } : {}), ...headers },
        ...(body ? { body: raw ?? JSON.stringify(body) } : {}) }), { ...env, ...overrides }, fixture.transport);
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
      const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
      if (value.csrfToken) csrf = value.csrfToken;
      return { status: response.status, value, headers: response.headers };
    } };
}
const terms = { offerId: CHECKOUT_OFFER.id, confirmed: true };
test('missing secrets, non-sandbox mode and live keys fail before provider access', async () => {
  for (const overrides of [{ STOREFRONT_SESSION_SECRET: '' }, { STRIPE_TEST_SECRET_KEY: '' },
    { CHECKOUT_MODE: 'live' }, { STRIPE_TEST_SECRET_KEY: 'sk_live_' + 'f'.repeat(32) }]) {
    const c = client(overrides); assert.equal((await c.call()).status, 503); assert.equal(c.fixture.calls.length, 0);
  }
});
test('create is idempotent, sends fixed terms only, and delivery requires verified Stripe test payment', async () => {
  const c = client(), opened = await c.call();
  assert.equal(opened.value.realMoney, false); assert.equal(opened.value.offer.asset, undefined);
  assert.match(opened.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(c.fixture.calls.length, 0); assert.equal((await c.call('/download')).status, 409);
  const started = await c.call('/start', terms), again = await c.call('/start', terms);
  assert.deepEqual(started.value, again.value); assert.equal(started.value.order.status, 'pending');
  const creates = c.fixture.calls.filter(r => r.method === 'POST'); assert.equal(creates.length, 1);
  const form = new URLSearchParams(await creates[0].clone().text());
  assert.equal(form.get('line_items[0][price]'), CHECKOUT_OFFER.id); assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('success_url'), origin + '/agentic-commerce-os/?checkout=return#checkout');
  assert.equal(creates[0].headers.has('cookie'), false); assert.equal((await c.call('/download')).status, 409);
  c.fixture.complete(started.value.order.orderId);
  const receipt = await c.call('/receipt'); assert.equal(receipt.value.schema, 'commerce.stripe-test-receipt/v1');
  assert.equal(receipt.value.provider, 'stripe'); assert.equal(receipt.value.chargeMinor, 0); assert.equal(receipt.value.status, 'succeeded');
  assert.equal(JSON.stringify(receipt.value).includes('private@example'), false);
  assert.match((await c.call('/download')).value, /Sample educational/);
});
test('cancellation expires Stripe before reset and cannot expire a completed test payment', async () => {
  const c = client(); await c.call(); const order = (await c.call('/start', terms)).value.order;
  assert.equal((await c.call('/reset', terms)).status, 409);
  assert.equal((await c.call('/cancel', terms)).value.order.status, 'expired');
  assert.equal((await c.call('/download')).status, 409); assert.equal((await c.call('/reset', terms)).status, 200);
  await c.call(); const next = (await c.call('/start', terms)).value.order;
  assert.notEqual(order.orderId, next.orderId); c.fixture.complete(next.orderId);
  assert.equal((await c.call('/cancel', terms)).value.order.status, 'succeeded');
});
test('live-mode, foreign session, wrong amount and forged identity responses never unlock delivery', async () => {
  for (const mutate of [s => s.livemode = true, s => s.id = 'cs_live_' + 'a'.repeat(32), s => s.amount_total = 1,
    s => s.currency = 'usd', s => s.client_reference_id = 'forged', s => s.metadata.offer_id = 'foreign', s => s.mode = 'subscription']) {
    const c = client(); await c.call(); const order = (await c.call('/start', terms)).value.order;
    c.fixture.complete(order.orderId); mutate(c.fixture.sessions.get(order.orderId));
    assert.equal((await c.call('/download')).status, 503);
  }
});
test('cross-origin, missing consent, amount override and oversized input are refused', async () => {
  const c = client(); await c.call();
  for (const headers of [{ origin: 'https://evil.example' }, { 'x-commerce-csrf': 'forged' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await c.call('/start', terms, headers)).status, 403);
  }
  for (const body of [{ ...terms, confirmed: false }, { ...terms, amountMinor: 1 }, { ...terms, offerId: 'other' }, { ...terms, scenario: 'success' }]) {
    assert.equal((await c.call('/start', body)).status, 400);
  }
  assert.equal((await c.call('/start', terms, {}, 'x'.repeat(1025))).status, 413);
  assert.equal((await c.call('/status?paid=true')).status, 400); assert.equal(c.fixture.calls.length, 0);
});
test('tampered, duplicate and expired cookies cannot authorize a download', async t => {
  const c = client(); await c.call(); const order = (await c.call('/start', terms)).value.order; c.fixture.complete(order.orderId);
  const original = c.cookie;
  c.cookie = original.slice(0, -2) + 'xx'; assert.equal((await c.call('/download')).status, 401);
  c.cookie = original + '; ' + original; assert.equal((await c.call('/download')).status, 401);
  c.cookie = original; const now = Date.now(); t.mock.method(Date, 'now', () => now + 8 * 86400000);
  assert.equal((await c.call('/download')).status, 401);
});
test('an old unused intent cannot replay Stripe creation after its idempotency retention window', async t => {
  const c = client(); await c.call(); const now = Date.now(); t.mock.method(Date, 'now', () => now + 23 * 3600000);
  assert.equal((await c.call('/start', terms)).status, 409); assert.equal(c.fixture.calls.length, 0);
  assert.equal((await c.call('/reset', terms)).status, 200);
});
test('delivery is unavailable through static aliases and test fixture controls are not production routes', async () => {
  for (const path of ['/education-materials.md', '/assets/' + env.RELEASE_CANDIDATE_SHA + '/education-materials.md', '/__stripe-fixture/complete']) {
    assert.equal((await fetchLocalFirst(new Request(origin + '/agentic-commerce-os' + path), env)).status, 404);
  }
});
test('a wrong account or changed test price is refused before Stripe checkout creation', async () => {
  for (const suffix of ['/account', '/prices/' + CHECKOUT_OFFER.id]) {
    const fixture = stripeFixture(), original = fixture.transport;
    fixture.transport = async request => request.url.endsWith(suffix) ? Response.json({ id: 'foreign', livemode: false }) : original(request);
    const c = client({}, fixture); await c.call(); assert.equal((await c.call('/start', terms)).status, 503);
    assert.equal(fixture.calls.filter(request => request.method === 'POST').length, 0);
  }
});
test('uncertain create response can be resumed with the same Stripe idempotency key and no second session', async () => {
  const fixture = stripeFixture(), original = fixture.transport; let loseResponse = true;
  fixture.transport = async request => {
    const response = await original(request);
    if (request.method === 'POST' && loseResponse) { loseResponse = false; throw Error('response lost'); }
    return response;
  };
  const c = client({}, fixture); await c.call(); assert.equal((await c.call('/start', terms)).status, 503);
  assert.equal((await c.call('/start', terms)).status, 200); assert.equal(fixture.sessions.size, 1);
  const writes = fixture.calls.filter(request => request.method === 'POST'); assert.equal(writes.length, 2);
  assert.equal(writes[0].headers.get('idempotency-key'), writes[1].headers.get('idempotency-key'));
});
