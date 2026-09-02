import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  MAXIMUM_PENDING_CHANGES,
  createMemoryLocalStore,
  settlementBlockedOffline,
} from '../../src/edge/client/local-store'

describe('local-first storefront state', () => {
  // Feature: agentic-graph-commerce-platform, Property 18: Offline order preservation
  it('preserves origination order, the 500-change cap, and unacknowledged bytes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 520 }),
      fc.integer({ min: 0, max: MAXIMUM_PENDING_CHANGES }),
      async (changeCount, requestedAcknowledgements) => {
        const store = createMemoryLocalStore()
        const outcomes = []
        for (let index = 0; index < changeCount; index += 1) {
          outcomes.push(await store.recordChange({
            scope: 'draft',
            payload: { index },
            recordedAtMs: index,
          }))
        }
        const accepted = Math.min(changeCount, MAXIMUM_PENDING_CHANGES)
        expect(outcomes.filter(({ ok }) => ok)).toHaveLength(accepted)
        for (const refused of outcomes.slice(accepted)) {
          expect(refused).toEqual({
            ok: false,
            code: 'local_change_capacity_reached',
            retained: MAXIMUM_PENDING_CHANGES,
          })
        }

        const acknowledgementCount = Math.min(requestedAcknowledgements, accepted)
        const observed: number[] = []
        const replay = await store.replayOnReconnect(async ({ sequence }) => {
          observed.push(sequence)
          return sequence <= acknowledgementCount
        })
        const expectedSubmitted = Array.from(
          { length: Math.min(accepted, acknowledgementCount + 1) },
          (_, index) => index + 1,
        )
        const expectedAcknowledged = Array.from({ length: acknowledgementCount }, (_, index) => index + 1)
        const expectedRetained = Array.from(
          { length: accepted - acknowledgementCount },
          (_, index) => acknowledgementCount + index + 1,
        )
        expect(observed).toEqual(expectedSubmitted)
        expect(replay.acknowledgedSequences).toEqual(expectedAcknowledged)
        expect(replay.retainedSequences).toEqual(expectedRetained)
        expect(settlementBlockedOffline()).toEqual({ ok: false, code: 'connectivity_absent' })
      },
    ), { numRuns: 300, seed: 20_260_918 })
  })

  it('retains 500 ordered changes and refuses capacity without dropping prior bytes', async () => {
    const store = createMemoryLocalStore()
    for (let index = 0; index < MAXIMUM_PENDING_CHANGES; index += 1) {
      await expect(store.recordChange({ scope: 'draft', payload: { index }, recordedAtMs: index }))
        .resolves.toEqual({ ok: true, sequence: index + 1 })
    }
    await expect(store.recordChange({ scope: 'draft', payload: { index: 500 }, recordedAtMs: 500 }))
      .resolves.toEqual({ ok: false, code: 'local_change_capacity_reached', retained: 500 })
    const replay = await store.replayOnReconnect(async () => false)
    expect(replay.submittedSequences).toEqual([1])
    expect(replay.retainedSequences).toHaveLength(500)
  })

  it('admits exactly one of two concurrent writes at the 500-change boundary', async () => {
    const store = createMemoryLocalStore()
    for (let index = 0; index < MAXIMUM_PENDING_CHANGES - 1; index += 1) {
      await store.recordChange({ scope: 'draft', payload: { index }, recordedAtMs: index })
    }
    const outcomes = await Promise.all([
      store.recordChange({ scope: 'draft', payload: { writer: 'left' }, recordedAtMs: 500 }),
      store.recordChange({ scope: 'draft', payload: { writer: 'right' }, recordedAtMs: 501 }),
    ])
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1)
    expect(outcomes.filter(({ ok }) => !ok)).toEqual([{
      ok: false,
      code: 'local_change_capacity_reached',
      retained: MAXIMUM_PENDING_CHANGES,
    }])
    const replay = await store.replayOnReconnect(async () => false)
    expect(replay.retainedSequences).toHaveLength(MAXIMUM_PENDING_CHANGES)
  })

  it('replays first-to-last and deletes only acknowledged changes', async () => {
    const store = createMemoryLocalStore()
    for (let index = 0; index < 4; index += 1) {
      await store.recordChange({ scope: 'draft', payload: { index }, recordedAtMs: index })
    }
    const observed: number[] = []
    const replay = await store.replayOnReconnect(async (change) => {
      observed.push(change.sequence)
      return change.sequence < 3
    })
    expect(observed).toEqual([1, 2, 3])
    expect(replay.acknowledgedSequences).toEqual([1, 2])
    expect(replay.retainedSequences).toEqual([3, 4])
    expect(settlementBlockedOffline()).toEqual({ ok: false, code: 'connectivity_absent' })
  })
})
