import assert from 'node:assert/strict'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  materializeStorageManifest,
  validateStorageCompatibility,
} from '../../scripts/validate-do-storage-compatibility.ts'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE_FILES = Object.freeze([
  'docs/do-storage-compatibility.json',
  'wrangler.core.jsonc',
  'src/core/agent-registry.ts',
  'src/core/intent-route.ts',
  'src/core/checkout-session.ts',
  'src/core/revenue-ledger.ts',
  'src/core/theme-deployment-store.ts',
  'src/core/authoring-claim.ts',
  'src/shared/digest.ts',
  'src/shared/theme-manifest.ts',
  'src/core/acos-admission.ts',
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
  'src/domain/exclusive-category-router.ts',
  'src/domain/selection-policy.ts',
  'src/core/core-actions.ts',
  'src/core/checkout-input.ts',
  'src/domain/authoring-claim-policy.ts',
])

function createFixture(context: TestContext, prefix: string): string {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), prefix))
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  for (const relativePath of FIXTURE_FILES) {
    const destination = path.join(fixtureRoot, relativePath)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(path.join(REPOSITORY_ROOT, relativePath), destination)
  }
  return fixtureRoot
}

test('the checked-in Durable Object storage manifest matches the executable persistence surface', () => {
  const manifest = validateStorageCompatibility(REPOSITORY_ROOT)
  assert.match(manifest.revision, /^[0-9a-f]{64}$/u)
})

test('a schema-region DDL change blocks the old revision and produces a new revision', (context) => {
  const fixtureRoot = createFixture(context, 'commerce-do-storage-')
  const original = validateStorageCompatibility(fixtureRoot)
  const registryPath = path.join(fixtureRoot, 'src/core/agent-registry.ts')
  const registrySource = readFileSync(registryPath, 'utf8')
  const changedSource = registrySource.replace(
    'decision_json TEXT NOT NULL,',
    'decision_json TEXT NOT NULL CHECK (length(decision_json) > 0),',
  )
  assert.notEqual(changedSource, registrySource)
  writeFileSync(registryPath, changedSource)
  assert.throws(
    () => validateStorageCompatibility(fixtureRoot),
    /storage manifest does not match executable schema/iu,
  )
  const manifestPath = path.join(fixtureRoot, 'docs/do-storage-compatibility.json')
  const template = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const changed = materializeStorageManifest(fixtureRoot, template)
  assert.notEqual(changed.revision, original.revision)
  writeFileSync(manifestPath, `${JSON.stringify(changed, null, 2)}\n`)
  assert.equal(validateStorageCompatibility(fixtureRoot).revision, changed.revision)
})

test('a non-DDL persistence codec change blocks the old revision', (context) => {
  const fixtureRoot = createFixture(context, 'commerce-do-codec-')
  const original = validateStorageCompatibility(fixtureRoot)
  const routePath = path.join(fixtureRoot, 'src/core/intent-route.ts')
  const routeSource = readFileSync(routePath, 'utf8')
  const changedSource = routeSource.replace('canonicalJson(result),', 'JSON.stringify(result),')
  assert.notEqual(changedSource, routeSource)
  writeFileSync(routePath, changedSource)
  assert.throws(
    () => validateStorageCompatibility(fixtureRoot),
    /storage manifest does not match executable schema/iu,
  )
  const template = JSON.parse(readFileSync(path.join(fixtureRoot, 'docs/do-storage-compatibility.json'), 'utf8'))
  const changed = materializeStorageManifest(fixtureRoot, template)
  const originalRegion = original.schemaRegions.find(({ className }) => className === 'IntentRoute')
  const changedRegion = changed.schemaRegions.find(({ className }) => className === 'IntentRoute')
  assert.deepEqual(changedRegion?.ddl, originalRegion?.ddl)
  assert.notEqual(changedRegion?.sourceSha256, originalRegion?.sourceSha256)
  assert.notEqual(changed.revision, original.revision)
})

test('an imported persistence codec change blocks the old revision', (context) => {
  const fixtureRoot = createFixture(context, 'commerce-do-dependency-')
  const original = validateStorageCompatibility(fixtureRoot)
  const digestPath = path.join(fixtureRoot, 'src/shared/digest.ts')
  const digestSource = readFileSync(digestPath, 'utf8')
  const changedSource = digestSource.replace(
    'return JSON.stringify(canonicalValue(value))',
    'return JSON.stringify(value)',
  )
  assert.notEqual(changedSource, digestSource)
  writeFileSync(digestPath, changedSource)
  assert.throws(
    () => validateStorageCompatibility(fixtureRoot),
    /storage manifest does not match executable schema/iu,
  )
  const manifestPath = path.join(fixtureRoot, 'docs/do-storage-compatibility.json')
  const template = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const changed = materializeStorageManifest(fixtureRoot, template)
  assert.deepEqual(changed.schemaRegions, original.schemaRegions)
  const originalDependency = original.persistenceDependencies.find(
    ({ sourceFile }) => sourceFile === 'src/shared/digest.ts',
  )
  const changedDependency = changed.persistenceDependencies.find(
    ({ sourceFile }) => sourceFile === 'src/shared/digest.ts',
  )
  assert.notEqual(changedDependency?.sourceSha256, originalDependency?.sourceSha256)
  assert.notEqual(changed.revision, original.revision)
})
