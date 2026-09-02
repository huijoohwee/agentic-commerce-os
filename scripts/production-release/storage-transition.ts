import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson } from '../evidence-integrity.ts'
import { validateStorageCompatibility } from '../validate-do-storage-compatibility.ts'
import { PRODUCTION_STORAGE_TRANSITION_SCHEMA } from './contracts.ts'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SAFE_ADDITIVE_DDL = /^(?:table|virtual-table|index|trigger|view):[a-z_][a-z0-9_]*$|^alter:[a-z_][a-z0-9_]*:add-column:[a-z_][a-z0-9_]*$/u
const MAXIMUM_MANIFEST_BYTES = 1_048_576

type JsonObject = Readonly<Record<string, unknown>>
type Migration = Readonly<Record<string, unknown>>
type Binding = Readonly<{ name: string; className: string }>
type Dependency = Readonly<{ sourceFile: string; purpose: string; sourceSha256: string }>
type Ddl = Readonly<{ object: string; sha256: string }>
type Region = Readonly<{
  className: string
  sourceFile: string
  sourceSha256: string
  startMarker: string
  endMarker: string
  regionSha256: string
  ddl: readonly Ddl[]
}>
type Manifest = Readonly<{
  revision: string
  migrations: readonly Migration[]
  bindings: readonly Binding[]
  dependencies: readonly Dependency[]
  regions: readonly Region[]
}>

export type StorageTransitionReason =
  | 'binding_added_without_sqlite_class_migration'
  | 'binding_removed_or_remapped'
  | 'class_lifecycle_destructive'
  | 'codec_drift'
  | 'ddl_added_without_revision_change'
  | 'legacy_durable_object_migration'
  | 'manifest_invalid'
  | 'migration_history_rewritten'
  | 'new_sqlite_class_inventory_mismatch'
  | 'old_ddl_changed_or_reordered'
  | 'revision_changed_without_compatible_delta'
  | 'schema_region_added_without_sqlite_class_migration'
  | 'schema_region_identity_changed'
  | 'schema_region_removed'
  | 'unsafe_ddl_added'

type TransitionBase = Readonly<{
  schema: typeof PRODUCTION_STORAGE_TRANSITION_SCHEMA
  priorRevision: string | null
  currentRevision: string | null
}>

export type RollbackSafeStorageTransition = TransitionBase & Readonly<{
  status: 'rollback-safe'
  classification: 'unchanged'
  introducedDdlObjects: readonly string[]
}>

export type BlockedStorageTransition = TransitionBase & Readonly<{
  status: 'blocked'
  classification: 'storage-surface-changed'
  introducedClasses: readonly string[]
  introducedDdlObjects: readonly string[]
  reasons: readonly StorageTransitionReason[]
  reason: 'reviewed_backward_compatibility_proof_required'
}>

export type IncompatibleStorageTransition = TransitionBase & Readonly<{
  status: 'incompatible'
  classification: 'incompatible'
  reasons: readonly StorageTransitionReason[]
}>

export type StorageTransition =
  | RollbackSafeStorageTransition
  | BlockedStorageTransition
  | IncompatibleStorageTransition

export function classifyStorageTransition(priorValue: unknown, currentValue: unknown): StorageTransition {
  const prior = parseManifest(priorValue)
  const current = parseManifest(currentValue)
  if (!prior || !current) return incompatible(prior?.revision ?? null, current?.revision ?? null, ['manifest_invalid'])

  const reasons = new Set<StorageTransitionReason>()
  const introducedClasses = compareMigrations(prior.migrations, current.migrations, reasons)
  compareBindings(prior.bindings, current.bindings, introducedClasses, reasons)
  if (canonicalJson(prior.dependencies) !== canonicalJson(current.dependencies)) reasons.add('codec_drift')
  const introducedDdlObjects = compareRegions(prior.regions, current.regions, introducedClasses, reasons)

  const storageSurfaceUnchanged = canonicalJson({
    migrations: prior.migrations,
    bindings: prior.bindings,
    dependencies: prior.dependencies,
    regions: prior.regions,
  }) === canonicalJson({
    migrations: current.migrations,
    bindings: current.bindings,
    dependencies: current.dependencies,
    regions: current.regions,
  })
  if (storageSurfaceUnchanged && prior.revision === current.revision) {
    return rollbackSafe(prior.revision, current.revision)
  }
  if (storageSurfaceUnchanged) reasons.add('revision_changed_without_compatible_delta')
  if (introducedDdlObjects.length > 0 && prior.revision === current.revision) {
    reasons.add('ddl_added_without_revision_change')
  }
  // No changed persistence surface is rollback-safe until a separate, reviewed
  // backward-compatibility proof contract exists. In particular, syntactically
  // additive SQL can still make an N-1 Worker unable to operate on changed state.
  return Object.freeze({
    schema: PRODUCTION_STORAGE_TRANSITION_SCHEMA,
    status: 'blocked',
    classification: 'storage-surface-changed',
    priorRevision: prior.revision,
    currentRevision: current.revision,
    introducedClasses: Object.freeze(introducedClasses),
    introducedDdlObjects: Object.freeze(introducedDdlObjects),
    reasons: Object.freeze([...reasons].sort()),
    reason: 'reviewed_backward_compatibility_proof_required',
  })
}

function compareMigrations(
  prior: readonly Migration[],
  current: readonly Migration[],
  reasons: Set<StorageTransitionReason>,
): string[] {
  if (current.length < prior.length) {
    reasons.add('migration_history_rewritten')
    return []
  }
  for (let index = 0; index < prior.length; index += 1) {
    if (canonicalJson(prior[index]) !== canonicalJson(current[index])) reasons.add('migration_history_rewritten')
  }
  const introduced: string[] = []
  for (const migration of current.slice(prior.length)) {
    const keys = Object.keys(migration).sort()
    if (keys.some((key) => key === 'deleted_classes' || key === 'renamed_classes')) {
      reasons.add('class_lifecycle_destructive')
    }
    if (keys.includes('new_classes')) reasons.add('legacy_durable_object_migration')
    if (keys.some((key) => !['tag', 'new_sqlite_classes'].includes(key))) {
      if (!keys.some((key) => ['deleted_classes', 'renamed_classes', 'new_classes'].includes(key))) {
        reasons.add('migration_history_rewritten')
      }
      continue
    }
    const classes = migration.new_sqlite_classes
    if (!Array.isArray(classes) || classes.length === 0
      || !classes.every(validClassName) || new Set(classes).size !== classes.length) {
      reasons.add('migration_history_rewritten')
      continue
    }
    introduced.push(...classes)
  }
  if (new Set(introduced).size !== introduced.length) reasons.add('migration_history_rewritten')
  return introduced.sort()
}

function compareBindings(
  prior: readonly Binding[],
  current: readonly Binding[],
  introducedClasses: readonly string[],
  reasons: Set<StorageTransitionReason>,
): void {
  const priorByName = new Map(prior.map((binding) => [binding.name, binding]))
  const currentByName = new Map(current.map((binding) => [binding.name, binding]))
  for (const [name, binding] of priorByName) {
    const observed = currentByName.get(name)
    if (!observed || observed.className !== binding.className) reasons.add('binding_removed_or_remapped')
  }
  const addedClasses = current
    .filter(({ name }) => !priorByName.has(name))
    .map(({ className }) => className)
    .sort()
  if (introducedClasses.length === 0 && addedClasses.length > 0) {
    reasons.add('binding_added_without_sqlite_class_migration')
  } else if (canonicalJson(addedClasses) !== canonicalJson([...introducedClasses].sort())) {
    reasons.add('new_sqlite_class_inventory_mismatch')
  }
}

function compareRegions(
  prior: readonly Region[],
  current: readonly Region[],
  introducedClasses: readonly string[],
  reasons: Set<StorageTransitionReason>,
): string[] {
  const introduced = new Set(introducedClasses)
  const priorByClass = new Map(prior.map((region) => [region.className, region]))
  const currentByClass = new Map(current.map((region) => [region.className, region]))
  const addedObjects: string[] = []
  for (const [className, priorRegion] of priorByClass) {
    const currentRegion = currentByClass.get(className)
    if (!currentRegion) {
      reasons.add('schema_region_removed')
      continue
    }
    if (priorRegion.sourceFile !== currentRegion.sourceFile
      || priorRegion.startMarker !== currentRegion.startMarker
      || priorRegion.endMarker !== currentRegion.endMarker) reasons.add('schema_region_identity_changed')
    let oldDdlMatches = currentRegion.ddl.length >= priorRegion.ddl.length
    for (let index = 0; index < priorRegion.ddl.length; index += 1) {
      if (canonicalJson(priorRegion.ddl[index]) !== canonicalJson(currentRegion.ddl[index])) oldDdlMatches = false
    }
    if (!oldDdlMatches) {
      reasons.add('old_ddl_changed_or_reordered')
      continue
    }
    const additions = currentRegion.ddl.slice(priorRegion.ddl.length)
    for (const ddl of additions) {
      if (!SAFE_ADDITIVE_DDL.test(ddl.object)) reasons.add('unsafe_ddl_added')
      addedObjects.push(`${className}:${ddl.object}`)
    }
    const ddlUnchanged = additions.length === 0
    if (ddlUnchanged && (priorRegion.sourceSha256 !== currentRegion.sourceSha256
      || priorRegion.regionSha256 !== currentRegion.regionSha256)) reasons.add('codec_drift')
  }
  for (const region of current) {
    if (priorByClass.has(region.className)) continue
    if (!introduced.has(region.className)) reasons.add('schema_region_added_without_sqlite_class_migration')
    for (const ddl of region.ddl) {
      if (!SAFE_ADDITIVE_DDL.test(ddl.object)) reasons.add('unsafe_ddl_added')
    }
  }
  return addedObjects.sort()
}

function parseManifest(value: unknown): Manifest | null {
  try {
    const manifest = object(value)
    const wrangler = object(manifest.wrangler)
    const migrations = array(wrangler.migrations).map((entry) => {
      const migration = object(entry)
      if (typeof migration.tag !== 'string' || !/^v[1-9][0-9]*$/u.test(migration.tag)) throw new Error('invalid_tag')
      return Object.freeze({ ...migration })
    })
    const bindings = array(wrangler.productionDurableObjectBindings).map((entry) => {
      const binding = object(entry)
      return Object.freeze({ name: nonempty(binding.name), className: className(binding.class_name) })
    }).sort(compareNamed)
    const dependencies = array(manifest.persistenceDependencies).map((entry) => {
      const dependency = object(entry)
      return Object.freeze({
        sourceFile: nonempty(dependency.sourceFile),
        purpose: nonempty(dependency.purpose),
        sourceSha256: digest(dependency.sourceSha256),
      })
    }).sort(compareSource)
    const regions = array(manifest.schemaRegions).map((entry) => parseRegion(entry)).sort(compareClass)
    exactUnique(bindings.map(({ name }) => name))
    exactUnique(bindings.map(({ className: name }) => name))
    exactUnique(dependencies.map(({ sourceFile }) => sourceFile))
    exactUnique(regions.map(({ className: name }) => name))
    return Object.freeze({
      revision: digest(manifest.revision),
      migrations: Object.freeze(migrations),
      bindings: Object.freeze(bindings),
      dependencies: Object.freeze(dependencies),
      regions: Object.freeze(regions),
    })
  } catch {
    return null
  }
}

function parseRegion(value: unknown): Region {
  const region = object(value)
  const ddl = array(region.ddl).map((entry) => {
    const statement = object(entry)
    return Object.freeze({ object: nonempty(statement.object), sha256: digest(statement.sha256) })
  })
  exactUnique(ddl.map(({ object: name }) => name))
  return Object.freeze({
    className: className(region.className),
    sourceFile: nonempty(region.sourceFile),
    sourceSha256: digest(region.sourceSha256),
    startMarker: nonempty(region.startMarker),
    endMarker: nonempty(region.endMarker),
    regionSha256: digest(region.regionSha256),
    ddl: Object.freeze(ddl),
  })
}

function rollbackSafe(priorRevision: string, currentRevision: string): RollbackSafeStorageTransition {
  return Object.freeze({
    schema: PRODUCTION_STORAGE_TRANSITION_SCHEMA,
    status: 'rollback-safe',
    classification: 'unchanged',
    priorRevision,
    currentRevision,
    introducedDdlObjects: Object.freeze([]),
  })
}

function incompatible(
  priorRevision: string | null,
  currentRevision: string | null,
  reasons: readonly StorageTransitionReason[],
): IncompatibleStorageTransition {
  return Object.freeze({
    schema: PRODUCTION_STORAGE_TRANSITION_SCHEMA,
    status: 'incompatible',
    classification: 'incompatible',
    priorRevision,
    currentRevision,
    reasons: Object.freeze([...new Set(reasons)].sort()),
  })
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object_required')
  return value as JsonObject
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('array_required')
  return value
}

function nonempty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('nonempty_text_required')
  return value
}

function className(value: unknown): string {
  const result = nonempty(value)
  if (!validClassName(result)) throw new Error('class_name_invalid')
  return result
}

function validClassName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,127}$/u.test(value)
}

function digest(value: unknown): string {
  const result = nonempty(value)
  if (!SHA256_PATTERN.test(result)) throw new Error('sha256_required')
  return result
}

function exactUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error('duplicate_inventory_entry')
}

function compareNamed(left: Binding, right: Binding): number {
  return left.name.localeCompare(right.name)
}

function compareSource(left: Dependency, right: Dependency): number {
  return left.sourceFile.localeCompare(right.sourceFile)
}

function compareClass(left: Region, right: Region): number {
  return left.className.localeCompare(right.className)
}

function readJson(filePath: string): unknown {
  const descriptor = fs.openSync(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAXIMUM_MANIFEST_BYTES) throw new Error('manifest_file_size_invalid')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor))) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

async function main(): Promise<void> {
  const [command, priorPath, currentPath] = process.argv.slice(2)
  let result: StorageTransition
  if (command === 'compare-root' && priorPath && currentPath) {
    result = classifyStorageTransition(
      validateStorageCompatibility(path.resolve(priorPath)),
      validateStorageCompatibility(path.resolve(currentPath)),
    )
  } else if (command === 'compare-json' && priorPath && currentPath) {
    result = classifyStorageTransition(readJson(priorPath), readJson(currentPath))
  } else {
    throw new Error('usage: storage-transition.ts compare-root|compare-json <prior> <current>')
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'rollback-safe') process.exitCode = result.status === 'blocked' ? 2 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'storage_transition_unknown_error'}\n`)
    process.exitCode = 1
  })
}
