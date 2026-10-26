import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../src/design-system-edge/index.mjs';

const env = Object.freeze({
  PAGES_ORIGIN: 'dev.agentic-design-system.pages.dev',
  DESIGN_SYSTEM_SOURCE_REVISION: 'd'.repeat(40),
  RELEASE_CANDIDATE_SHA: 'a'.repeat(40),
  RELEASE_CANDIDATE_DIGEST: 'b'.repeat(64),
});

async function call(url, init, upstream) {
  const prior = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    return await worker.fetch(new Request(url, init), env);
  } finally {
    globalThis.fetch = prior;
  }
}

test('slashless prefix redirects permanently and keeps the query', async () => {
  const response = await call('https://airvio.co/agentic-design-system?view=compact', {},
    async () => assert.fail('redirect must not call the origin'));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://airvio.co/agentic-design-system/?view=compact');
});

test('GET maps only the path below the prefix and forwards only safe read headers', async () => {
  let received;
  const response = await call('https://airvio.co/agentic-design-system/vendor/table.js?mode=mobile', {
    headers: {
      accept: 'text/javascript',
      cookie: 'private=1',
      authorization: 'Bearer private',
      'if-none-match': '"asset"',
    },
  }, async (input, init) => {
    received = { url: String(input), init };
    return new Response('asset', { headers: { 'content-type': 'text/javascript', etag: '"asset"' } });
  });
  assert.equal(received.url, 'https://dev.agentic-design-system.pages.dev/vendor/table.js?mode=mobile');
  assert.equal(received.init.method, 'GET');
  assert.equal(received.init.redirect, 'manual');
  assert.equal(received.init.headers.get('accept'), 'text/javascript');
  assert.equal(received.init.headers.get('if-none-match'), '"asset"');
  assert.equal(received.init.headers.has('cookie'), false);
  assert.equal(received.init.headers.has('authorization'), false);
  assert.equal(received.init.headers.get('accept-encoding'), 'identity');
  assert.equal(await response.text(), 'asset');
  assert.equal(response.headers.get('x-design-system-release'), env.RELEASE_CANDIDATE_SHA);
  assert.equal(response.headers.get('x-design-system-payload'), env.RELEASE_CANDIDATE_DIGEST);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('GET buffers the decoded upstream representation and strips stale encoding metadata', async () => {
  const decoded = new TextEncoder().encode('decoded asset');
  const response = await call('https://airvio.co/agentic-design-system/app.js', {}, async () => ({
    status: 200,
    headers: new Headers({
      'content-encoding': 'gzip',
      'content-length': 'encoded-length',
      'content-type': 'text/javascript',
    }),
    async arrayBuffer() {
      return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
    },
  }));
  assert.equal(await response.text(), 'decoded asset');
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
});

test('HTML responses prevent zone-level body transforms while preserving cache policy', async () => {
  const response = await call('https://airvio.co/agentic-design-system/', {}, async () =>
    new Response('<!doctype html><html></html>', {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'content-type': 'text/html; charset=utf-8',
      },
    }));
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate, no-transform');
});

test('non-HTML cache policy remains unchanged', async () => {
  const response = await call('https://airvio.co/agentic-design-system/app.js', {}, async () =>
    new Response('export {}', {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'content-type': 'text/javascript',
      },
    }));
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
});

test('HEAD retains status and headers without a body', async () => {
  const response = await call('https://airvio.co/agentic-design-system/', { method: 'HEAD' },
    async (_input, init) => {
      assert.equal(init.method, 'HEAD');
      return new Response(null, { status: 200, headers: { 'content-length': '4', 'content-type': 'text/html' } });
    });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(await response.text(), '');
});

test('unrelated paths and writes fail closed without an origin request', async () => {
  const never = async () => assert.fail('request must not call the origin');
  assert.equal((await call('https://airvio.co/agentic-design-system-old/', {}, never)).status, 404);
  const response = await call('https://airvio.co/agentic-design-system/catalog.json', { method: 'POST' }, never);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('invalid origin, redirecting origin, and failed origin are rejected', async () => {
  assert.equal((await worker.fetch(new Request('https://airvio.co/agentic-design-system/'), {
    ...env,
    PAGES_ORIGIN: 'evil.example',
  })).status, 503);
  assert.equal((await call('https://airvio.co/agentic-design-system/', {}, async () =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))).status, 502);
  assert.equal((await call('https://airvio.co/agentic-design-system/', {}, async () => {
    throw new Error('offline');
  })).status, 502);
});
