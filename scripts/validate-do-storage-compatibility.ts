import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST_SCHEMA = 'commerce-do-storage-compatibility/v1'
const COMPATIBILITY_POLICY = 'exact-persistence-surface'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REQUIRED_PERSISTENCE_DEPENDENCIES = Object.freeze([
  'src/shared/digest.ts',
  'src/core/acos-admission.ts',
  'src/core/acos-deployment-identity.ts',
  'src/core/agent-registry-record.ts',
  'src/core/authoring-mutation-fence.ts',
  'src/core/checkout-receipts.ts',
  'src/core/checkout-state.ts',
  'src/core/checkout-finalization.ts',
  'src/core/checkout-markup.ts',
  'src/core/checkout-provider-client.ts',
  'src/core/discovery-receipt.ts',
  'src/core/offer-watch.ts',
  'src/core/take-rate.ts',
  'src/core/theme-deployment.ts',
  'src/shared/theme-manifest.ts',
  'src/domain/exclusive-category-router.ts',
  'src/domain/selection-policy.ts',
  'src/core/core-actions.ts',
  'src/core/checkout-input.ts',
  'src/domain/authoring-claim-policy.ts',
].sort())

type JsonObject = Readonly<Record<string, unknown>>

type DdlEntry = Readonly<{
  object: string
  sha256: string
}>

type SchemaRegion = Readonly<{
  className: string
  sourceFile: string
  sourceSha256: string
  startMarker: string
  endMarker: string
  regionSha256: string
  ddl: readonly DdlEntry[]
}>

type PersistenceDependency = Readonly<{
  sourceFile: string
  purpose: string
  sourceSha256: string
}>

type StorageManifest = Readonly<{
  $schema: string
  version: number
  compatibilityPolicy: string
  wrangler: Readonly<{
    configFile: string
    migrations: readonly JsonObject[]
    productionDurableObjectBindings: readonly JsonObject[]
  }>
  persistenceDependencies: readonly PersistenceDependency[]
  schemaRegions: readonly SchemaRegion[]
  revision: string
}>

export function validateStorageCompatibility(
  rootDirectory: string,
  manifestPath = 'docs/do-storage-compatibility.json',
): StorageManifest {
  const manifest = readManifest(rootDirectory, manifestPath)
  const observed = materializeStorageManifest(rootDirectory, manifest)
  assert.deepEqual(manifest, observed, 'Durable Object storage manifest does not match executable schema')
  return manifest
}

export function materializeStorageManifest(
  rootDirectory: string,
  template: StorageManifest,
): StorageManifest {
  validateTemplate(template)
  const wranglerPath = resolveInside(rootDirectory, template.wrangler.configFile)
  const wrangler = JSON.parse(fs.readFileSync(wranglerPath, 'utf8')) as JsonObject
  const migrations = readArray(wrangler.migrations, 'wrangler migrations') as readonly JsonObject[]
  const environments = readObject(wrangler.env, 'wrangler environments')
  const production = readObject(environments.production, 'Production environment')
  const durableObjects = readObject(production.durable_objects, 'Production Durable Objects')
  const bindings = readArray(durableObjects.bindings, 'Production Durable Object bindings') as readonly JsonObject[]
  const regions = template.schemaRegions.map((region) => observeRegion(rootDirectory, region))
  const dependencies = template.persistenceDependencies.map((dependency) => Object.freeze({
    sourceFile: dependency.sourceFile,
    purpose: dependency.purpose,
    sourceSha256: sha256(fs.readFileSync(resolveInside(rootDirectory, dependency.sourceFile))),
  }))
  const boundClasses = bindings.map((binding) => readString(binding.class_name, 'Durable Object class')).sort()
  assert.deepEqual(
    regions.map(({ className }) => className).sort(),
    boundClasses,
    'Every Production Durable Object class must have exactly one schema region',
  )
  const payload = Object.freeze({
    $schema: template.$schema,
    version: template.version,
    compatibilityPolicy: template.compatibilityPolicy,
    wrangler: Object.freeze({
      configFile: template.wrangler.configFile,
      migrations: Object.freeze(migrations),
      productionDurableObjectBindings: Object.freeze(bindings),
    }),
    persistenceDependencies: Object.freeze(dependencies),
    schemaRegions: Object.freeze(regions),
  })
  return Object.freeze({
    ...payload,
    revision: sha256(canonicalJson(payload)),
  })
}

function observeRegion(rootDirectory: string, expected: SchemaRegion): SchemaRegion {
  const sourcePath = resolveInside(rootDirectory, expected.sourceFile)
  const sourceBytes = fs.readFileSync(sourcePath)
  const source = new TextDecoder().decode(sourceBytes)
  const start = source.indexOf(expected.startMarker)
  assert.notEqual(start, -1, `Missing schema start marker in ${expected.sourceFile}`)
  assert.equal(source.indexOf(expected.startMarker, start + 1), -1, `Duplicate schema start marker in ${expected.sourceFile}`)
  const end = source.indexOf(expected.endMarker, start + expected.startMarker.length)
  assert.notEqual(end, -1, `Missing schema end marker in ${expected.sourceFile}`)
  assert.equal(source.indexOf(expected.endMarker, end + 1), -1, `Duplicate schema end marker in ${expected.sourceFile}`)
  const region = source.slice(start, end)
  const fileDdl = extractDdl(source, expected.sourceFile)
  const regionDdl = extractDdl(region, expected.sourceFile)
  assert.deepEqual(regionDdl, fileDdl, `DDL exists outside the declared schema region in ${expected.sourceFile}`)
  return Object.freeze({
    className: expected.className,
    sourceFile: expected.sourceFile,
    sourceSha256: sha256(sourceBytes),
    startMarker: expected.startMarker,
    endMarker: expected.endMarker,
    regionSha256: sha256(normalizeWhitespace(region)),
    ddl: Object.freeze(regionDdl.map((statement) => Object.freeze({
      object: ddlObject(statement),
      sha256: sha256(statement),
    }))),
  })
}

function extractDdl(source: string, sourceFile: string): readonly string[] {
  const statements: string[] = []
  const expression = /#sql\.exec(?:<[^>]+>)?\(\s*([`'"])([\s\S]*?)\1/gu
  for (const match of source.matchAll(expression)) {
    const statement = normalizeWhitespace(match[2] ?? '').replace(/;$/u, '')
    if (/^(?:CREATE|ALTER|DROP)\s/iu.test(statement)) {
      statements.push(statement)
    }
  }
  assert.ok(statements.length > 0, `No static DDL found in ${sourceFile}`)
  assert.equal(new Set(statements).size, statements.length, `Duplicate DDL found in ${sourceFile}`)
  return Object.freeze(statements)
}

function ddlObject(statement: string): string {
  const patterns: readonly [RegExp, (match: RegExpMatchArray) => string][] = [
    [/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\b/iu, (match) => `table:${match[1]}`],
    [/^CREATE\s+VIRTUAL\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\b/iu, (match) => `virtual-table:${match[1]}`],
    [/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\b/iu, (match) => `index:${match[1]}`],
    [/^CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\b/iu, (match) => `trigger:${match[1]}`],
    [/^CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\b/iu, (match) => `view:${match[1]}`],
    [/^ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)\b/iu, (match) => `alter:${match[1]}:add-column:${match[2]}`],
    [/^DROP\s+(?:TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\b/iu, (match) => `drop:${match[1]}`],
  ]
  for (const [pattern, format] of patterns) {
    const match = statement.match(pattern)
    if (match) return format(match)
  }
  throw new Error(`Unsupported DDL statement: ${statement}`)
}

function validateTemplate(manifest: StorageManifest): void {
  assert.equal(manifest.$schema, MANIFEST_SCHEMA)
  assert.equal(manifest.version, 2)
  assert.equal(manifest.compatibilityPolicy, COMPATIBILITY_POLICY)
  assert.equal(manifest.wrangler.configFile, 'wrangler.core.jsonc')
  assert.ok(Array.isArray(manifest.persistenceDependencies))
  assert.deepEqual(
    manifest.persistenceDependencies.map(({ sourceFile }) => sourceFile).sort(),
    REQUIRED_PERSISTENCE_DEPENDENCIES,
    'Persistence dependency inventory must match the reviewed minimal set',
  )
  for (const dependency of manifest.persistenceDependencies) {
    assert.ok(dependency.sourceFile.startsWith('src/') && dependency.sourceFile.endsWith('.ts'))
    assert.ok(dependency.purpose.trim().length > 0)
    assert.match(dependency.sourceSha256, SHA256_PATTERN)
  }
  assert.ok(Array.isArray(manifest.schemaRegions) && manifest.schemaRegions.length > 0)
  assert.match(manifest.revision, SHA256_PATTERN)
  for (const region of manifest.schemaRegions) {
    assert.ok(region.className.length > 0)
    assert.ok(region.sourceFile.startsWith('src/core/') && region.sourceFile.endsWith('.ts'))
    assert.match(region.sourceSha256, SHA256_PATTERN)
    assert.ok(region.startMarker.length > 0 && region.endMarker.length > 0)
    assert.match(region.regionSha256, SHA256_PATTERN)
    assert.ok(Array.isArray(region.ddl) && region.ddl.length > 0)
    for (const entry of region.ddl) {
      assert.ok(entry.object.length > 0)
      assert.match(entry.sha256, SHA256_PATTERN)
    }
  }
}

function readManifest(rootDirectory: string, manifestPath: string): StorageManifest {
  return JSON.parse(fs.readFileSync(resolveInside(rootDirectory, manifestPath), 'utf8')) as StorageManifest
}

function resolveInside(rootDirectory: string, relativePath: string): string {
  assert.ok(!path.isAbsolute(relativePath), 'Manifest paths must be relative')
  const root = path.resolve(rootDirectory)
  const resolved = path.resolve(root, relativePath)
  assert.ok(resolved.startsWith(`${root}${path.sep}`), `Manifest path escapes repository: ${relativePath}`)
  return resolved
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value as Record<string, unknown>
}

function readArray(value: unknown, label: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`)
  return value
}

function readString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  return value as string
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function main(): void {
  const arguments_ = process.argv.slice(2)
  const rootIndex = arguments_.indexOf('--root')
  const manifestIndex = arguments_.indexOf('--manifest')
  const rootDirectory = rootIndex === -1 ? process.cwd() : arguments_[rootIndex + 1]
  const manifestPath = manifestIndex === -1 ? undefined : arguments_[manifestIndex + 1]
  assert.ok(rootDirectory, '--root requires a directory')
  if (arguments_.includes('--write')) {
    const resolvedManifestPath = manifestPath ?? 'docs/do-storage-compatibility.json'
    const template = readManifest(rootDirectory, resolvedManifestPath)
    const materialized = materializeStorageManifest(rootDirectory, template)
    fs.writeFileSync(resolveInside(rootDirectory, resolvedManifestPath), `${JSON.stringify(materialized, null, 2)}\n`)
    process.stdout.write(`${materialized.revision}\n`)
    return
  }
  const manifest = validateStorageCompatibility(rootDirectory, manifestPath)
  if (arguments_.includes('--json')) process.stdout.write(`${JSON.stringify(manifest)}\n`)
  else process.stdout.write(`${manifest.revision}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
