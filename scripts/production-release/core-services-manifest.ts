import fs from 'node:fs'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

import { canonicalJson, sha256 } from '../evidence-integrity.ts'

export const PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA =
  'agentic-commerce-production-core-services/v1' as const
export const PRODUCTION_CORE_SERVICES_MANIFEST_PATH = fileURLToPath(
  new URL('../../config/production-core-services.json', import.meta.url),
)
export const MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES = 16_384

const REQUIRED_BINDINGS = Object.freeze([
  'ACOS_ADMISSION',
  'CHECKOUT_PROVIDER',
  'COMMERCE_SANDBOX',
  'DOCS_MCP',
  'MARKETPLACE_PROVIDER',
])
const MANIFEST_KEYS = Object.freeze(['schema', 'services'])
const SERVICE_KEYS = Object.freeze(['binding', 'service'])
const BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u
const SERVICE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/u

type JsonObject = Record<string, unknown>

export type ProductionCoreService = Readonly<{
  binding: string
  service: string
}>

export type ProductionCoreServicesManifest = Readonly<{
  schema: typeof PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA
  services: readonly ProductionCoreService[]
}>

export type ProductionCoreServicesSnapshot = Readonly<{
  manifest: ProductionCoreServicesManifest
  digest: string
}>

export function parseProductionCoreServicesManifest(
  source: string | Uint8Array,
): ProductionCoreServicesManifest {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : new Uint8Array(source)
  requireManifest(bytes.byteLength > 0
    && bytes.byteLength <= MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES, 'size_invalid')
  let text: string
  let value: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('production_core_services_manifest:json_invalid')
  }
  const manifest = record(value, 'shape_invalid')
  exactKeys(manifest, MANIFEST_KEYS, 'shape_invalid')
  requireManifest(text === `${canonicalJson(manifest)}\n`, 'noncanonical')
  requireManifest(manifest.schema === PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA, 'schema_invalid')
  requireManifest(Array.isArray(manifest.services), 'services_invalid')
  const services = manifest.services as unknown[]
  requireManifest(services.length === REQUIRED_BINDINGS.length, 'service_count_invalid')
  const bindings = new Set<string>()
  const parsed = services.map((entry, index) => {
    const service = record(entry, 'service_shape_invalid')
    exactKeys(service, SERVICE_KEYS, 'service_shape_invalid')
    requireManifest(typeof service.binding === 'string'
      && BINDING_PATTERN.test(service.binding), 'binding_invalid')
    requireManifest(!bindings.has(service.binding), 'binding_duplicate')
    bindings.add(service.binding)
    requireManifest(service.binding === REQUIRED_BINDINGS[index], 'binding_sequence_invalid')
    requireManifest(typeof service.service === 'string'
      && SERVICE_PATTERN.test(service.service), 'service_name_invalid')
    return Object.freeze({ binding: service.binding, service: service.service })
  })
  return Object.freeze({
    schema: PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA,
    services: Object.freeze(parsed),
  })
}

export function readProductionCoreServicesManifest(
  filePath = PRODUCTION_CORE_SERVICES_MANIFEST_PATH,
): ProductionCoreServicesSnapshot {
  const declaredBefore = manifestPathStat(filePath, 'file_invalid')
  requireManifest(declaredBefore.isFile() && !declaredBefore.isSymbolicLink()
    && declaredBefore.nlink === 1n, 'file_invalid')
  // The lstat-to-descriptor checks remain the no-follow guarantee on platforms without O_NOFOLLOW.
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    requireManifest(before.isFile() && before.size > 0n
      && before.nlink === 1n
      && before.size <= BigInt(MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES)
      && sameStableFile(declaredBefore, before), 'file_invalid')
    const bytes = readBoundedManifest(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const declaredAfter = manifestPathStat(filePath, 'changed_during_read')
    requireManifest(sameStableFile(before, after) && sameStableFile(after, declaredAfter)
      && BigInt(bytes.byteLength) === before.size, 'changed_during_read')
    return Object.freeze({
      manifest: parseProductionCoreServicesManifest(bytes),
      digest: sha256(bytes),
    })
  } finally {
    fs.closeSync(descriptor)
  }
}

function readBoundedManifest(descriptor: number): Buffer {
  const maximum = MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES
  const bytes = Buffer.allocUnsafe(maximum + 1)
  let offset = 0
  while (offset <= maximum) {
    const count = fs.readSync(descriptor, bytes, offset, maximum + 1 - offset, null)
    if (count === 0) break
    offset += count
  }
  requireManifest(offset > 0 && offset <= maximum, 'file_invalid')
  return bytes.subarray(0, offset)
}

function manifestPathStat(filePath: string, code: string): fs.BigIntStats {
  try {
    return fs.lstatSync(filePath, { bigint: true })
  } catch {
    throw new Error(`production_core_services_manifest:${code}`)
  }
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
}

function record(value: unknown, code: string): JsonObject {
  requireManifest(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as JsonObject
}

function exactKeys(value: JsonObject, expected: readonly string[], code: string): void {
  requireManifest(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()), code)
}

function requireManifest(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_core_services_manifest:${code}`)
}

export const PRODUCTION_CORE_SERVICES_SNAPSHOT = readProductionCoreServicesManifest()
export const PRODUCTION_CORE_SERVICES_MANIFEST = PRODUCTION_CORE_SERVICES_SNAPSHOT.manifest
export const PRODUCTION_CORE_SERVICES_MANIFEST_DIGEST = PRODUCTION_CORE_SERVICES_SNAPSHOT.digest
export const PRODUCTION_CORE_SERVICES = PRODUCTION_CORE_SERVICES_SNAPSHOT.manifest.services

export function assertProductionCoreServicesManifestCurrent(): void {
  requireManifest(readProductionCoreServicesManifest().digest === PRODUCTION_CORE_SERVICES_SNAPSHOT.digest,
    'snapshot_changed')
}
