import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../scripts/local-first-release/artifact.mjs';
import { waitForAssets } from '../../scripts/local-first-release/availability.mjs';
const revision = 'a'.repeat(40);
const assets = ['app.js', 'drafts.js'].map(path => ({ path, bytes: path.length, digest: digest(path), contentType: /javascript/ }));
function response(body, status = 200, source = revision) {
  return new Response(body, { status, headers: { 'content-type': 'application/javascript',
    'cache-control': 'no-store, no-transform', 'x-commerce-source': source } });
}
function fixture(handler, overrides = {}) {
  let clock = 0, calls = 0;
  const observations = [];
  return { observations, calls: () => calls, elapsed: () => clock,
    run: () => waitForAssets({ baseUrl: 'https://airvio.co/agentic-commerce-os/', revision, assets,
      timeoutMs: 6000, stableMs: 2000, intervalMs: 1000, now: () => clock,
      sleep: async delay => { clock += delay; }, observe: value => observations.push(value),
      fetchImpl: async (url, options) => {
        calls++; assert.equal(options.headers.connection, 'close'); assert.equal(options.redirect, 'manual');
        return handler(url.pathname.split('/').at(-1), clock);
      }, ...overrides }) };
}
test('one missing module resets the complete-asset stability window', async () => {
  const value = fixture((path, clock) => path === 'drafts.js' && clock === 2000
    ? response('Not found', 404) : response(path));
  const final = await value.run();
  assert.equal(value.elapsed(), 5000); assert.equal(final.stableForMs, 2000);
  assert.equal(value.calls(), 12);
  assert.equal(value.observations[2].assets.find(asset => asset.path === 'drafts.js').status, 404);
});
test('correct source header with corrupt module bytes is immediately terminal', async () => {
  const value = fixture(path => response(path === 'drafts.js' ? 'corrupt' : path));
  await assert.rejects(value.run(), /asset_integrity_mismatch:drafts.js/);
  assert.equal(value.elapsed(), 0); assert.equal(value.observations.length, 1);
});
test('authorization failure cannot become a retryable asset miss', async () => {
  const value = fixture(path => response(path, 403));
  await assert.rejects(value.run(), /asset_terminal_http_403/); assert.equal(value.observations.length, 1);
});
test('persistent stale source or missing asset stops at the shared deadline', async () => {
  for (const stale of [false, true]) {
    const value = fixture(path => response(path, stale ? 200 : 404, stale ? 'b'.repeat(40) : revision));
    await assert.rejects(value.run(), /asset_convergence_deadline/);
    assert.equal(value.elapsed(), 6000); assert.equal(value.observations.length, 7);
  }
});
test('oversized public responses fail before a browser is admitted', async () => {
  const value = fixture(path => response(path === 'drafts.js' ? 'x'.repeat(500000) : path));
  await assert.rejects(value.run(), /asset_body_over_budget:drafts.js/);
});
test('a bounded transport failure can recover only after every asset is stable', async () => {
  const value = fixture((path, clock) => { if (clock === 0) throw Error('connection reset'); return response(path); });
  const result = await value.run();
  assert.equal(value.elapsed(), 3000); assert.equal(result.stableForMs, 2000);
  assert(value.observations[0].assets.every(asset => asset.error === 'connection reset'));
});
