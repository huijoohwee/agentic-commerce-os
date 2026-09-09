import { describe, expect, it } from 'vitest'
import { DEVICE_HOST_CONTRACT, parseDeviceHostPins, probeDeviceHost } from '../../src/sandbox/device-host.ts'
const pins = { origin: 'https://executor.example.net', bundleSha256: 'a'.repeat(64), imageId: 'b'.repeat(64) }
const env = { EXECUTION_HOST_BEARER_TOKEN: 'c'.repeat(64) }
const probe = { ok: true, contract: DEVICE_HOST_CONTRACT, availability: 'device-session', ...pins }
delete (probe as Partial<typeof probe>).origin
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
describe('device host identity protocol', () => {
  it('refuses unsafe destinations and malformed identity pins', () => {
    for (const origin of ['http://executor.example.net', 'https://user:pass@example.net',
      'https://executor.example.net/path', 'https://127.0.0.1', 'https://executor.local',
      'https://executor.example.net:444', 'https://executor.example.net/?redirect=1']) {
      expect(() => parseDeviceHostPins({ ...pins, origin })).toThrow()
    }
    expect(() => parseDeviceHostPins({ ...pins, imageId: '0'.repeat(64) })).toThrow()
    expect(() => parseDeviceHostPins({ ...pins, extra: true })).toThrow()
  })
  it('refuses unavailable, cached, oversized, stale and old-contract host responses', async () => {
    for (const response of [json({ ...probe, contract: 'commerce.local-execution-host/v1' }),
      json({ ...probe, imageId: 'f'.repeat(64) }), json({ ...probe, bundleSha256: 'f'.repeat(64) }),
      json(probe, 503), json({ ...probe, extra: true }), Response.json(probe),
      new Response('x'.repeat(4_097), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })]) {
      await expect(probeDeviceHost(pins, env.EXECUTION_HOST_BEARER_TOKEN, async () => response)).rejects.toThrow()
    }
  })
})
