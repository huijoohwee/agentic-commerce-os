import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import {
  DEFAULT_SELECTION_POLICY,
  selectAgent,
  type DeclaredAttributes,
} from '../../src/domain/selection-policy.ts'

const attributesArbitrary = fc.record({
  priceMinor: fc.integer({ min: 0, max: 1_000_000 }),
  qualityScore: fc.integer({ min: 0, max: 100_000 }),
  latencyMs: fc.integer({ min: 0, max: 60_000 }),
})

// Feature: agentic-graph-commerce-platform, Property 15: Selection determinism and tie rule
test('selection is independent of input order and records every deciding attribute', () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.tuple(fc.uuid(), attributesArbitrary), { minLength: 1, maxLength: 20, selector: ([id]) => id }),
    (entries) => {
      const eligible = entries.map(([agentId, attributes]) => Object.freeze({ agentId, attributes }))
      const forward = selectAgent(eligible, DEFAULT_SELECTION_POLICY)
      const reverse = selectAgent([...eligible].reverse(), DEFAULT_SELECTION_POLICY)
      assert.deepEqual(forward, reverse)
      assert.equal(Object.keys(forward?.decidingAttributes ?? {}).length, eligible.length)
    },
  ), { numRuns: 300, seed: 20_260_915 })
})

// Feature: agentic-graph-commerce-platform, Property 15: Selection determinism and tie rule
test('score ties resolve by ascending agent identifier', () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 20 }),
    attributesArbitrary,
    (agentIds, attributes: DeclaredAttributes) => {
      const result = selectAgent(agentIds.map((agentId) => ({ agentId, attributes })), DEFAULT_SELECTION_POLICY)
      assert.equal(result?.selectedAgentId, [...agentIds].sort()[0])
    },
  ), { numRuns: 300, seed: 20_260_916 })
})
