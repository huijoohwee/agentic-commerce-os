import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';
import { readSession } from '../../src/local-first/session.ts';
import { fulfillmentContext } from '../../src/local-first/fulfillment.ts';
import { CHECKOUT_OFFER } from '../../src/local-first/checkout-offer.ts';
import { stripeFixture } from './stripe-fixture.ts';

const origin = 'https://airvio.co', base = origin + '/agentic-commerce-os';
const env = { RELEASE_CANDIDATE_SHA: 'a'.repeat(40), CHECKOUT_MODE: 'sandbox',
  STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32), STOREFRONT_SESSION_SECRET: 'sandbox-test-secret-longer-than-32-characters',
  ASSETS: { fetch: async () => new Response('# Education materials') } };
test('Commerce resumes an interrupted SQLite job in a new process and replays one combined receipt', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'commerce-durable-')), effectPath = join(directory, 'effects');
  const stripe = stripeFixture(); let cookie = '', token, child, sequence = 0;
  t.after(async () => { if (child?.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
    rmSync(directory, { recursive: true, force: true }); });
  const pending = new Map();
  function rpc(operation, input, context) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('fixture RPC timeout')); }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.send({ id, operation, input, context });
    });
  }
  const product = { invoke: rpc };
  async function call(path, body) {
    const response = await fetchLocalFirst(new Request(base + path, { method: body ? 'POST' : 'GET',
      headers: { cookie, ...(body ? { origin, 'content-type': 'application/json', 'x-commerce-csrf': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }), env, stripe.transport, product);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    if (value.csrfToken) token = value.csrfToken;
    return { status: response.status, value };
  }
  await call('/checkout');
  const session = await readSession(new Request(base, { headers: { cookie } }), env.STOREFRONT_SESSION_SECRET);
  const context = await fulfillmentContext(session);
  async function start(failOnce) {
    child = fork(new URL('./fulfillment-process.mjs', import.meta.url), [JSON.stringify({
      directory: join(directory, 'state'), effectPath, failOnce, context,
    })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture startup timeout: ' + stderr)), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code) reject(Error('fixture exit: ' + stderr)); });
      child.on('message', message => {
        if (message.ready) { clearTimeout(timer); resolve(); return; }
        const handler = pending.get(message.id); pending.delete(message.id);
        if (message.error) handler?.reject(Error(message.error)); else handler?.resolve(message.result);
      });
    });
  }
  await start(true);
  const draft = { draftId: crypto.randomUUID(), revision: 1, title: 'Ceramic mug', description: 'Blue, 300 ml.' };
  const admitted = await call('/fulfillment/start', draft); assert.equal(admitted.status, 202, JSON.stringify(admitted));
  const retry = await rpc('tick'); assert.equal(retry.runs[0].status, 'retryable');
  const killed = once(child, 'exit'); child.kill('SIGKILL'); await killed;
  await start(false);
  await delay(Math.max(0, retry.nextEligibleAt - Date.now()) + 30);
  await rpc('tick'); await rpc('tick');
  const result = await call('/fulfillment/status', { runId: admitted.value.runId });
  assert.equal(result.value.status, 'completed', JSON.stringify(result));
  assert.equal((await call('/fulfillment/start', draft)).value.status, 'completed');
  const body = { confirmed: true, offerId: CHECKOUT_OFFER.id, reviewed: true,
    fulfillment: { runId: result.value.runId, outputDigest: result.value.outputDigest } };
  const started = await call('/checkout/start', body); assert.equal(started.status, 200, JSON.stringify(started));
  assert.deepEqual((await call('/checkout/start', body)).value, started.value);
  stripe.complete(started.value.order.orderId);
  const receipt = await call('/checkout/receipt');
  assert.deepEqual((await call('/checkout/receipt')).value, receipt.value);
  assert.equal(receipt.value.fulfillment.runId, admitted.value.runId); assert.equal(receipt.value.realMoney, false);
  assert.match((await call('/checkout/download')).value, /Your reviewed listing/);
  assert.equal(stripe.sessions.size, 1); assert.equal(readFileSync(effectPath, 'utf8'), 'listing completed\n');
});
