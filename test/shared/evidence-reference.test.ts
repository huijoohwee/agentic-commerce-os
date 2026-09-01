import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { deriveRung, emitReferences, type CheckResult } from '../../scripts/evidence-reference.ts'

describe('execution evidence references', () => {
  it('emits exactly the checks that ran and passed', () => {
    fc.assert(fc.property(
      fc.array(checkResultArbitrary, { maxLength: 100 }),
      results => {
        const references = emitReferences(results)
        expect(references.map(({ namedCheck }) => namedCheck)).toEqual(
          results.filter(({ ran, passed }) => ran && passed).map(({ namedCheck }) => namedCheck),
        )
      },
    ), { numRuns: 200, seed: 20_260_829 })
  })

  it('never advances while a finding is open', () => {
    fc.assert(fc.property(
      fc.array(checkResultArbitrary, { maxLength: 50 }),
      fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 1, maxLength: 10 }),
      (results, findings) => {
        expect(deriveRung(emitReferences(results), findings)).toMatchObject({
          localRung: 'blocked',
          deliveredRung: 'not-delivered',
          blocked: true,
        })
      },
    ), { numRuns: 200, seed: 20_260_830 })
  })
})

const checkResultArbitrary: fc.Arbitrary<CheckResult> = fc.record({
  namedCheck: fc.string({ minLength: 1, maxLength: 80 }),
  ran: fc.boolean(),
  passed: fc.boolean(),
  recordedResult: fc.string({ maxLength: 120 }),
  readableSurface: fc.string({ minLength: 1, maxLength: 120 }),
})
