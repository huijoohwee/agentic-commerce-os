import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import { diffObservation, type ObservedAttributes } from '../../src/core/offer-watch.ts'

const observationArbitrary: fc.Arbitrary<ObservedAttributes> = fc.record({
  priceMinor: fc.nat({ max: 10_000_000 }),
  available: fc.boolean(),
  agentActive: fc.boolean(),
})

test('offer diff emits exactly one event per changed attribute and none for a repeated value', () => {
  fc.assert(fc.property(observationArbitrary, observationArbitrary, (recorded, observed) => {
    const events = diffObservation(recorded, observed, '2026-08-29T00:00:00.000Z')
    const changedCount = Number(recorded.priceMinor !== observed.priceMinor)
      + Number(recorded.available !== observed.available)
      + Number(recorded.agentActive !== observed.agentActive)
    assert.equal(events.length, changedCount)
    assert.equal(new Set(events.map(({ attribute }) => attribute)).size, events.length)
    assert.deepEqual(diffObservation(observed, observed), [])
  }), { numRuns: 300 })
})
