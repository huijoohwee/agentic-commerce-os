import { parseDeviceHostPins, type DeviceHostPins } from '../../src/sandbox/device-host.ts'

export const DEVICE_HOST_PROOF_SCHEMA = 'commerce-device-execution-host-proof/v1' as const
export type DeviceHostProof = DeviceHostPins & Readonly<{
  schema: typeof DEVICE_HOST_PROOF_SCHEMA; availability: 'device-session'; observedAt: string;
}>

export function parseDeviceHostProof(value: unknown): DeviceHostProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('device_host_proof_invalid')
  const proof = value as Record<string, unknown>
  if (Object.keys(proof).sort().join(',') !== 'availability,bundleSha256,imageId,observedAt,origin,schema'
    || proof.schema !== DEVICE_HOST_PROOF_SCHEMA || proof.availability !== 'device-session'
    || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt))) {
    throw Error('device_host_proof_invalid')
  }
  return Object.freeze({ ...parseDeviceHostPins({ origin: proof.origin, bundleSha256: proof.bundleSha256,
    imageId: proof.imageId }), schema: DEVICE_HOST_PROOF_SCHEMA, availability: 'device-session', observedAt: proof.observedAt })
}

export function validateDeviceHostProof(value: unknown, expected: DeviceHostPins, now = Date.now()): DeviceHostProof {
  const proof = parseDeviceHostProof(value)
  const pins = parseDeviceHostPins(expected)
  const age = now - Date.parse(proof.observedAt)
  if (age < -5_000 || age > 30_000 || proof.origin !== pins.origin
    || proof.bundleSha256 !== pins.bundleSha256 || proof.imageId !== pins.imageId) throw Error('device_host_proof_mismatch')
  return proof
}
