import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';

async function policyFor(source, path = '/') {
  const response = await fetchLocalFirst(new Request(`https://airvio.co/agentic-commerce-os${path}`), {
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
  return response.headers.get('content-security-policy');
}

test('local annotation styles are allowed only for unreleased Dev', async () => {
  const local = await policyFor('local-unreleased');
  assert.match(local, /style-src 'self'/);
  assert.match(local, /style-src-elem 'self' 'unsafe-inline'/);

  const localAsset = await policyFor('local-unreleased', '/assets/local-unreleased/style.css');
  assert.doesNotMatch(localAsset, /unsafe-inline|style-src-elem/);

  const released = await policyFor('a'.repeat(40));
  assert.match(released, /style-src 'self'/);
  assert.doesNotMatch(released, /unsafe-inline|style-src-elem/);
});
