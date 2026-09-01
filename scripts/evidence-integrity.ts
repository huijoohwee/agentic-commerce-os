import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('canonical_json_unsupported_value')
  return encoded
}

export function sha256(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
