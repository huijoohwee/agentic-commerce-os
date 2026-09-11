import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/local-first/worker.ts';
import { parseImport } from '../../public/local-first/drafts.js';

const revision = 'a'.repeat(40);
const request = (path, method = 'GET') => new Request(`https://airvio.co${path}`, { method });
test('local-first route never reaches an asset or provider for a server mutation', async () => {
  const env = { RELEASE_CANDIDATE_SHA: revision, ASSETS: { fetch() { throw Error('unexpected dispatch'); } } };
  for (const path of ['/v1/checkouts/confirm', '/mcp', '/mcp/operator', '/v1/session', '/v1/sync/merge']) {
    const response = await worker.fetch(request('/agentic-commerce-os' + path, 'POST'), env);
    assert.equal(response.status, 501); assert.equal((await response.json()).code, 'checkout_deferred');
  }
  assert.equal((await worker.fetch(request('/agentic-commerce-os-elsewhere/'), env)).status, 404);
  assert.equal((await worker.fetch(request('/agentic-graph/'), env)).status, 404);
});
test('readiness is scoped to local-first and binds a real release identity', async () => {
  const env = { RELEASE_CANDIDATE_SHA: revision, CF_VERSION_METADATA: { id: 'version-id' } };
  const response = await worker.fetch(request('/agentic-commerce-os/readyz'), env);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, profile: 'local-first', checkout: 'deferred', storage: 'browser-only', sourceRevision: revision, workerVersionId: 'version-id' });
  assert.equal((await worker.fetch(request('/agentic-commerce-os/readyz'), { ...env, RELEASE_CANDIDATE_SHA: 'local-unreleased' })).status, 503);
});
test('static serving strips credentials, restricts paths, and scopes the offline worker', async () => {
  const env = { RELEASE_CANDIDATE_SHA: revision, ASSETS: { async fetch(req) {
    assert.deepEqual([...req.headers], []);
    return new Response('const release="__RELEASE__";', { headers: { 'content-type': 'application/javascript', etag: 'asset-etag' } });
  } } };
  const input = new Request('https://airvio.co/agentic-commerce-os/sw.js?token=private', { headers: { cookie: 'secret=1', authorization: 'Bearer private' } });
  const response = await worker.fetch(input, env);
  assert.equal(response.headers.get('service-worker-allowed'), '/agentic-commerce-os/');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(await response.text(), `const release="${revision}";`);
  const head = await worker.fetch(request('/agentic-commerce-os/sw.js', 'HEAD'), env);
  assert.equal(await head.text(), '');
  assert.equal((await worker.fetch(request('/agentic-commerce-os/missing'), env)).status, 404);
  assert.equal((await worker.fetch(request('/agentic-commerce-os'), env)).headers.get('location'), 'https://airvio.co/agentic-commerce-os/');
});
test('import rejects malformed, duplicate, oversized and prototype-shaped records', () => {
  const draft = { id: '12345678-1234-1234-1234-123456789abc', title: 'Offer', description: '', price: '', revision: 1, createdAt: 1, updatedAt: 1 };
  const encode = drafts => JSON.stringify({ schema: 'commerce.local-drafts/v1', drafts });
  assert.equal(parseImport(encode([draft])).length, 1);
  for (const value of ['{}', encode([draft, draft]), encode([{ ...draft, revision: -1 }]), encode([{ ...draft, title: 'x'.repeat(121) }]),
    encode([{ ...draft, extra: true }]), 'x'.repeat(8000001)]) assert.throws(() => parseImport(value));
});

test('release-scoped browser modules bypass old caches and role entry links stay in scope', async () => {
  const seen = [];
  const env = { RELEASE_CANDIDATE_SHA: revision, ASSETS: { async fetch(req) {
    seen.push(new URL(req.url).pathname);
    return new Response('<link href="./assets/__RELEASE__/style.css"><script src="./assets/__RELEASE__/workspace.js"></script>');
  } } };
  const html = await (await worker.fetch(request('/agentic-commerce-os/'), env)).text();
  assert.equal(html.includes('__RELEASE__'), false);
  assert.equal(html.match(new RegExp(revision, 'g')).length, 2);
  assert.equal((await worker.fetch(request(`/agentic-commerce-os/assets/${revision}/workspace.js`), env)).status, 200);
  assert.equal(seen.at(-1), '/workspace.js');
  const count = seen.length;
  assert.equal((await worker.fetch(request(`/agentic-commerce-os/assets/${'b'.repeat(40)}/workspace.js`), env)).status, 404);
  assert.equal(seen.length, count);
  for (const role of ['vendor', 'admin']) {
    const response = await worker.fetch(request('/agentic-commerce-os/' + role), env);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://airvio.co/agentic-commerce-os/#' + role);
  }
});
