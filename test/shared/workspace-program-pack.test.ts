import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createGraphPackAdapter, digest, PACK_SCHEMA, PACK_TOOL, readPackRequest, readPackResult, type PackRequest } from '../../src/local-host/workspace-program-pack'
import { startWorkspacePackHost } from '../../src/local-host/workspace-pack-host'

const input = (source = 'print(1)\n'): PackRequest => ({ title: 'Test program', source, sourceDigest: digest(source) })
function result(request: PackRequest) {
  const unsigned = { schema: PACK_SCHEMA, owner: 'agentic-graph', languageProfile: 'procedural-python/v1',
    title: request.title, sourceDigest: request.sourceDigest, execution: 'not-executed', roundTrip: 'exact',
    canvas: { format: 'mermaid', nodes: 1, edges: 0 }, files: [
      ['program.py', 'text/x-python', request.source], ['program.json', 'application/json', '{}'],
      ['program.md', 'text/markdown', '# Test'], ['canvas.md', 'text/markdown', '# Canvas'],
    ].map(([name, mediaType, content]) => ({ name: name!, mediaType: mediaType!, content: content!, bytes: Buffer.byteLength(content!), digest: digest(content!) })) }
  return { ...unsigned, artifactDigest: digest(JSON.stringify(unsigned)) }
}
async function adapterFile(source: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-pack-test-'))
  const file = path.join(directory, 'adapter.mjs'); await fs.writeFile(file, source)
  return { directory, adapter: createGraphPackAdapter(file, digest(source)), file }
}

describe('versioned Graph workspace adapter', () => {
  it('rejects stale source, unknown input, altered files and foreign artifact identities', () => {
    const request = input(), pack = result(request)
    expect(readPackResult(JSON.stringify(pack), request)).toEqual(pack)
    for (const value of [{ ...request, url: 'https://example.invalid' }, { ...request, source: 'changed' }, input('x'.repeat(32769))]) {
      expect(() => readPackRequest(value)).toThrow()
    }
    for (const value of [{ ...pack, owner: 'other' }, { ...pack, extra: true }, { ...pack, artifactDigest: '0'.repeat(64) },
      { ...pack, files: pack.files.map((file, index) => index ? file : { ...file, content: 'changed' }) }]) {
      expect(() => readPackResult(JSON.stringify(value), request)).toThrow()
    }
  })
  it('executes only pinned adapter bytes without inherited environment and ignores later file replacement', async () => {
    const request = input(), pack = result(request)
    const source = `if (Object.keys(process.env).some(name => name !== "__CF_USER_TEXT_ENCODING")) process.exit(1); for await (const chunk of process.stdin) {} process.stdout.write(${JSON.stringify(JSON.stringify(pack))})`
    const fixture = await adapterFile(source)
    try {
      expect(() => createGraphPackAdapter(fixture.file, '0'.repeat(64))).toThrow('identity')
      await fs.writeFile(fixture.file, 'process.exit(1)')
      expect(await fixture.adapter(request, new AbortController().signal)).toEqual(pack)
    } finally { await fs.rm(fixture.directory, { recursive: true }) }
  })
  it('kills a cancelled converter and refuses excessive output', async () => {
    const slow = await adapterFile('setInterval(() => {}, 100)')
    const large = await adapterFile('process.stdout.write("x".repeat(230000))')
    try {
      const controller = new AbortController(), pending = slow.adapter(input(), controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow('cancelled')
      await expect(large.adapter(input(), new AbortController().signal)).rejects.toThrow('result_limit')
    } finally { await fs.rm(slow.directory, { recursive: true }); await fs.rm(large.directory, { recursive: true }) }
  })
  it('enforces the deadline on a non-terminating adapter', async () => {
    const fixture = await adapterFile('setInterval(() => {}, 100)')
    try { await expect(fixture.adapter(input(), new AbortController().signal)).rejects.toThrow('deadline') }
    finally { await fs.rm(fixture.directory, { recursive: true }) }
  }, 7000)
})

describe('Workspace Pack HTTP and MCP host', () => {
  it('serves a real SDK initialize/list/call sequence through the same bounded API adapter', async () => {
    let calls = 0
    const host = await startWorkspacePackHost({ assets: path.resolve('public/local-first'), adapterDigest: 'a'.repeat(64),
      adapter: async raw => { calls++; return result(readPackRequest(raw)) } })
    const client = new Client({ name: 'workspace-pack-test', version: '1' })
    try {
      expect((await fetch(host.url)).status).toBe(200)
      const descriptor = await (await fetch(host.url + 'service.json')).json()
      expect(descriptor).toMatchObject({ id: PACK_TOOL, marketplaceListed: false, registryAdmission: 'not-claimed' })
      // SDK 1.30.0 concrete transport exposes optional sessionId under exactOptionalPropertyTypes.
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url + 'mcp')) as Transport)
      const tools = await client.listTools(); expect(tools.tools.map(tool => tool.name)).toEqual([PACK_TOOL])
      const output = await client.callTool({ name: PACK_TOOL, arguments: { ...input() } })
      expect(output.isError).not.toBe(true)
      expect(output.structuredContent).toMatchObject({ result: result(input()) })
      expect(calls).toBe(2) // startup readiness plus the explicit conversion
      const api = await fetch(host.url + 'api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) })
      expect(await api.json()).toEqual(result(input()))
      const before = calls
      const refused = await client.callTool({ name: PACK_TOOL, arguments: { ...input(), command: 'run' } })
      expect(refused.isError).toBe(true); expect(calls).toBe(before)
      for (const extra of [{ origin: 'https://foreign.invalid' }, { authorization: 'Bearer fixture' }, { cookie: 'fixture=1' }]) {
        expect((await fetch(host.url + 'api', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(input()) })).status).toBe(403)
      }
      expect(calls).toBe(before)
      expect((await fetch(host.url + 'api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(99000) })).status).toBe(413)
    } finally { await client.close(); await host.close() }
  })
})


describe('Workspace Pack browser tool lifecycle', () => {
  async function browser(registerTool?: (...args: any[]) => unknown, legacy?: object) {
    const nodes = new Map<string, any>(), events = new Map<string, () => void>()
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', addEventListener() {} })
      return nodes.get(id)
    }
    const fetcher = vi.fn(async (_url: unknown, options?: any) => {
      if (options?.signal?.aborted) throw Error('aborted')
      return { ok: true, json: async () => options?.method === 'POST'
        ? result(JSON.parse(options.body)) : { id: PACK_TOOL, price: { mode: 'free' } } }
    })
    const source = await fs.readFile('public/local-first/workspace-pack.js', 'utf8')
    const pending = runInNewContext(`(async () => {${source}\n})()`, {
      document: { getElementById: node, querySelectorAll: () => [], modelContext: registerTool ? { registerTool } : undefined },
      navigator: { modelContext: legacy }, location: { href: 'http://localhost/services/workspace-pack/' },
      addEventListener: (name: string, action: () => void) => events.set(name, action),
      URL, TextEncoder, crypto: webcrypto, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: fetcher,
    })
    return { pending, node, events, fetcher }
  }
  it('awaits Document registration, prefers it to legacy hosts, shares verified API results and cancels on pagehide', async () => {
    let tool: any, signal: AbortSignal | undefined, complete: (() => void) | undefined
    const legacy = { registerTool: vi.fn() }
    const registered = new Promise<void>(resolve => { complete = resolve })
    const page = await browser((value, options) => { tool = value; signal = options.signal; return registered }, legacy)
    expect(page.node('webmcp-status').textContent).not.toContain('registered')
    complete!(); await page.pending
    expect(legacy.registerTool).not.toHaveBeenCalled()
    expect(page.node('webmcp-status').textContent).toBe('Browser WebMCP tool registered.')
    const output = await tool.execute(input(), {})
    expect(JSON.parse(output.content[0].text)).toEqual(result(input()))
    const cancelled = new AbortController(); cancelled.abort()
    await expect(tool.execute(input(), { signal: cancelled.signal })).rejects.toThrow('aborted')
    page.events.get('pagehide')!()
    expect(signal?.aborted).toBe(true)
    await expect(tool.execute(input(), {})).rejects.toThrow('aborted')
  })
  it('reports asynchronous registration rejection and absent support without claiming registration', async () => {
    const rejected = await browser(() => Promise.reject(Error('unsupported')))
    await rejected.pending
    expect(rejected.node('webmcp-status').textContent).toContain('registration unavailable')
    const absent = await browser(); await absent.pending
    expect(absent.node('webmcp-status').textContent).toContain('does not expose WebMCP')
  })
  it('retires a registration that never settles at the bounded deadline', async () => {
    let signal: AbortSignal | undefined
    const page = await browser((_value, options) => { signal = options.signal; return new Promise(() => {}) })
    await page.pending
    expect(signal?.aborted).toBe(true)
    expect(page.node('webmcp-status').textContent).toContain('registration unavailable')
  }, 3000)
})
