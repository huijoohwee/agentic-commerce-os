import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import worker from '../../src/local-first/worker.ts';
import { verifyGraphBundle } from '../../scripts/workspace-pack/build-graph.mjs';
import { authoredAssets } from '../../scripts/local-first-release/availability.mjs';

const base = 'https://airvio.co/agentic-commerce-os/services/workspace-pack';
const revision = 'a'.repeat(40), source = 'total = 0\nfor value in range(1, 4):\n    total = total + value\nprint(total)\n';
const sha = text => createHash('sha256').update(text).digest('hex');
const input = { title: 'A small program', source, sourceDigest: sha(source) };
const env = { RELEASE_CANDIDATE_SHA: revision, ASSETS: { fetch: async request => {
  assert.deepEqual([...request.headers], []); return new Response(new URL(request.url).pathname);
} } };
const post = (body, route = '/api', headers = {}) => new Request(base + route, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function verifyPack(pack) {
  assert.equal(pack.sourceDigest, input.sourceDigest); assert.equal(pack.execution, 'not-executed');
  assert.equal(pack.roundTrip, 'exact'); assert.equal(pack.files[0].content, source);
  assert.deepEqual(pack.files.map(file => file.name), ['program.py', 'program.json', 'program.md', 'canvas.md']);
  for (const file of pack.files) { assert.equal(file.bytes, Buffer.byteLength(file.content)); assert.equal(file.digest, sha(file.content)); }
  const { artifactDigest, ...unsigned } = pack; assert.equal(artifactDigest, sha(JSON.stringify(unsigned)));
}
test('public profile binds the pinned Graph artifact, exact assets and source without dispatching providers', async () => {
  const pin = verifyGraphBundle();
  const response = await worker.fetch(new Request(base + '/service.json'), env), descriptor = await response.json();
  assert.equal(response.status, 200); assert.equal(descriptor.adapterDigest, pin.artifact.sha256);
  assert.equal(descriptor.graphRevision, pin.revision); assert.equal(descriptor.sourceRevision, revision);
  assert.equal(descriptor.marketplaceListed, false); assert.equal(descriptor.price.amount, '0');
  assert.equal(response.headers.get('x-commerce-source'), revision);
  assert.equal((await worker.fetch(new Request(base), env)).headers.get('location'), base + '/');
  for (const [route, asset] of [['/', '/workspace-pack.html'], ['/workspace-pack.js', '/workspace-pack.js'], ['/workspace-pack.css', '/workspace-pack.css'], ['/workspace-pack.simulation.js', '/workspace-pack.simulation.js']]) {
    const result = await worker.fetch(new Request(base + route, { headers: { cookie: 'not-forwarded=1' } }), env);
    assert.equal(await result.text(), asset); assert.equal(result.headers.get('cache-control'), 'no-store, no-transform');
  }
  assert.deepEqual(authoredAssets(revision).filter(asset => asset.path.startsWith('services/')).map(asset => asset.path).sort(),
    ['services/workspace-pack/', 'services/workspace-pack/workspace-pack.css', 'services/workspace-pack/workspace-pack.js', 'services/workspace-pack/workspace-pack.simulation.js']);
});
test('edge REST produces exact four-file output and refuses malformed, stale, executable and oversized input', async () => {
  const result = await worker.fetch(post(input), env); assert.equal(result.status, 200); verifyPack(await result.json());
  for (const body of [{ ...input, sourceDigest: '0'.repeat(64) }, { ...input, path: '/private' },
    { ...input, title: '<script>' }, { ...input, source: 'import os\n', sourceDigest: sha('import os\n') },
    { ...input, source: 'x'.repeat(32769), sourceDigest: sha('x'.repeat(32769)) }]) {
    assert.equal((await worker.fetch(post(body), env)).status, 422);
  }
  assert.equal((await worker.fetch(post({ ...input, source: 'x'.repeat(100000) }), env)).status, 413);
  assert.equal((await worker.fetch(post(input, '/api', { 'content-type': 'text/plain' }), env)).status, 415);
  for (const headers of [{ origin: 'https://untrusted.invalid' }, { cookie: 'session=private' }, { authorization: 'Bearer refused' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await worker.fetch(post(input, '/api', headers), env)).status, 403);
  }
  assert.equal((await worker.fetch(post(input, '/api?unexpected=1'), env)).status, 400);
  assert.equal((await worker.fetch(new Request(base + '/api'), env)).status, 405);
  assert.equal((await worker.fetch(post(input, '/../other'), env)).status, 501);
});
test('a cancelled edge body is interrupted before conversion', async () => {
  const abort = new AbortController(); let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = worker.fetch(new Request(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json' },
    body, signal: abort.signal, duplex: 'half' }), env);
  abort.abort(); assert.equal((await pending).status, 504); assert.equal(cancelled, true);
});
test('actual workerd supports SDK initialize, list and call with REST-equivalent output', { timeout: 20000 }, async t => {
  const require = createRequire(import.meta.url), toolRequire = createRequire(require.resolve('wrangler/package.json'));
  const { build } = toolRequire('esbuild'), { Miniflare, convertV4MiniflareOptions } = toolRequire('miniflare');
  const built = await build({ entryPoints: ['src/local-first/worker.ts'], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', minify: true, write: false });
  assert(built.outputFiles[0].contents.length < 500000);
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-08-26', bindings: { RELEASE_CANDIDATE_SHA: revision },
    serviceBindings: { ASSETS: () => new Response('unused') } }));
  t.after(() => runtime.dispose());
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'workspace-pack-edge-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      return runtime.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.text() }) });
    },
  });
  t.after(() => client.close()); await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 1);
  assert.equal(tools.tools[0].name, 'commerce.workspace.program-pack.create');
  const result = await client.callTool({ name: tools.tools[0].name, arguments: input });
  assert.notEqual(result.isError, true); const pack = JSON.parse(result.content[0].text); verifyPack(pack);
  const rest = await runtime.dispatchFetch(base + '/api', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); assert.equal(rest.status, 200);
  assert.deepEqual(await rest.json(), pack);
  const refused = await client.callTool({ name: tools.tools[0].name, arguments: { ...input, sourceDigest: '0'.repeat(64) } });
  assert.equal(refused.isError, true);
});
