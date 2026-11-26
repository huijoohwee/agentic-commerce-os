import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';

async function policyFor(source, path = '/', host = 'airvio.co') {
  const response = await fetchLocalFirst(new Request(`https://${host}/agentic-commerce-os${path}`), {
    RELEASE_CANDIDATE_SHA: source,
    CHECKOUT_MODE: 'sandbox',
    ASSETS: { fetch: async request => {
      const stylesheet = new URL(request.url).pathname.endsWith('/style.css');
      return new Response(stylesheet ? 'body { color: black }' : '<!doctype html><html></html>', {
        headers: { 'content-type': stylesheet ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' },
      });
    } } },
  );
  assert.equal(response.status, 200);
  return {
    enforce: response.headers.get('content-security-policy'),
    reportOnly: response.headers.get('content-security-policy-report-only'),
  };
}

test('annotation styles use report-only CSP on local Dev HTML and enforcement on released HTML', async () => {
  const local = await policyFor('local-unreleased');
  assert.equal(local.enforce, null);
  assert.match(local.reportOnly, /style-src 'self'/);
  assert.match(local.reportOnly, /style-src-elem 'self' 'unsafe-inline'/);

  const localHost = await policyFor('a'.repeat(40), '/', 'localhost');
  assert.equal(localHost.enforce, null);
  assert.match(localHost.reportOnly, /style-src-elem 'self' 'unsafe-inline'/);

  const localAsset = await policyFor('local-unreleased', '/assets/local-unreleased/style.css');
  assert.doesNotMatch(localAsset.enforce ?? localAsset.reportOnly, /unsafe-inline|style-src-elem/);

  const released = await policyFor('a'.repeat(40));
  assert.match(released.enforce, /style-src 'self'/);
  assert.equal(released.reportOnly, null);
  assert.doesNotMatch(released.enforce, /unsafe-inline|style-src-elem/);
});
