import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { deriveRung, emitReferences, type CheckResult } from '../../scripts/evidence-reference.ts'

describe('Feature: agentic-graph-commerce-platform, evidence rung property', () => {
  it('is a pure projection of surfaced results and findings', () => {
    fc.assert(fc.property(
      fc.array(resultArbitrary, { maxLength: 80 }),
      fc.array(fc.string({ minLength: 1, maxLength: 80 }), { maxLength: 10 }),
      (results, findings) => {
        const references = emitReferences(results)
        const first = deriveRung(references, findings)
        const second = deriveRung(references, findings)
        expect(second).toEqual(first)
        expect(references).toHaveLength(results.filter(({ ran, passed }) => ran && passed).length)
        if (findings.length > 0) expect(first.blocked).toBe(true)
      },
    ), { numRuns: 300, seed: 20_260_831 })
  })
})

const resultArbitrary: fc.Arbitrary<CheckResult> = fc.record({
  namedCheck: fc.string({ minLength: 1, maxLength: 80 }),
  ran: fc.boolean(),
  passed: fc.boolean(),
  recordedResult: fc.string({ maxLength: 120 }),
  readableSurface: fc.string({ minLength: 1, maxLength: 120 }),
})
