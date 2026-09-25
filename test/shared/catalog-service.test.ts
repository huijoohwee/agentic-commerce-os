import { request as httpRequest, type ClientRequest } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { canonicalJson, sha256Hex } from '../../src/shared/digest'
import { isRecord } from '../../src/shared/http'
import { CATALOG_MAX_AGE_MS, createPublicCatalogArtifact, readPublicCatalogArtifact } from '../../src/core/public-catalog'
import { CATALOG_SERVICE_TOOL, handleCatalogMcpRequest } from '../../src/edge/mcp'
import { startCatalogService } from '../../src/local-host/catalog-service'

const sourceRevision = 'a'.repeat(40)
const entry = (id: string, registrationState = 'active') => ({
  agentId: id, category: 'shopping', registrationState,
  admissionInputs: { toolAllowlistEntry: { tool_names: ['lookup', 'lookup', 'compare'] }, secret: 'private-input' },
  admissionReceipt: { secret: 'private-receipt' }, providerUrl: 'https://private.invalid',
})
async function snapshot(agents: unknown[] = [entry('z'), entry('a'), entry('hidden', 'inactive')]) {
  const value = { revision: 3, agents }
  return { ...value, digest: await sha256Hex(canonicalJson(value)) }
}
async function artifact() { return createPublicCatalogArtifact(await snapshot(), sourceRevision) }
const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const call = () => rpc('tools/call', { name: CATALOG_SERVICE_TOOL, arguments: {} })
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18' }
async function invoke(body: unknown, raw: unknown, extra: Record<string, string> = {}) {
  return handleCatalogMcpRequest(new Request('http://127.0.0.1:5192/agentic-commerce-os/services/mcp', {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  }), async () => raw, 'test-request')
}

describe('public catalog artifact', () => {
  it('uses the native active-only projection, canonical sorting and separate input/output digests', async () => {
    const raw = await snapshot(), result = await createPublicCatalogArtifact(raw, sourceRevision)
    expect(result.catalog.agents.map(row => row.agentId)).toEqual(['a', 'z'])
    expect(result.catalog.agents[0]).toEqual({ agentId: 'a', declaredCategory: 'shopping',
      declaredCapabilities: ['compare', 'lookup'], trustStatus: 'declared-and-present' })
    expect(result.catalog.digest).toBe(raw.digest)
    expect(result.artifactDigest).not.toBe(raw.digest)
    expect(JSON.stringify(result)).not.toMatch(/private|providerUrl|admissionInputs|admissionReceipt/)
    expect(Object.isFrozen(result.catalog.agents[0]?.declaredCapabilities)).toBe(true)
  })
  it('rejects malformed snapshots, changed source bytes and duplicate agent identities', async () => {
    const raw = await snapshot()
    await expect(createPublicCatalogArtifact({ ...raw, revision: 4 }, sourceRevision)).rejects.toThrow('digest_mismatch')
    await expect(createPublicCatalogArtifact(await snapshot([entry('same'), entry('same')]), sourceRevision)).rejects.toThrow('snapshot_invalid')
    await expect(createPublicCatalogArtifact(await snapshot([entry('x', 'unknown')]), sourceRevision)).rejects.toThrow('snapshot_invalid')
    await expect(createPublicCatalogArtifact(raw, '0'.repeat(40))).rejects.toThrow('artifact_invalid')
    await expect(createPublicCatalogArtifact({}, sourceRevision)).rejects.toThrow('snapshot_invalid')
  })
  it('refuses tampering, private fields, oversize rows, future time and expiration exactly at the boundary', async () => {
    const value = await artifact()
    await expect(readPublicCatalogArtifact({ ...value, sourceRevision: 'b'.repeat(40) })).rejects.toThrow('digest_mismatch')
    await expect(readPublicCatalogArtifact({ ...value, secret: 'never public' })).rejects.toThrow('artifact_invalid')
    await expect(readPublicCatalogArtifact({ ...value, catalog: { ...value.catalog,
      agents: [{ ...value.catalog.agents[0], secret: 'never public' }] } })).rejects.toThrow('artifact_invalid')
    await expect(readPublicCatalogArtifact(value, value.expiresAt)).rejects.toThrow('artifact_expired')
    await expect(readPublicCatalogArtifact(value, value.generatedAt - 1)).rejects.toThrow('artifact_expired')
    await expect(readPublicCatalogArtifact({ ...value, expiresAt: value.generatedAt + CATALOG_MAX_AGE_MS + 1 })).rejects.toThrow('artifact_invalid')
    await expect(createPublicCatalogArtifact(await snapshot(Array.from({ length: 101 }, (_, i) => entry(String(i)))), sourceRevision)).rejects.toThrow('snapshot_invalid')
  })
})

describe('isolated public MCP profile', () => {
  it('lists only the native public tool with strict input and read-only annotations', async () => {
    const response = await invoke(rpc('tools/list'), await artifact())
    const body = await response.json()
    expect(response.status).toBe(200)
    if (!isRecord(body)) throw Error('Expected JSON-RPC object')
    const inventory = ListToolsResultSchema.parse(body.result)
    expect(inventory.tools.map(tool => tool.name)).toEqual([CATALOG_SERVICE_TOOL])
    expect(inventory.tools[0]!.inputSchema.additionalProperties).toBe(false)
    expect(inventory.tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
  })
  it('refuses privileged tools, nonempty arguments, credentials, foreign origins and unsupported methods before reading data', async () => {
    let reads = 0
    for (const [body, extra] of [
      [rpc('tools/call', { name: 'commerce.checkout.confirm', arguments: {} }), {}],
      [rpc('tools/call', { name: 'commerce.theme.deploy', arguments: {} }), {}],
      [rpc('tools/call', { name: CATALOG_SERVICE_TOOL, arguments: { url: 'https://private.invalid' } }), {}],
      [rpc('resources/read', { uri: 'file:///private' }), {}],
      [call(), { origin: 'https://other.invalid' }], [call(), { cookie: 'session=private' }],
      [call(), { authorization: 'Bearer private' }], [call(), { 'content-encoding': 'gzip' }],
    ] as const) {
      const response = await handleCatalogMcpRequest(new Request('http://127.0.0.1:5192/', {
        method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
      }), async () => { reads++; return artifact() }, 'test')
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
    expect(reads).toBe(0)
  })
  it('returns explicit failures for malformed JSON, batches, excess bytes and unavailable state', async () => {
    const value = await artifact()
    for (const text of ['{', '[]', JSON.stringify({ ...call(), padding: 'x'.repeat(16_384) })]) {
      const response = await handleCatalogMcpRequest(new Request('http://localhost/', {
        method: 'POST', headers, body: text,
      }), async () => value, 'test')
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
    expect((await invoke(call(), null)).status).toBe(503)
    expect((await invoke(call(), { ...value, expiresAt: 1 })).status).toBe(503)
    const response = await handleCatalogMcpRequest(new Request('http://localhost/'), async () => value, 'test')
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST')
  })
  it('caps the whole MCP response, including text and structured-content duplication', async () => {
    const agents = Array.from({ length: 100 }, (_, i) => ({ ...entry(String(i).padStart(3, '0')),
      admissionInputs: { toolAllowlistEntry: { tool_names: Array.from({ length: 18 }, (_, j) => `${j}-${'x'.repeat(120)}`) } } }))
    const value = await createPublicCatalogArtifact(await snapshot(agents), sourceRevision)
    const response = await invoke(call(), value)
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).toContain('catalog_response_too_large')
  })
})

describe('bounded loopback catalog host', () => {
  it('completes initialize, tools/list and tools/call using the official SDK over real HTTP', async () => {
    const observations: unknown[] = [], host = await startCatalogService(await artifact(), { observe: event => observations.push(event) })
    const client = new Client({ name: 'commerce-catalog-test', version: '1.0.0' })
    try {
      // SDK 1.30.0's concrete sessionId getter includes undefined; its own Transport declaration omits it under exactOptionalPropertyTypes.
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url)) as Transport)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([CATALOG_SERVICE_TOOL])
      const result = await client.callTool({ name: CATALOG_SERVICE_TOOL, arguments: {} })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toMatchObject({ result: { schema: 'commerce.public-catalog/v1', sourceRevision,
        catalog: { agents: [{ agentId: 'a' }, { agentId: 'z' }] } } })
      expect(JSON.stringify(observations)).not.toMatch(/private|cookie|authorization|admissionInputs/)
      expect(observations.length).toBeGreaterThanOrEqual(3)
    } finally { await client.close(); await host.close() }
  })
  it('keeps private routes absent, blocks host spoofing, and enforces a rolling service quota', async () => {
    let clock = 0
    const host = await startCatalogService(await artifact(), { clock: () => clock })
    try {
      expect((await fetch(host.url.replace('/services/mcp', '/mcp/operator'), { method: 'POST' })).status).toBe(404)
      const spoofed = await new Promise<number>(resolve => {
        const request = httpRequest(host.url, { headers: { host: 'attacker.invalid' } }, response => {
          response.resume(); resolve(response.statusCode!)
        }); request.end()
      })
      expect(spoofed).toBe(403)
      for (let i = 0; i < 60; i++) expect((await fetch(host.url)).status).toBe(405)
      const limited = await fetch(host.url)
      expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60')
      clock = 60_000
      expect((await fetch(host.url)).status).toBe(405)
    } finally { await host.close() }
  })
  it('reserves four slots before body reads and frees them on disconnect', async () => {
    const host = await startCatalogService(await artifact()), pending: ClientRequest[] = []
    try {
      for (let i = 0; i < 4; i++) pending.push(slowRequest(host.url))
      await new Promise(resolve => setTimeout(resolve, 40))
      const busy = await fetch(host.url)
      expect(busy.status).toBe(503); expect(await busy.json()).toMatchObject({ code: 'catalog_busy' })
      for (const request of pending) request.destroy()
      await new Promise(resolve => setTimeout(resolve, 40))
      expect((await fetch(host.url)).status).toBe(405)
    } finally { for (const request of pending) request.destroy(); await host.close() }
  })
  it('bounds streamed bytes without Content-Length and releases timed-out body work', async () => {
    const host = await startCatalogService(await artifact())
    try {
      const excessive = await new Promise<number>(resolve => {
        const request = httpRequest(host.url, { method: 'POST', headers }, response => { response.resume(); resolve(response.statusCode!) })
        request.on('error', () => undefined); request.write('x'.repeat(16_385)); request.end()
      })
      expect(excessive).toBe(413)
      const deadline = await new Promise<number>(resolve => {
        const request = slowRequest(host.url, resolve)
        request.once('close', () => request.destroy())
      })
      expect(deadline).toBe(504)
      expect((await fetch(host.url)).status).toBe(405)
    } finally { await host.close() }
  }, 8000)
})

function slowRequest(url: string, resolve?: (status: number) => void): ClientRequest {
  const request = httpRequest(url, { method: 'POST', headers }, response => {
    response.resume(); resolve?.(response.statusCode!)
  })
  request.on('error', () => undefined); request.write('{')
  return request
}
