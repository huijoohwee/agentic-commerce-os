import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { startLocalHost, MAXIMUM_HOST_BODY_BYTES } from '../../scripts/local-host/server.ts'
import type { IsolatedExecutor } from '../../src/sandbox/isolation.ts'

const token = 'a'.repeat(64)
const identity = { imageId: 'b'.repeat(64), bundleSha256: 'c'.repeat(64) }
const hosts: Awaited<ReturnType<typeof startLocalHost>>[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.close())) })
const payload = { instanceId: 'client-chosen', purpose: 'registration-dry-run',
  limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
  payload: { registration: { tools: [{ name: 'commerce.catalog.search', loading: 'direct' }] },
    toolCalls: [{ toolId: 'commerce.catalog.search', input: {} }] }, declaredAllowlist: ['commerce.catalog.search'] }
async function start(overrides: Partial<Parameters<typeof startLocalHost>[0]> = {}) {
  const execute = vi.fn<IsolatedExecutor['execute']>().mockResolvedValue({ ok: false, exceededLimit: null, attemptedCalls: [] })
  const terminate = vi.fn<IsolatedExecutor['terminate']>().mockResolvedValue()
  const createExecutor = vi.fn(() => ({ execute, terminate }))
  const probe = vi.fn(async () => true)
  const host = await startLocalHost({ token, identity, createExecutor, probe, ...overrides })
  hosts.push(host)
  return { ...host, execute, terminate, createExecutor, probe }
}
function call(origin: string, path = '/v1/run', body: unknown = payload, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { method: path === '/v1/run' ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(path === '/v1/run' ? { body: JSON.stringify(body) } : {}),
  })
}

describe('device-session execution host', () => {
  it('refuses stale or partial runtime pins before reading source or provisioning', async () => {
    const host = await start()
    for (const headers of [
      { 'x-commerce-host-bundle-sha256': 'd'.repeat(64), 'x-commerce-host-image-id': identity.imageId },
      { 'x-commerce-host-bundle-sha256': identity.bundleSha256, 'x-commerce-host-image-id': 'd'.repeat(64) },
      { 'x-commerce-host-bundle-sha256': identity.bundleSha256 },
    ]) {
      const response = await call(host.origin, '/v1/run', payload, headers)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ ok: false, code: 'local_host_identity_mismatch' })
    }
    expect(host.createExecutor).not.toHaveBeenCalled()
    expect(host.probe).not.toHaveBeenCalled()
    expect((await call(host.origin, '/readyz', undefined, {
      'x-commerce-host-bundle-sha256': identity.bundleSha256, 'x-commerce-host-image-id': identity.imageId,
    })).status).toBe(200)
  })
  it('requires local authority and a credential before probing or accepting source', async () => {
    const host = await start()
    for (const headers of [{ authorization: '' }, { authorization: `Bearer ${'d'.repeat(64)}` }]) {
      expect((await call(host.origin, '/readyz', undefined, headers)).status).toBe(401)
    }
    expect((await call(host.origin, '/v1/run', payload, { origin: 'https://airvio.co' })).status).toBe(403)
    const wrongHost = await new Promise<number | undefined>(resolve => {
      const request = httpRequest(`${host.origin}/v1/run`, { method: 'POST',
        headers: { host: 'attacker.example', authorization: `Bearer ${token}` } }, response => {
        response.resume(); resolve(response.statusCode)
      })
      request.end(JSON.stringify(payload))
    })
    expect(wrongHost).toBe(403)
    expect((await call(host.origin, '/v1/run', payload, { 'content-encoding': 'gzip' })).status).toBe(403)
    expect(host.probe).not.toHaveBeenCalled()
    expect(host.createExecutor).not.toHaveBeenCalled()
  })
  it('separates process liveness from a fresh executor readiness check', async () => {
    const host = await start()
    expect((await call(host.origin, '/livez')).status).toBe(200)
    expect(host.probe).not.toHaveBeenCalled()
    const ready = await call(host.origin, '/readyz')
    expect(ready.headers.get('cache-control')).toBe('no-store')
    expect(await ready.json()).toMatchObject({ ok: true, availability: 'device-session', ...identity })
    host.probe.mockResolvedValue(false)
    const unavailable = await call(host.origin, '/readyz')
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ ok: false, code: 'local_executor_unavailable' })
    host.probe.mockRejectedValue(new Error('private runtime diagnostics'))
    expect(await (await call(host.origin, '/readyz')).text()).not.toContain('private runtime diagnostics')
  })
  it('refuses malformed, oversized and unsupported input without provisioning', async () => {
    const host = await start()
    expect((await call(host.origin, '/v1/run', {})).status).toBe(400)
    expect((await call(host.origin, '/v1/run', payload, { 'content-type': 'text/plain' })).status).toBe(415)
    const oversized = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${host.origin}/v1/run`, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'content-length': String(MAXIMUM_HOST_BODY_BYTES + 1),
      } }, response => { response.resume(); resolve(response.statusCode) })
      request.once('error', reject); request.flushHeaders()
    })
    expect(oversized).toBe(413)
    const malformed = await fetch(`${host.origin}/v1/run`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{',
    })
    expect(malformed.status).toBe(400)
    expect((await call(host.origin, '/v1/run?token=unexpected')).status).toBe(404)
    expect(host.createExecutor).not.toHaveBeenCalled()
  })
  it('rejects concurrent work without a queue and releases the slot after a failed probe', async () => {
    const pending = Promise.withResolvers<boolean>()
    const entered = Promise.withResolvers<void>()
    const host = await start({ probe: async () => { entered.resolve(); return pending.promise } })
    const first = call(host.origin, '/readyz')
    await entered.promise
    const busy = await call(host.origin, '/v1/run')
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('1')
    expect(await busy.json()).toMatchObject({ code: 'local_host_busy' })
    pending.resolve(false)
    expect((await first).status).toBe(503)
    expect((await call(host.origin, '/v1/run', {})).status).toBe(400)
  })
  it('uses the existing executable-target validation and cleans up the owned executor', async () => {
    const host = await start()
    const response = await call(host.origin)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'sandbox_blocked', reason: 'sandbox_executable_target_required' })
    expect(host.execute).not.toHaveBeenCalled()
    expect(host.terminate).toHaveBeenCalled()
  })
  it('refuses subsequent work after execution cleanup becomes unproven', async () => {
    const host = await start()
    const source = 'export async function executeTool() { return null }'
    host.execute.mockRejectedValue(new Error('isolated_process_cleanup_unproven'))
    const response = await call(host.origin, '/v1/run', { ...payload, payload: { ...payload.payload,
      executableTarget: { contract: 'agentic-graph-sandbox-executable/v1', kind: 'javascript-module',
        source, sourceDigest: createHash('sha256').update(source).digest('hex') },
    } })
    expect(response.status).toBe(503)
    const readiness = await call(host.origin, '/readyz')
    expect(readiness.status).toBe(503)
    expect(await readiness.json()).toMatchObject({ code: 'local_host_recovery_required' })
    expect((await call(host.origin, '/v1/run')).status).toBe(503)
    expect(host.execute).toHaveBeenCalledOnce()
  })
  it('releases the host slot when the caller disconnects mid-execution', async () => {
    const hanging = Promise.withResolvers<Awaited<ReturnType<IsolatedExecutor['execute']>>>()
    const source = 'export async function executeTool() { while (true) {} }'
    const host = await start()
    host.execute.mockImplementation(() => hanging.promise)
    host.terminate.mockImplementation(async () => {
      hanging.resolve({ ok: false, exceededLimit: null, attemptedCalls: [] })
    })
    const abort = new AbortController()
    const running = fetch(`${host.origin}/v1/run`, { method: 'POST', signal: abort.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, payload: { ...payload.payload,
        executableTarget: { contract: 'agentic-graph-sandbox-executable/v1', kind: 'javascript-module',
          source, sourceDigest: createHash('sha256').update(source).digest('hex') },
      } }),
    }).then(() => 'completed', () => 'aborted')
    await vi.waitFor(() => expect(host.execute).toHaveBeenCalledOnce())
    expect((await call(host.origin, '/readyz')).status).toBe(503)
    abort.abort()
    expect(await running).toBe('aborted')
    await vi.waitFor(async () => {
      expect(host.terminate).toHaveBeenCalled()
      expect((await call(host.origin, '/readyz')).status).toBe(200)
    })
  })
  it('closes a partial upload and removes the listener on shutdown', async () => {
    const host = await start()
    const connected = Promise.withResolvers<void>()
    const done = new Promise<void>(resolve => {
      const request = httpRequest(`${host.origin}/v1/run`, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '100',
      } })
      request.on('error', () => resolve())
      request.on('close', () => resolve())
      request.on('socket', socket => socket.once('connect', () => connected.resolve()))
      request.write('{')
    })
    await connected.promise
    await host.close()
    await done
    await expect(call(host.origin, '/livez')).rejects.toThrow()
  })
  it('rejects weak credentials and invalid ports before opening a listener', async () => {
    const host = await start()
    for (const options of [{ token: 'short' }, { port: 65536 }, { port: -1 }]) {
      await expect(startLocalHost({ token, identity, probe: host.probe,
        createExecutor: host.createExecutor, ...options })).rejects.toThrow('local_host_configuration_invalid')
    }
  })
})
