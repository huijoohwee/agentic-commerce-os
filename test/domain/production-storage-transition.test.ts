import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyStorageTransition } from '../../scripts/production-release/storage-transition.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function manifest(): any {
  return JSON.parse(fs.readFileSync(`${ROOT}/docs/do-storage-compatibility.json`, 'utf8'))
}

test('An unchanged persistence surface is rollback-safe', () => {
  const prior = manifest()
  assert.deepEqual(classifyStorageTransition(prior, structuredClone(prior)), {
    schema: 'agentic-commerce-storage-transition/v1',
    status: 'rollback-safe',
    classification: 'unchanged',
    priorRevision: prior.revision,
    currentRevision: prior.revision,
    introducedDdlObjects: [],
  })
})

test('Runtime SQLite additions require an explicit reviewed backward-compatibility proof', () => {
  const prior = manifest()
  const current = structuredClone(prior)
  current.revision = 'a'.repeat(64)
  const region = current.schemaRegions.find(({ className }: any) => className === 'AgentRegistry')
  region.sourceSha256 = 'b'.repeat(64)
  region.regionSha256 = 'c'.repeat(64)
  region.ddl.push({ object: 'alter:agent_admission:add-column:new_flag', sha256: 'd'.repeat(64) })
  const result = classifyStorageTransition(prior, current)
  assert.equal(result.status, 'blocked')
  if (result.status === 'blocked') {
    assert.equal(result.classification, 'storage-surface-changed')
    assert.deepEqual(result.introducedDdlObjects,
      ['AgentRegistry:alter:agent_admission:add-column:new_flag'])
    assert.equal(result.reason, 'reviewed_backward_compatibility_proof_required')
  }
})

test('An appended new_sqlite_classes migration is a typed forward-only block', () => {
  const prior = manifest()
  const current = structuredClone(prior)
  current.revision = 'a'.repeat(64)
  current.wrangler.migrations.push({ tag: 'v6', new_sqlite_classes: ['NewLedger'] })
  current.wrangler.productionDurableObjectBindings.push({ name: 'NEW_LEDGER', class_name: 'NewLedger' })
  current.schemaRegions.push({
    className: 'NewLedger',
    sourceFile: 'src/core/new-ledger.ts',
    sourceSha256: 'b'.repeat(64),
    startMarker: 'start',
    endMarker: 'end',
    regionSha256: 'c'.repeat(64),
    ddl: [{ object: 'table:new_ledger', sha256: 'd'.repeat(64) }],
  })
  assert.deepEqual(classifyStorageTransition(prior, current), {
    schema: 'agentic-commerce-storage-transition/v1',
    status: 'blocked',
    classification: 'storage-surface-changed',
    priorRevision: prior.revision,
    currentRevision: current.revision,
    introducedClasses: ['NewLedger'],
    introducedDdlObjects: [],
    reasons: [],
    reason: 'reviewed_backward_compatibility_proof_required',
  })
})

test('DROP, rename/delete lifecycle changes, old DDL changes, and codec drift all fail closed', () => {
  const prior = manifest()
  const withDrop = structuredClone(prior)
  withDrop.revision = '1'.repeat(64)
  const dropRegion = withDrop.schemaRegions[0]
  dropRegion.sourceSha256 = '2'.repeat(64)
  dropRegion.regionSha256 = '3'.repeat(64)
  dropRegion.ddl.push({ object: 'drop:agent_admission', sha256: '4'.repeat(64) })
  assert.equal(classifyStorageTransition(prior, withDrop).status, 'blocked')

  const withRename = structuredClone(prior)
  withRename.revision = '5'.repeat(64)
  withRename.wrangler.migrations.push({
    tag: 'v6', renamed_classes: [{ from: 'AgentRegistry', to: 'RegistryRenamed' }],
  })
  const rename = classifyStorageTransition(prior, withRename)
  assert.equal(rename.status, 'blocked')
  if (rename.status === 'blocked') assert.ok(rename.reasons.includes('class_lifecycle_destructive'))

  const oldDdl = structuredClone(prior)
  oldDdl.revision = '6'.repeat(64)
  oldDdl.schemaRegions[0].ddl[0].sha256 = '7'.repeat(64)
  const oldDdlResult = classifyStorageTransition(prior, oldDdl)
  assert.equal(oldDdlResult.status, 'blocked')
  if (oldDdlResult.status === 'blocked') assert.ok(oldDdlResult.reasons.includes('old_ddl_changed_or_reordered'))

  const codec = structuredClone(prior)
  codec.revision = '8'.repeat(64)
  const identityCodec = codec.persistenceDependencies.find(
    ({ sourceFile }: any) => sourceFile === 'src/core/acos-deployment-identity.ts',
  )
  assert.ok(identityCodec)
  identityCodec.sourceSha256 = '9'.repeat(64)
  const codecResult = classifyStorageTransition(prior, codec)
  assert.equal(codecResult.status, 'blocked')
  if (codecResult.status === 'blocked') assert.ok(codecResult.reasons.includes('codec_drift'))
})
