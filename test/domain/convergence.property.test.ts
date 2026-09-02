import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import {
  declaredRequirements,
  evaluateConvergence,
} from '../../src/core/convergence-evaluator.ts'
import {
  digestUpstreamRuntimeEvidence,
  UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
} from '../../src/core/upstream-evidence.ts'

const REQUIRED = Object.freeze(['alpha', 'beta', 'gamma'])
const SOURCE = 'a'.repeat(40)
const STORAGE = 'storage/v1'
const VERSION = 'provider-v1'

// Feature: agentic-graph-commerce-platform, Property 2: Surplus never blocks, deficit always blocks
test('convergence accepts surplus and blocks deficits', async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/u), { maxLength: 8 }),
    fc.boolean(),
    async (generated, omitRequired) => {
      const surplus = generated.filter((name) => !REQUIRED.includes(name)).sort()
      const names = [...(omitRequired ? REQUIRED.slice(1) : REQUIRED), ...surplus]
      const envelope = await validEnvelope(names)
      const declared = declaredRequirements('provider', 'contract/v1', REQUIRED, envelope.pin)
      const verdict = await evaluateConvergence(envelope.value, declared)
      if (omitRequired) {
        assert.equal(verdict.state, 'blocked')
        assert.deepEqual(verdict.requiredAbsentOrFailing, ['alpha'])
      } else {
        assert.equal(verdict.state, surplus.length > 0 ? 'converged-with-surplus' : 'converged')
        assert.deepEqual(verdict.surplusChecks, surplus)
      }
    },
  ), { numRuns: 500, seed: 20_260_902 })
})

// Feature: agentic-graph-commerce-platform, Property 3: Verdict determinism
test('convergence returns the identical verdict for identical evidence', async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/u), { maxLength: 8 }),
    fc.boolean(),
    async (generated, omitRequired) => {
      const surplus = generated.filter((name) => !REQUIRED.includes(name)).sort()
      const names = [...(omitRequired ? REQUIRED.slice(1) : REQUIRED), ...surplus]
      const envelope = await validEnvelope(names)
      const declared = declaredRequirements('provider', 'contract/v1', REQUIRED, envelope.pin)
      assert.deepEqual(
        await evaluateConvergence(envelope.value, declared),
        await evaluateConvergence(envelope.value, declared),
      )
    },
  ), { numRuns: 300, seed: 20_260_903 })
})

// Feature: agentic-graph-commerce-platform, Property 4: Forward-compatible revision and identity blocking
test('convergence accepts only forward-compatible revisions with exact pinned identities', async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({
      major: fc.integer({ min: 0, max: 2 }),
      minor: fc.integer({ min: 0, max: 8 }),
      patch: fc.integer({ min: 0, max: 8 }),
    }),
    fc.option(fc.constantFrom(
      'sourceRevision',
      'receiptDigest',
      'storageCompatibilityRevision',
      'providerVersionId',
    ), { nil: null }),
    async (revision, identityMutation) => {
      const advertisedRevision = `${revision.major}.${revision.minor}.${revision.patch}`
      const envelope = await validEnvelope(REQUIRED, advertisedRevision)
      const evidence = identityMutation === null
        ? envelope.value.evidence
        : { ...envelope.value.evidence, [identityMutation]: replacement(identityMutation) }
      const verdict = await evaluateConvergence(
        { ...envelope.value, evidence },
        declaredRequirements('provider', 'contract/v1', REQUIRED, envelope.pin),
      )
      const compatible = revision.major === 0 && revision.minor >= 3
      assert.equal(verdict.state !== 'blocked', compatible && identityMutation === null)
    },
  ), { numRuns: 400, seed: 20_260_904 })
})

test('convergence tolerates unnamed envelope fields without weakening identity binding', async () => {
  const envelope = await validEnvelope(REQUIRED)
  const value = {
    ...envelope.value,
    futureOuter: true,
    evidence: { ...envelope.value.evidence, futureEvidence: 'retained' },
  }
  const verdict = await evaluateConvergence(
    value,
    declaredRequirements('provider', 'contract/v1', REQUIRED, envelope.pin),
  )
  assert.equal(verdict.state, 'converged')
  assert.equal(verdict.unnamedEnvelopeFieldCount, 2)
})

async function validEnvelope(names: readonly string[], prdRevision = '0.4.0') {
  const checks = names.map((name) => Object.freeze({ name, ok: true }))
  const digestInput = Object.freeze({
    schema: UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
    prdRevision,
    sourceRevision: SOURCE,
    storageCompatibilityRevision: STORAGE,
    providerVersionId: VERSION,
    checks,
  })
  const receiptDigest = await digestUpstreamRuntimeEvidence(digestInput)
  return Object.freeze({
    pin: Object.freeze({ sourceRevision: SOURCE, receiptDigest, storageCompatibilityRevision: STORAGE, providerVersionId: VERSION }),
    value: Object.freeze({
      ok: true,
      contract: 'contract/v1',
      evidence: Object.freeze({ ...digestInput, receiptDigest }),
    }),
  })
}

function replacement(field: string): string {
  if (field === 'sourceRevision') return 'b'.repeat(40)
  if (field === 'receiptDigest') return 'b'.repeat(64)
  if (field === 'storageCompatibilityRevision') return 'storage/v2'
  return 'provider-v2'
}
