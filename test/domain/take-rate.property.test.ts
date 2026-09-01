import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import { computeMarkupMinor, MAXIMUM_RATE_BASIS_POINTS } from '../../src/core/take-rate.ts'

// Feature: agentic-graph-commerce-platform, Property 5: Markup arithmetic and non-interference
test('take-rate arithmetic is integer, half-up, bounded, and deterministic', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 10_000_000_000 }),
    fc.integer({ min: 1, max: MAXIMUM_RATE_BASIS_POINTS }),
    (amount, rate) => {
      const result = computeMarkupMinor(amount, rate)
      const expected = Number((BigInt(amount) * BigInt(rate) + 5_000n) / 10_000n)
      assert.equal(result, expected)
      assert.equal(result, computeMarkupMinor(amount, rate))
      assert.ok(result >= 0 && result <= amount)
      assert.equal(Number.isInteger(result), true)
    },
  ), { numRuns: 500, seed: 20_260_905 })
})
