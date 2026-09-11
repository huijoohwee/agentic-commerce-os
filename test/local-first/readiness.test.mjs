import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReadiness } from '../../scripts/local-first-release/readiness.mjs';
const revision = 'a'.repeat(40), versionId = 'candidate-version';
const current = { ok: true, profile: 'local-first', checkout: 'sandbox', storage: 'browser-only', realMoney: false, paymentStorage: 'stripe-test', paymentProvider: 'stripe', sourceRevision: revision, workerVersionId: versionId };
const response = (body = current, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', 'cf-ray': 'test-ray' } });
function probe(sequence, overrides = {}) {
  let clock = 0, calls = 0;
  const observations = [];
  return { observations, calls: () => calls, elapsed: () => clock,
    run: () => waitForReadiness({ url: 'https://airvio.co/agentic-commerce-os/readyz', revision, versionId,
      now: () => clock, sleep: async delay => { clock += delay; }, timeoutMs: 6000, intervalMs: 2000,
      observe: value => observations.push(value), fetchImpl: async (url, options) => {
        assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
        const next = sequence[Math.min(calls++, sequence.length - 1)];
        if (next instanceof Error) throw next;
        return next();
      }, ...overrides }) };
}
test('new route converges from HTML 404 and 503 through a stale version to exact readiness', async () => {
  const value = probe([() => response('<!DOCTYPE html>Not found', 404), () => response('unavailable', 503),
    () => response({ ...current, sourceRevision: 'b'.repeat(40), workerVersionId: 'previous' }), () => response()]);
  assert.deepEqual(await value.run(), current); assert.equal(value.calls(), 4);
  assert.deepEqual(value.observations.map(item => item.status), [404, 503, 200, 200]);
  assert.equal(value.observations[0].contentType, 'text/html');
  assert.match(value.observations[0].bodyDigest, /^[a-f0-9]{64}$/);
  assert.equal(value.observations[2].error, 'readiness_identity_not_converged');
  assert.equal(value.observations[3].matched, true);
});
test('authorization failures and redirects fail immediately without polling', async () => {
  for (const status of [401, 403, 302]) {
    const value = probe([() => response('blocked', status), () => response()]);
    await assert.rejects(value.run(), new RegExp('readiness_terminal_http_' + status));
    assert.equal(value.calls(), 1); assert.equal(value.observations[0].status, status);
  }
});
test('successful HTML and wrong profile are terminal contract failures', async () => {
  for (const [body, expected] of [['<!DOCTYPE html>Wrong route', 'invalid_json'], [{ ...current, checkout: 'enabled' }, 'invalid_profile']]) {
    const value = probe([() => response(body), () => response()]);
    await assert.rejects(value.run(), new RegExp(expected)); assert.equal(value.calls(), 1);
  }
});
test('matching source with a different active version never becomes readiness', async () => {
  const value = probe([() => response({ ...current, workerVersionId: 'foreign-version' })]);
  await assert.rejects(value.run(), /readiness_convergence_deadline/);
  assert.equal(value.elapsed(), 6000); assert.equal(value.calls(), 4);
  assert(value.observations.every(item => item.workerVersionId === 'foreign-version' && item.matched !== true));
});
test('transport failure is bounded and retains all failed observations', async () => {
  const value = probe([new Error('connection refused')]);
  await assert.rejects(value.run(), /readiness_convergence_deadline/);
  assert.equal(value.calls(), 4); assert.equal(value.elapsed(), 6000);
  assert(value.observations.every(item => item.error === 'connection refused'));
});
test('unavailable response bodies are bounded while readiness can still converge', async () => {
  const value = probe([() => response('x'.repeat(50000), 404), () => response()]);
  await value.run(); assert.equal(value.observations[0].bodyTruncated, true);
  assert.equal(value.observations[1].matched, true);
});
test('local workerd may omit production version while keeping exact source and profile', async () => {
  const value = probe([() => response({ ...current, workerVersionId: null })], { versionId: undefined });
  assert.equal((await value.run()).sourceRevision, revision);
});

test('a deferred predecessor may converge, but the candidate cannot claim the old checkout profile', async () => {
  const predecessor = { ...current, sourceRevision: 'b'.repeat(40), checkout: 'deferred' };
  assert.equal((await probe([() => response(predecessor), () => response()]).run()).checkout, 'sandbox');
  await assert.rejects(probe([() => response({ ...current, checkout: 'deferred' })]).run(), /invalid_profile/);
  await assert.rejects(probe([() => response({ ...current, ok: false })]).run(), /invalid_profile/);
});
