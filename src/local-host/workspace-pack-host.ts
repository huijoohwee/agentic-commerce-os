import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import * as z from 'zod/v4'
import { BodyError, readLocalBody } from '../shared/local-http-body.ts'
import { createGraphPackAdapter, digest, PACK_LIMITS, PACK_TOOL, type PackResult } from './workspace-program-pack.ts'

export const PACK_PATH = '/agentic-commerce-os/services/workspace-pack'
type Options = { port?: number; assets: string; adapter: (input: unknown, signal: AbortSignal) => Promise<PackResult>; adapterDigest: string }
export async function startWorkspacePackHost(options: Options) {
  if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw Error('workspace_pack_port_invalid')
  const sample = 'print("ready")\n'
  await options.adapter({ title: 'Service readiness', source: sample, sourceDigest: digest(sample) }, AbortSignal.timeout(5000))
  const assets = new Map(await Promise.all([
    ['/', 'workspace-pack.html', 'text/html; charset=utf-8'],
    ['/workspace-pack.js', 'workspace-pack.js', 'application/javascript; charset=utf-8'],
    ['/workspace-pack.css', 'workspace-pack.css', 'text/css; charset=utf-8'],
  ].map(async ([route, name, type]) => [route!, { text: await fs.readFile(path.join(options.assets, name!), 'utf8'), type: type! }] as const)))
  let port = 0, active = 0, closing = false
  const arrivals: number[] = [], controllers = new Set<AbortController>()
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 6500 }, (request, response) => {
    const send = (status: number, value: string | object, type = 'application/json', extra: Record<string, string> = {}) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...extra })
      response.end(typeof value === 'string' ? value : JSON.stringify(value))
    }
    const failure = (status: number, code: string) => send(status, { ok: false, code })
    const host = request.headers.host
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host ?? '')) return failure(403, 'workspace_pack_host_refused')
    const origin = `http://${host}`
    if (request.headers.origin !== undefined && request.headers.origin !== origin
      || request.headers.authorization !== undefined || request.headers.cookie !== undefined
      || request.headers['content-encoding'] !== undefined) return failure(403, 'workspace_pack_credentials_or_origin_refused')
    if (request.method === 'GET') {
      if (request.url === '/' || request.url === PACK_PATH) return send(302, '', 'text/plain', { location: PACK_PATH + '/' })
      if (request.url === `${PACK_PATH}/service.json`) return send(200, { schema: 'commerce.workspace-pack-service/v1',
        id: PACK_TOOL, owner: 'agentic-commerce-os', title: 'Workspace Program Pack', price: { amount: '0', mode: 'free' },
        availability: 'device-session', scope: 'loopback-only', marketplaceListed: false, registryAdmission: 'not-claimed',
        adapterDigest: options.adapterDigest, limits: PACK_LIMITS, api: PACK_PATH + '/api', mcp: PACK_PATH + '/mcp' })
      const asset = request.url?.startsWith(PACK_PATH) ? assets.get(request.url.slice(PACK_PATH.length)) : undefined
      if (asset) return send(200, asset.text, asset.type)
      return failure(404, 'not_found')
    }
    if (![`${PACK_PATH}/api`, `${PACK_PATH}/mcp`].includes(request.url ?? '')) return failure(404, 'not_found')
    if (request.method !== 'POST') return send(405, { ok: false, code: 'post_required' }, 'application/json', { allow: 'POST' })
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) return failure(415, 'json_required')
    const time = performance.now()
    while (arrivals.length && time - arrivals[0]! >= 60000) arrivals.shift()
    if (arrivals.length >= 60) return failure(429, 'workspace_pack_rate_limit')
    if (closing || active >= 4) return failure(503, 'workspace_pack_busy')
    arrivals.push(time); active++
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 6000)
    const disconnect = () => { if (!response.writableFinished) controller.abort() }
    response.once('close', disconnect); request.once('aborted', disconnect); request.once('error', disconnect)
    void (async () => {
      let mcp: McpServer | undefined
      try {
        const body = JSON.parse(await readLocalBody(request, controller.signal, PACK_LIMITS.requestBytes))
        if (controller.signal.aborted) throw Error('workspace_pack_cancelled')
        if (request.url === `${PACK_PATH}/api`) return send(200, await options.adapter(body, controller.signal))
        mcp = new McpServer({ name: 'agentic-commerce-os-workspace-pack', version: '0.1.0' })
        mcp.registerTool(PACK_TOOL, { title: 'Create a Workspace Program Pack',
          description: 'Convert supported Python into exact Python, Block/JSON, Markdown and Canvas files. Free. Does not execute code or publish files.',
          inputSchema: z.object({ title: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/),
            source: z.string().min(1).max(PACK_LIMITS.sourceBytes), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async input => {
          try { const result = await options.adapter(input, controller.signal)
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } }
          } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Workspace conversion refused. Check source, digest and supported Python syntax.' }] } }
        })
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
        await mcp.connect(transport)
        const result = await transport.handleRequest(new Request(origin + request.url, { method: 'POST',
          headers: { 'content-type': 'application/json', accept: request.headers.accept ?? '',
            ...(request.headers['mcp-protocol-version'] ? { 'mcp-protocol-version': String(request.headers['mcp-protocol-version']) } : {}) },
          signal: controller.signal }), { parsedBody: body })
        const text = await result.text()
        if (Buffer.byteLength(text) >= 500000) throw Error('workspace_pack_result_limit')
        send(result.status, text)
      } catch (error) {
        const message = error instanceof Error && /^workspace_pack_[a-z_]+$/.test(error.message) ? error.message : 'workspace_pack_request_refused'
        failure(controller.signal.aborted ? 504 : error instanceof BodyError ? error.status : error instanceof SyntaxError ? 400 : 422, message)
      } finally {
        try { await mcp?.close() } finally {
          clearTimeout(timer); controllers.delete(controller); active--
          response.off('close', disconnect); request.off('aborted', disconnect)
        }
      }
    })().catch(() => failure(503, 'workspace_pack_unavailable'))
  })
  server.maxConnections = 8; server.maxHeadersCount = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: options.port ?? 0, exclusive: true }, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('workspace_pack_address_invalid')
  port = address.port
  return { url: `http://127.0.0.1:${port}${PACK_PATH}/`, close: async () => {
    closing = true; controllers.forEach(controller => controller.abort())
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  } }
}

if (process.env.COMMERCE_WORKSPACE_PACK_DEV === '1') {
  const adapterDigest = process.env.GRAPH_PACK_ADAPTER_SHA256 ?? ''
  const adapter = createGraphPackAdapter(process.env.GRAPH_PACK_ADAPTER ?? '', adapterDigest)
  const host = await startWorkspacePackHost({ adapter, adapterDigest, port: Number(process.env.COMMERCE_WORKSPACE_PACK_PORT ?? '5190'), assets: path.resolve('public/local-first') })
  process.stdout.write(`Workspace Program Pack: ${host.url}\nMCP: ${host.url}mcp\n`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close() })
}
