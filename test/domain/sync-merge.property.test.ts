import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import {
  EMPTY_MERGED_STATE,
  mergeSequences,
  type FieldChange,
} from '../../src/core/sync-merge.ts'

const changeArbitrary: fc.Arbitrary<FieldChange> = fc.record({
  scope: fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u),
  field: fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u),
  value: fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 20 })),
  origin: fc.record({
    deviceId: fc.uuid(),
    sequence: fc.nat({ max: 10_000 }),
    recordedAtMs: fc.nat({ max: 10_000_000 }),
  }),
})

// Feature: agentic-graph-commerce-platform, Property 17: Merge confluence
test('sync merge is commutative and retains the union event log', () => {
  fc.assert(fc.property(
    fc.array(changeArbitrary, { minLength: 1, maxLength: 10 }),
    fc.array(changeArbitrary, { minLength: 1, maxLength: 10 }),
    (left, right) => {
      const leftFirst = mergeSequences(EMPTY_MERGED_STATE, left, right)
      const rightFirst = mergeSequences(EMPTY_MERGED_STATE, right, left)
      assert.deepEqual(leftFirst, rightFirst)
      assert.ok(leftFirst.eventLog.length >= Math.max(left.length, right.length))
    },
  ), { numRuns: 300, seed: 20_260_917 })
})
