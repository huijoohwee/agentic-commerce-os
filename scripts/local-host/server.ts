import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { bearerAuthorized } from '../../src/shared/auth.ts'
import { parseSandboxRequest, type IsolatedExecutor } from '../../src/sandbox/isolation.ts'
import { runServerIsolated } from '../../src/sandbox/server-run.ts'

export const LOCAL_HOST_CONTRACT = 'commerce.local-execution-host/v2'
export const MAXIMUM_HOST_BODY_BYTES = 1_000_000
export type LocalHostOptions = Readonly<{
  token: string
  port?: number
  identity: Readonly<{ imageId: string; bundleSha256: string }>
  createExecutor: () => IsolatedExecutor
  probe: () => Promise<boolean>
}>

/** Loopback ingress only. A separately authenticated transport owns remote access. */
export async function startLocalHost(options: LocalHostOptions) {
  if (!/^[a-f0-9]{64}$/u.test(options.token)
    || !/^[a-f0-9]{64}$/u.test(options.identity.imageId)
    || !/^[a-f0-9]{64}$/u.test(options.identity.bundleSha256)
    || !Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) {
    throw new Error('local_host_configuration_invalid')
  }
  let stopping = false
  let recoveryRequired = false
  let active: Promise<void> | null = null
  let executor: IsolatedExecutor | null = null
  let port = 0
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 7_000,
    keepAliveTimeout: 1_000, maxHeaderSize: 8_192 }, (request, response) => {
    void dispatch(request, response).catch(() => reply(response, 503, { ok: false, code: 'local_host_failed' }))
  })
  server.maxConnections = 8
  server.maxHeadersCount = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: options.port ?? 0, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local_host_address_invalid')
  port = address.port

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply(response, 403, { ok: false, code: 'local_host_authority_invalid' })
    }
    if (request.headers.origin !== undefined || request.headers['content-encoding'] !== undefined) {
      return reply(response, 403, { ok: false, code: 'local_host_browser_or_encoding_refused' })
    }
    if (!await bearerAuthorized(new Request('http://localhost/', {
      headers: { authorization: request.headers.authorization ?? '' },
    }), options.token)) return reply(response, 401, { ok: false, code: 'unauthorized' })
    const bundlePin = request.headers['x-commerce-host-bundle-sha256']
    const imagePin = request.headers['x-commerce-host-image-id']
    if ((bundlePin !== undefined || imagePin !== undefined)
      && (bundlePin !== options.identity.bundleSha256 || imagePin !== options.identity.imageId)) {
      return reply(response, 409, { ok: false, code: 'local_host_identity_mismatch' })
    }
    if (stopping) return reply(response, 503, { ok: false, code: 'local_host_stopping' })
    if (request.method === 'GET' && request.url === '/livez') {
      return reply(response, 200, { ok: true, contract: LOCAL_HOST_CONTRACT, availability: 'device-session' })
    }
    if (recoveryRequired) return reply(response, 503, { ok: false, code: 'local_host_recovery_required' })
    if (!(request.method === 'GET' && request.url === '/readyz')
      && !(request.method === 'POST' && request.url === '/v1/run')) {
      return reply(response, 404, { ok: false, code: 'not_found' })
    }
    if (active) {
      response.setHeader('retry-after', '1')
      return reply(response, 503, { ok: false, code: 'local_host_busy' })
    }
    // Reserve synchronously before reading a body or provisioning an executor.
    const work = serve(request, response)
    active = work
    try { await work } finally { active = null; executor = null }
  }

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET') {
      const ready = await options.probe().catch(() => false)
      return reply(response, ready ? 200 : 503, { ok: ready, contract: LOCAL_HOST_CONTRACT,
        availability: 'device-session', ...options.identity,
        ...(ready ? {} : { code: 'local_executor_unavailable' }),
      })
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
      return reply(response, 415, { ok: false, code: 'json_required' })
    }
    let body: unknown
    try { body = await readBody(request) } catch (error) {
      return reply(response, error instanceof BodyError ? error.status : 400,
        { ok: false, code: error instanceof BodyError ? error.code : 'body_invalid' })
    }
    const parsed = parseSandboxRequest(body)
    if (!parsed) return reply(response, 400, { ok: false, code: 'sandbox_request_invalid' })
    if (stopping || response.destroyed) return
    const raw = options.createExecutor()
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation() } catch (error) {
        if (!(error instanceof Error && error.message === 'isolated_process_aborted')) recoveryRequired = true
        throw error
      }
    }
    executor = { execute: (input, timeoutMs) => guarded(() => raw.execute(input, timeoutMs)),
      terminate: () => guarded(() => raw.terminate()) }
    const ownedExecutor = executor
    const cancelled = () => {
      if (!response.writableFinished) void ownedExecutor.terminate().catch(() => undefined)
    }
    response.once('close', cancelled)
    try {
      const result = await runServerIsolated(parsed, () => ownedExecutor)
      reply(response, result.ok ? 200 : result.code === 'sandbox_call_not_allowlisted' ? 409
        : result.code === 'sandbox_build_failed' ? 422 : 503, result)
    } finally {
      response.off('close', cancelled)
      // Keep the slot owned until the actual executor has settled and cleaned up.
      await ownedExecutor.terminate()
    }
  }

  let closing: Promise<void> | null = null
  return Object.freeze({ origin: `http://127.0.0.1:${port}`, close() {
    if (closing) return closing
    stopping = true
    closing = (async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await executor?.terminate()
      await active
      await closed
    })()
    return closing
  } })
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  let json = JSON.stringify(body)
  if (Buffer.byteLength(json) > MAXIMUM_HOST_BODY_BYTES) {
    status = 503
    json = JSON.stringify({ ok: false, code: 'local_host_output_limit' })
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' })
  response.end(json)
}

class BodyError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_HOST_BODY_BYTES)) {
    return Promise.reject(new BodyError(413, 'body_too_large'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const timeout = setTimeout(() => finish(new BodyError(408, 'body_timeout')), 5_000)
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      request.off('data', data).off('end', end).off('aborted', aborted)
      if (error) { request.pause(); reject(error) } else resolve(value)
    }
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAXIMUM_HOST_BODY_BYTES) finish(new BodyError(413, 'body_too_large'))
      else chunks.push(chunk)
    }
    const end = () => {
      try { finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) }
      catch { finish(new BodyError(400, 'body_invalid')) }
    }
    const aborted = () => finish(new BodyError(400, 'body_aborted'))
    request.on('data', data).once('end', end).once('aborted', aborted).once('error', finish)
  })
}
