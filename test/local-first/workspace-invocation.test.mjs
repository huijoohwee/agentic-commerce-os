import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import worker from '../../src/local-first/worker.ts';
import { WORKSPACE_TOOLS, invokeWorkspace, workspaceSnapshot, parseWorkspaceInvocation } from '../../public/local-first/workspace-capabilities.js';
import { evaluateLaunch } from '../../public/local-first/launch.js';
const base = 'https://airvio.co/agentic-commerce-os/services/workspace';
const revision = 'a'.repeat(40), env = { RELEASE_CANDIDATE_SHA: revision, ASSETS: { fetch: () => new Response('unused') } };
const draft = { id: '12345678-1234-1234-1234-123456789012', title: 'A useful offer', revision: 2, createdAt: 1, updatedAt: 2,
  description: 'PRIVATE notes', price: 'PRIVATE price notes', launch: { merchantId: 'studio', agentId: 'discovery', currency: 'USD',
    audience: 'Independent founders', outcome: 'A practical worksheet', priceMinor: 1000, deliveryCostMinor: 100,
    providerFeeMinor: 0, agentCostMinor: 10, acquisitionCostMinor: 0, fixedCostMinor: 100 } };
const snapshot = workspaceSnapshot([draft]);
const post = (body, route = '/api', headers = {}) => new Request(base + route, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const list = WORKSPACE_TOOLS[0].name, project = WORKSPACE_TOOLS[1].name, review = WORKSPACE_TOOLS[2].name, environment = WORKSPACE_TOOLS[3].name;
test('browser and explicit snapshot results reuse native grouping and exact-revision economics', async () => {
  assert(!JSON.stringify(snapshot).includes('PRIVATE'));
  const local = await invokeWorkspace(list, {}, { snapshot: () => snapshot });
  const supplied = await invokeWorkspace(list, { snapshot });
  assert.deepEqual(local.value, supplied.value); assert.equal(local.provenance, 'browser-local'); assert.equal(supplied.provenance, 'provided-snapshot');
  assert.equal(local.value.projects[0].id, 'store:studio');
  const result = await invokeWorkspace(review, { snapshot, offerId: draft.id, expectedRevision: 2 });
  assert.deepEqual(result.value.economics, evaluateLaunch(draft.launch)); assert.equal(result.value.humanReview, 'still-required');
  assert.equal((await invokeWorkspace(project, { snapshot, projectId: 'store:studio' })).value.offers[0].revision, 2);
  assert.equal((await invokeWorkspace(list, { snapshot, query: 'absent' })).value.projects.length, 0);
  assert.equal((await invokeWorkspace(list, { snapshot: workspaceSnapshot([]) })).value.projects[0].id, 'local:unassigned');
  await assert.rejects(invokeWorkspace(review, { snapshot, offerId: draft.id, expectedRevision: 1 }), /revision_changed/);
  await assert.rejects(invokeWorkspace(list, {}), /snapshot_required/);
});
test('strict snapshots and inputs reject private fields, duplicates, unsafe numbers and cancellation', async () => {
  for (const invalid of [{ ...snapshot, private: true }, { ...snapshot, offers: [{ ...snapshot.offers[0], description: 'private' }] },
    { ...snapshot, offers: [...snapshot.offers, ...snapshot.offers] }, { ...snapshot, offers: [{ ...snapshot.offers[0], revision: 1.5 }] },
    { ...snapshot, offers: [{ ...snapshot.offers[0], launch: { ...draft.launch, priceMinor: -1 } }] }, { ...snapshot, offers: Array(101).fill(snapshot.offers[0]) }]) {
    await assert.rejects(invokeWorkspace(list, { snapshot: invalid }), /workspace_/);
  }
  for (const args of [{ snapshot, query: 4 }, { snapshot, query: 'x'.repeat(121) }, { snapshot, publish: true }]) await assert.rejects(invokeWorkspace(list, args), /workspace_/);
  await assert.rejects(invokeWorkspace('commerce.theme.deploy', {}), /tool_unknown/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(invokeWorkspace(list, { snapshot }, { signal: controller.signal }), /cancelled/);
  const stalled = new AbortController();
  const pending = invokeWorkspace(list, {}, { snapshot: () => new Promise(() => {}), signal: stalled.signal });
  stalled.abort(); await assert.rejects(pending, /cancelled/);
});
test('REST, invocation grammar and environment use one read-only contract with no registry admission claim', async () => {
  const descriptor = await (await worker.fetch(new Request(base + '/service.json'), env)).json();
  assert.equal(descriptor.registryAdmission, 'not-claimed'); assert.equal(descriptor.sourceRevision, revision);
  assert.deepEqual(descriptor.tools, WORKSPACE_TOOLS);
  const routing = descriptor.routing, invocation = `${routing.commandToken} ${routing.bindingToken} ${routing.semanticToken} ${list}`;
  assert.equal(parseWorkspaceInvocation(invocation, routing), list);
  const rest = await worker.fetch(post({ name: list, arguments: { snapshot } }), env);
  assert.equal(rest.status, 200); const result = await rest.json();
  const routed = await worker.fetch(post({ invocation, arguments: { snapshot } }, '/invoke'), env);
  assert.deepEqual(await routed.json(), result);
  for (const expression of [invocation + ' extra', invocation.replace('@mcp-gateway', '@other'), invocation.replace('#mcp', '#write'), '/project.list']) {
    assert.equal((await worker.fetch(post({ invocation: expression, arguments: { snapshot } }, '/invoke'), env)).status, 422);
  }
  const observation = await (await worker.fetch(post({ name: environment, arguments: {} }), env)).json();
  const readiness = await (await worker.fetch(new Request('https://airvio.co/agentic-commerce-os/readyz'), env)).json();
  assert.deepEqual(observation.value, readiness); assert.equal(observation.provenance, 'runtime-observation');
  for (const headers of [{ origin: 'https://elsewhere.invalid' }, { cookie: 'private=1' }, { authorization: 'Bearer none' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await worker.fetch(post({ name: list, arguments: { snapshot } }, '/api', headers), env)).status, 403);
  }
  assert.equal((await worker.fetch(post({ name: list, arguments: { snapshot }, extra: true }), env)).status, 422);
  assert.equal((await worker.fetch(post({ excess: 'x'.repeat(200000) }), env)).status, 413);
  assert.equal((await worker.fetch(post({}, '/api?query=x'), env)).status, 400);
  assert.equal((await worker.fetch(post({}, '/api', { 'content-type': 'text/plain' }), env)).status, 415);
});
test('cancelled input stream is interrupted and never retained', async () => {
  let cancelled = false; const controller = new AbortController();
  const request = new Request(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ cancel() { cancelled = true; } }), signal: controller.signal, duplex: 'half' });
  const pending = worker.fetch(request, env); controller.abort();
  assert.equal((await pending).status, 504); assert.equal(cancelled, true);
});
test('actual workerd MCP client initializes, discovers four tools and matches REST for every capability', { timeout: 20000 }, async t => {
  const require = createRequire(import.meta.url), toolRequire = createRequire(require.resolve('wrangler/package.json'));
  const { build } = toolRequire('esbuild'), { Miniflare, convertV4MiniflareOptions } = toolRequire('miniflare');
  const built = await build({ entryPoints: ['src/local-first/worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false });
  assert(built.outputFiles[0].contents.length < 500000);
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-08-26', bindings: { RELEASE_CANDIDATE_SHA: revision }, serviceBindings: { ASSETS: () => new Response('unused') } }));
  t.after(() => runtime.dispose());
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'workspace-invocation-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { fetch: async (url, init) => {
    const request = new Request(url, init);
    return runtime.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.text() }) });
  } }));
  assert.deepEqual((await client.listTools()).tools, WORKSPACE_TOOLS);
  for (const [name, args] of [[list, { snapshot }], [project, { snapshot, projectId: 'store:studio' }],
    [review, { snapshot, offerId: draft.id, expectedRevision: 2 }], [environment, {}]]) {
    const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true);
    const rest = await runtime.dispatchFetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    assert.deepEqual(JSON.parse(result.content[0].text), await rest.json());
  }
  assert.equal((await client.callTool({ name: list, arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: review, arguments: { snapshot, offerId: draft.id, expectedRevision: 1 } })).isError, true);
});
