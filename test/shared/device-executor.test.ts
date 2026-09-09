import '../worker/device-executor.test.ts'
import { describe, expect, it, vi } from 'vitest'
import { handleDeviceSandbox } from '../../src/sandbox/device-executor.ts'
import { DEVICE_HOST_CONTRACT } from '../../src/sandbox/device-host.ts'
import { probeRegistrationSandbox } from '../../src/core/sandbox-registration.ts'

const pins = { origin: 'https://executor.example.net', bundleSha256: 'a'.repeat(64), imageId: 'b'.repeat(64) }
const env: DeviceSandboxEnv = { EXECUTION_HOST_URL: pins.origin, EXECUTION_HOST_BUNDLE_SHA256: pins.bundleSha256,
  EXECUTION_HOST_IMAGE_ID: pins.imageId, EXECUTION_HOST_BEARER_TOKEN: 'c'.repeat(64), DEPLOY_LANE: 'Production',
  RELEASE_CANDIDATE_SHA: 'd'.repeat(40), RELEASE_CANDIDATE_DIGEST: 'e'.repeat(64),
  CF_VERSION_METADATA: { id: 'sandbox-version', tag: 'd'.repeat(40), timestamp: '2026-09-09T00:00:00Z' } }
const probe = { ok: true, contract: DEVICE_HOST_CONTRACT, availability: 'device-session',
  bundleSha256: pins.bundleSha256, imageId: pins.imageId }
const payload = { instanceId: 'caller-chosen', purpose: 'registration-dry-run',
  limits: { wallClockSeconds: 30, memoryMegabytes: 256 }, declaredAllowlist: ['commerce.catalog.search'],
  payload: { registration: { tools: [{ name: 'commerce.catalog.search', loading: 'direct' }] },
    toolCalls: [{ toolId: 'commerce.catalog.search', input: {} }] } }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const request = (path = '/readyz') => new Request('https://sandbox.internal' + path,
  path === '/v1/run' ? { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'caller-secret' },
    body: JSON.stringify(payload) } : {})

describe('device sandbox service facade', () => {
  it('uses dedicated server credentials and fresh pinned readiness without caching', async () => {
    const send = vi.fn(async (req: Request) => {
      expect(req.url).toBe(pins.origin + '/readyz')
      expect(req.redirect).toBe('manual')
      expect(req.headers.get('authorization')).toBe('Bearer ' + env.EXECUTION_HOST_BEARER_TOKEN)
      expect(req.headers.get('x-commerce-host-bundle-sha256')).toBe(pins.bundleSha256)
      expect(req.headers.get('x-commerce-host-image-id')).toBe(pins.imageId)
      return json(probe)
    })
    for (let i = 0; i < 2; i++) {
      const response = await handleDeviceSandbox(request(), env, send)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ hostProbe: probe, version: env.CF_VERSION_METADATA })
    }
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('validates input before contacting the host and never forwards caller authority', async () => {
    const send = vi.fn(async () => json(probe))
    const invalid = new Request('https://sandbox.internal/v1/run', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })
    expect((await handleDeviceSandbox(invalid, env, send)).status).toBe(400)
    expect(send).not.toHaveBeenCalled()
    expect((await handleDeviceSandbox(new Request('https://sandbox.internal/readyz', {
      headers: { Origin: 'https://airvio.co' } }), env, send)).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })
  it('executes once with runtime pins and keeps the host-owned instance ID', async () => {
    const send = vi.fn(async (req: Request) => {
      if (new URL(req.url).pathname === '/readyz') return json(probe)
      expect(req.headers.get('authorization')).not.toContain('caller-secret')
      expect(req.headers.get('x-commerce-host-image-id')).toBe(pins.imageId)
      expect(req.redirect).toBe('manual')
      return json({ ok: true, record: { instanceId: 'run-' + 'a'.repeat(32), purpose: 'registration-dry-run' } })
    })
    const response = await handleDeviceSandbox(request('/v1/run'), env, send)
    expect(response.status).toBe(200)
    expect((await response.json() as { record: { instanceId: string } }).record.instanceId).not.toBe(payload.instanceId)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('never retries an unknown execution result or returns private network errors', async () => {
    const send = vi.fn(async (req: Request) => {
      if (new URL(req.url).pathname === '/readyz') return json(probe)
      throw Error('private-network-details-' + env.EXECUTION_HOST_BEARER_TOKEN)
    })
    const response = await handleDeviceSandbox(request('/v1/run'), env, send)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(env.EXECUTION_HOST_BEARER_TOKEN)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('rejects a host switch between readiness and execution without retry', async () => {
    const send = vi.fn(async (req: Request) => new URL(req.url).pathname === '/readyz'
      ? json(probe) : json({ ok: false, code: 'local_host_identity_mismatch' }, 409))
    expect((await handleDeviceSandbox(request('/v1/run'), env, send)).status).toBe(503)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('rejects misbound Worker versions before network access', async () => {
    const send = vi.fn(async () => json(probe))
    expect((await handleDeviceSandbox(request(), { ...env, RELEASE_CANDIDATE_SHA: 'f'.repeat(40) }, send)).status).toBe(503)
    expect(send).not.toHaveBeenCalled()
  })
  it('preserves production core readiness through the actual facade contract', async () => {
    const binding = { fetch: (req: Request) => handleDeviceSandbox(req, env, async () => json(probe)) } as Fetcher
    const observed = await probeRegistrationSandbox(binding, 'Production', env.RELEASE_CANDIDATE_SHA, env.RELEASE_CANDIDATE_DIGEST)
    expect(observed.ok).toBe(true)
    expect(observed.versionId).toBe(env.CF_VERSION_METADATA.id)
  })
})
