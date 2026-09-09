import { isRecord, readJsonResponse } from '../shared/http.ts'

export const DEVICE_HOST_CONTRACT = 'commerce.local-execution-host/v2'
export type DeviceHostPins = Readonly<{ origin: string; bundleSha256: string; imageId: string }>
export type DeviceHostProbe = Readonly<{ ok: true; contract: typeof DEVICE_HOST_CONTRACT;
  availability: 'device-session'; bundleSha256: string; imageId: string }>
export type DeviceHostFetch = (request: Request) => Promise<Response>

export function parseDeviceHostPins(value: unknown): DeviceHostPins {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'bundleSha256,imageId,origin'
    || typeof value.origin !== 'string' || value.origin.length > 253
    || !nonzeroDigest(value.bundleSha256) || !nonzeroDigest(value.imageId)) throw Error('device_host_pins_invalid')
  const url = new URL(value.origin)
  if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password
    || url.port || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(url.hostname)) throw Error('device_host_origin_invalid')
  return Object.freeze({ origin: value.origin, bundleSha256: value.bundleSha256, imageId: value.imageId })
}

export function parseDeviceHostProbe(value: unknown, pins: DeviceHostPins): DeviceHostProbe {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'availability,bundleSha256,contract,imageId,ok'
    || value.ok !== true || value.contract !== DEVICE_HOST_CONTRACT || value.availability !== 'device-session'
    || value.bundleSha256 !== pins.bundleSha256 || value.imageId !== pins.imageId) throw Error('device_host_identity_mismatch')
  return Object.freeze({ ok: true, contract: DEVICE_HOST_CONTRACT, availability: 'device-session',
    bundleSha256: pins.bundleSha256, imageId: pins.imageId })
}

export function deviceHostHeaders(pins: DeviceHostPins, token: string): Headers {
  if (!/^[a-f0-9]{64}$/u.test(token) || /^0+$/u.test(token)) throw Error('device_host_credential_invalid')
  return new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-commerce-host-bundle-sha256': pins.bundleSha256, 'x-commerce-host-image-id': pins.imageId })
}

export async function probeDeviceHost(pins: DeviceHostPins, token: string,
  send: DeviceHostFetch = request => fetch(request), signal?: AbortSignal): Promise<DeviceHostProbe> {
  const response = await send(new Request(`${pins.origin}/readyz`, {
    headers: deviceHostHeaders(pins, token), redirect: 'manual', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  }))
  if (response.status !== 200 || response.redirected || response.headers.get('cache-control') !== 'no-store'
    || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel(); throw Error('device_host_unavailable')
  }
  return parseDeviceHostProbe(await readJsonResponse(response, 4_096), pins)
}

function nonzeroDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value)
}
