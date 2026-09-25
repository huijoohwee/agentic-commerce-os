import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { BodyError, readLocalBody } from '../shared/local-http-body.ts'
import { canonicalJson } from '../shared/digest.ts'
import { CATALOG_MAX_BYTES, createPublicCatalogArtifact, readPublicCatalogArtifact } from '../core/public-catalog.ts'
import { handleCatalogMcpRequest } from '../edge/mcp.ts'

export const CATALOG_SERVICE_PATH = '/agentic-commerce-os/services/mcp'
export const CATALOG_SERVICE_LIMITS = Object.freeze({ concurrency: 4, requestsPerMinute: 60, deadlineMs: 5000 })
type Observation = Readonly<{ requestId: string; status: number; bytes: number; durationMs: number; modelTokens: 0 }>
type Options = Readonly<{ port?: number; observe?: (event: Observation) => void; clock?: () => number }>

/** One loopback process owns its admission counters; multiple hosts do not share a quota. */
export async function startCatalogService(input: unknown, options: Options = {}) {
  const artifact = await readPublicCatalogArtifact(input)
  if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) {
    throw Error('catalog_port_invalid')
  }
  const now = options.clock ?? (() => performance.now())
  const arrivals: number[] = [], controllers = new Set<AbortController>()
  let active = 0, stopping = false, port = 0
  const server = createServer({ headersTimeout: 5000, requestTimeout: 6000, keepAliveTimeout: 1000,
    maxHeaderSize: 8192 }, (request, response) => {
    void dispatch(request, response).catch(() => reply(response, 503, { ok: false, code: 'catalog_unavailable' }))
  })
  server.maxConnections = 8; server.maxHeadersCount = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: options.port ?? 0, exclusive: true }, () => {
      server.off('error', reject); resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('catalog_address_invalid')
  port = address.port

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) {
      return reply(response, 403, { ok: false, code: 'catalog_host_refused' })
    }
    if (request.url !== CATALOG_SERVICE_PATH) return reply(response, 404, { ok: false, code: 'not_found' })
    if (stopping) return reply(response, 503, { ok: false, code: 'catalog_stopping' })
    const time = now()
    while (arrivals.length && time - arrivals[0]! >= 60_000) arrivals.shift()
    if (arrivals.length >= CATALOG_SERVICE_LIMITS.requestsPerMinute) {
      response.setHeader('retry-after', String(Math.max(1, Math.ceil((60_000 - time + arrivals[0]!) / 1000))))
      return reply(response, 429, { ok: false, code: 'catalog_rate_limited' })
    }
    arrivals.push(time)
    if (active >= CATALOG_SERVICE_LIMITS.concurrency) {
      response.setHeader('retry-after', '1')
      return reply(response, 503, { ok: false, code: 'catalog_busy' })
    }
    active++ // Reserve before awaiting any body or artifact work.
    const controller = new AbortController(), requestId = randomUUID(), started = now()
    controllers.add(controller)
    let timedOut = false, status = 499, bytes = 0
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, CATALOG_SERVICE_LIMITS.deadlineMs)
    const disconnect = () => { if (!response.writableFinished) controller.abort() }
    response.once('close', disconnect); request.once('aborted', disconnect)
    // Keep a terminal error listener even when a cancelled body has already released its readers.
    request.once('error', disconnect)
    try {
      const body = request.method === 'POST' ? await readLocalBody(request, controller.signal) : undefined
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const result = await handleCatalogMcpRequest(new Request(`http://${request.headers.host}${CATALOG_SERVICE_PATH}`, {
        method: request.method ?? 'GET', headers, ...(body === undefined ? {} : { body }), signal: controller.signal,
      }), async () => artifact, requestId)
      if (controller.signal.aborted) throw Error('catalog_cancelled')
      const text = await result.text()
      status = result.status; bytes = Buffer.byteLength(text)
      const responseHeaders: Record<string, string> = {}
      result.headers.forEach((value, key) => { responseHeaders[key] = value })
      response.writeHead(status, { ...responseHeaders, connection: 'close',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" })
      response.end(text)
    } catch (error) {
      status = timedOut ? 504 : controller.signal.aborted ? 499 : error instanceof BodyError ? error.status : 503
      const failure = { ok: false, code: timedOut ? 'catalog_deadline' : controller.signal.aborted
        ? 'catalog_cancelled' : error instanceof BodyError ? error.message : 'catalog_unavailable', requestId }
      bytes = Buffer.byteLength(JSON.stringify(failure)); reply(response, status, failure)
    } finally {
      clearTimeout(timer); response.off('close', disconnect); request.off('aborted', disconnect)
      controllers.delete(controller); active--
      // No body, prompt, cookie, token or private source path enters the observation.
      try { options.observe?.({ requestId, status, bytes, durationMs: Math.max(0, now() - started), modelTokens: 0 }) } catch { /* observer cannot grant effects */ }
    }
  }
  let closing: Promise<void> | null = null
  return Object.freeze({ url: `http://127.0.0.1:${port}${CATALOG_SERVICE_PATH}`, close(): Promise<void> {
    if (closing) return closing
    stopping = true
    for (const controller of controllers) controller.abort()
    closing = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections()
    })
    return closing
  } })
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close' })
  response.end(JSON.stringify(value))
}

function readFile(file: string | undefined, maximum: number): unknown {
  if (!file || !path.isAbsolute(file)) throw Error('catalog_file_path_invalid')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > maximum) throw Error('catalog_file_invalid')
    const bytes = Buffer.alloc(maximum + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (length > maximum) throw Error('catalog_file_too_large')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  } finally { fs.closeSync(fd) }
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    artifact: { type: 'string' }, snapshot: { type: 'string' }, out: { type: 'string' },
    'source-revision': { type: 'string' }, port: { type: 'string' },
  } })
  if (positionals.length !== 1) throw Error('catalog_command_required')
  if (positionals[0] === 'export') {
    if (!values.out || !path.isAbsolute(values.out) || !values['source-revision'] || values.artifact || values.port) {
      throw Error('catalog_export_arguments_invalid')
    }
    const artifact = await createPublicCatalogArtifact(readFile(values.snapshot, 499_999), values['source-revision'])
    // Never overwrite the operator's source or an existing approved artifact.
    fs.writeFileSync(values.out, canonicalJson(artifact) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify({ ok: true, artifactDigest: artifact.artifactDigest, expiresAt: artifact.expiresAt }) + '\n')
  } else if (positionals[0] === 'serve') {
    if (values.snapshot || values.out || values['source-revision'] || !/^\d{1,5}$/u.test(values.port ?? '5192')) {
      throw Error('catalog_serve_arguments_invalid')
    }
    const host = await startCatalogService(readFile(values.artifact, CATALOG_MAX_BYTES), {
      port: Number(values.port ?? '5192'), observe: event => process.stdout.write(JSON.stringify(event) + '\n'),
    })
    process.stdout.write(JSON.stringify({ ok: true, url: host.url, scope: 'loopback-only', limits: CATALOG_SERVICE_LIMITS }) + '\n')
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void host.close().catch(() => { process.exitCode = 1 })
    })
  } else throw Error('catalog_command_invalid')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write((error instanceof Error && /^catalog_[a-z_]+$/u.test(error.message)
      ? error.message : 'catalog_command_failed') + '\n'); process.exitCode = 1
  })
}
