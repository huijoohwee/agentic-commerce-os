import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReadiness, waitForBrowserDocument } from '../../scripts/local-first-release/readiness.mjs';
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

const documentUrl = 'https://airvio.co/agentic-commerce-os/';
const documentResponse = (sourceRevision = revision, overrides = {}) => ({
  status: () => 200, url: () => documentUrl, request: () => ({ redirectedFrom: () => null }),
  headers: () => ({ 'content-type': 'text/html; charset=utf-8', 'x-commerce-profile': 'local-first',
    'x-commerce-source': sourceRevision, 'cf-ray': 'browser-ray' }), ...overrides,
});
function documentProbe(sequence) {
  let clock = 0, calls = 0; const observations = [];
  return { observations, calls: () => calls, elapsed: () => clock,
    run: () => waitForBrowserDocument({ url: documentUrl + '#vendor-editor', revision, previousRevision: 'b'.repeat(40),
      now: () => clock, sleep: async value => { clock += value; }, timeoutMs: 6000, intervalMs: 2000,
      observe: value => observations.push(value), navigate: async (url, { timeout }) => {
        assert.equal(url, documentUrl + '#vendor-editor'); assert(timeout > 0 && timeout <= 8000);
        const next = sequence[Math.min(calls++, sequence.length - 1)];
        if (next instanceof Error) throw next;
        return next();
      } }) };
}
test('browser document waits for its own source after readiness has already converged', async () => {
  const expected = documentResponse();
  const value = documentProbe([() => documentResponse('b'.repeat(40)), () => documentResponse('b'.repeat(40)), () => expected]);
  assert.equal(await value.run(), expected); assert.equal(value.calls(), 3); assert.equal(value.elapsed(), 4000);
  assert.deepEqual(value.observations.map(item => item.matched === true), [false, false, true]);
  assert(value.observations.slice(0, 2).every(item => item.error === 'browser_document_identity_not_converged'));
});
test('browser document transport and temporary unavailability remain bounded reads', async () => {
  const value = documentProbe([new Error('navigation unavailable'), () => documentResponse(revision, { status: () => 503 }), () => documentResponse()]);
  await value.run(); assert.equal(value.calls(), 3); assert.equal(value.observations[0].error, 'navigation unavailable');
  assert.equal(value.observations[1].status, 503); assert.equal(value.observations[2].matched, true);
});
test('browser document rejects foreign sources, redirects and authorization failures immediately', async () => {
  for (const [response, error] of [
    [documentResponse('c'.repeat(40)), 'unexpected_source'],
    [documentResponse(revision, { url: () => 'https://other.example/' }), 'redirect'],
    [documentResponse(revision, { request: () => ({ redirectedFrom: () => ({}) }) }), 'redirect'],
    [documentResponse(revision, { status: () => 401 }), 'terminal_http_401'],
    [documentResponse(revision, { status: () => 403 }), 'terminal_http_403'],
    [documentResponse(revision, { headers: () => ({ 'content-type': 'application/json' }) }), 'invalid_profile'],
  ]) {
    const value = documentProbe([() => response, () => documentResponse()]);
    await assert.rejects(value.run(), new RegExp(error)); assert.equal(value.calls(), 1);
  }
});
test('browser document never accepts a predecessor after its convergence deadline', async () => {
  const value = documentProbe([() => documentResponse('b'.repeat(40))]);
  await assert.rejects(value.run(), /browser_document_convergence_deadline/);
  assert.equal(value.calls(), 4); assert.equal(value.elapsed(), 6000);
  assert(value.observations.every(item => item.matched !== true));
});
test('browser document refuses an invalid identity or unbounded polling budget before navigation', async () => {
  for (const overrides of [{ revision: 'main' }, { previousRevision: 'unknown' }, { timeoutMs: 45001 }, { intervalMs: 0 }]) {
    await assert.rejects(waitForBrowserDocument({ url: documentUrl, revision, ...overrides,
      navigate: () => assert.fail('Invalid input must not navigate') }), /browser_document_invalid_input/);
  }
});
