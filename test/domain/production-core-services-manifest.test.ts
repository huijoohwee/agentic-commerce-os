import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { canonicalJson, sha256 } from '../../scripts/evidence-integrity.ts'
import {
  MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES,
  PRODUCTION_CORE_SERVICES,
  PRODUCTION_CORE_SERVICES_MANIFEST,
  PRODUCTION_CORE_SERVICES_MANIFEST_DIGEST,
  PRODUCTION_CORE_SERVICES_MANIFEST_PATH,
  PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA,
  PRODUCTION_CORE_SERVICES_SNAPSHOT,
  parseProductionCoreServicesManifest,
  readProductionCoreServicesManifest,
} from '../../scripts/production-release/core-services-manifest.ts'

const EXPECTED_SERVICES = Object.freeze([
  Object.freeze({ binding: 'ACOS_ADMISSION', service: 'agentic-canvas-os' }),
  Object.freeze({ binding: 'CHECKOUT_PROVIDER', service: 'agentic-travel-commerce-production' }),
  Object.freeze({ binding: 'COMMERCE_SANDBOX', service: 'agentic-commerce-sandbox-production' }),
  Object.freeze({ binding: 'DOCS_MCP', service: 'agentic-mcp' }),
  Object.freeze({ binding: 'MARKETPLACE_PROVIDER', service: 'agentic-marketplace-production' }),
])

test('checked-in Production core services are one canonical bounded manifest', () => {
  const bytes = fs.readFileSync(PRODUCTION_CORE_SERVICES_MANIFEST_PATH)
  const loaded = readProductionCoreServicesManifest()
  assert(bytes.byteLength < MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES)
  assert.equal(new TextDecoder().decode(bytes), `${canonicalJson(loaded.manifest)}\n`)
  assert.equal(loaded.manifest.schema, PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA)
  assert.deepEqual(loaded.manifest.services, EXPECTED_SERVICES)
  assert.deepEqual(PRODUCTION_CORE_SERVICES_MANIFEST, loaded.manifest)
  assert.deepEqual(PRODUCTION_CORE_SERVICES, EXPECTED_SERVICES)
  assert.equal(PRODUCTION_CORE_SERVICES_MANIFEST_DIGEST, sha256(bytes))
  assert.deepEqual(PRODUCTION_CORE_SERVICES_SNAPSHOT, loaded)
})

test('manifest rejects extra top-level and service keys', () => {
  assert.throws(() => parse({
    ...PRODUCTION_CORE_SERVICES_MANIFEST,
    extra: true,
  }), /production_core_services_manifest:shape_invalid/u)
  const services = structuredClone(PRODUCTION_CORE_SERVICES) as unknown as Array<Record<string, unknown>>
  services[0]!.extra = true
  assert.throws(() => parse({
    schema: PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA,
    services,
  }), /production_core_services_manifest:service_shape_invalid/u)
})

test('manifest rejects duplicate JSON keys and duplicate bindings', () => {
  const source = `{"schema":"${PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA}",`
    + `"schema":"${PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA}","services":[]}\n`
  assert.throws(() => parseProductionCoreServicesManifest(source),
    /production_core_services_manifest:noncanonical/u)
  const services = structuredClone(PRODUCTION_CORE_SERVICES) as unknown as Array<{
    binding: string; service: string
  }>
  services[1] = services[0]!
  assert.throws(() => parse({
    schema: PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA,
    services,
  }), /production_core_services_manifest:binding_duplicate/u)
})

test('manifest rejects noncanonical bytes, sequence drift, and oversized input', () => {
  assert.throws(() => parseProductionCoreServicesManifest(
    `${JSON.stringify(PRODUCTION_CORE_SERVICES_MANIFEST, null, 2)}\n`,
  ), /production_core_services_manifest:noncanonical/u)
  assert.throws(() => parse({
    schema: PRODUCTION_CORE_SERVICES_MANIFEST_SCHEMA,
    services: [...PRODUCTION_CORE_SERVICES].reverse(),
  }), /production_core_services_manifest:binding_sequence_invalid/u)
  assert.throws(() => parseProductionCoreServicesManifest(
    new Uint8Array(MAXIMUM_PRODUCTION_CORE_SERVICES_MANIFEST_BYTES + 1),
  ), /production_core_services_manifest:size_invalid/u)
})

test('manifest reader rejects symlinks and same-size restored-mtime mutation', () => {
  withTemporaryManifest((filePath, bytes, directory) => {
    const symlinkPath = path.join(directory, 'services-link.json')
    fs.symlinkSync(filePath, symlinkPath)
    assert.throws(() => readProductionCoreServicesManifest(symlinkPath),
      /production_core_services_manifest:file_invalid/u)

    const fixedTimeSeconds = 1_700_000_000
    fs.utimesSync(filePath, fixedTimeSeconds, fixedTimeSeconds)
    const initial = fs.statSync(filePath, { bigint: true })
    const changed = Buffer.from(bytes)
    changed[changed.byteLength - 3] = changed[changed.byteLength - 3] === 97 ? 98 : 97
    assert.throws(() => withFirstDescriptorRead(() => {
      fs.writeFileSync(filePath, changed)
      fs.utimesSync(filePath, fixedTimeSeconds, fixedTimeSeconds)
      assert.equal(fs.statSync(filePath, { bigint: true }).mtimeNs, initial.mtimeNs)
    }, () => readProductionCoreServicesManifest(filePath)),
    /production_core_services_manifest:changed_during_read/u)
  })
})

test('manifest reader rejects replacement of its declared path after open', () => {
  withTemporaryManifest((filePath, bytes, directory) => {
    const displacedPath = path.join(directory, 'services-displaced.json')
    assert.throws(() => withFirstDescriptorRead(() => {
      fs.renameSync(filePath, displacedPath)
      fs.writeFileSync(filePath, bytes)
    }, () => readProductionCoreServicesManifest(filePath)),
    /production_core_services_manifest:changed_during_read/u)
  })
})

function parse(value: unknown): ReturnType<typeof parseProductionCoreServicesManifest> {
  return parseProductionCoreServicesManifest(`${canonicalJson(value)}\n`)
}

function withTemporaryManifest(
  inspect: (filePath: string, bytes: Buffer, directory: string) => void,
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-services-'))
  try {
    const filePath = path.join(directory, 'services.json')
    const bytes = fs.readFileSync(PRODUCTION_CORE_SERVICES_MANIFEST_PATH)
    fs.writeFileSync(filePath, bytes)
    inspect(filePath, bytes, directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function withFirstDescriptorRead(mutate: () => void, inspect: () => unknown): unknown {
  const original = fs.readSync
  let mutated = false
  fs.readSync = ((descriptor: number, buffer: Buffer, offset: number, length: number,
    position: number | null): number => {
    const count = original(descriptor, buffer, offset, length, position)
    if (!mutated) {
      mutated = true
      mutate()
    }
    return count
  }) as typeof fs.readSync
  try {
    return inspect()
  } finally {
    fs.readSync = original
  }
}
