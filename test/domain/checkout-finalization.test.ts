import assert from 'node:assert/strict'
import { test } from 'node:test'

import { finalizeSettledCheckout } from '../../src/core/checkout-finalization.ts'

test('post-settlement finalization failures preserve the settled provider result', async () => {
  const providerResult = Object.freeze({ settlementId: 'settlement-already-committed' })
  const calls: string[] = []
  const result = await finalizeSettledCheckout(providerResult, false, {
    stopObservation: async () => {
      calls.push('stop')
      throw new Error('alarm storage unavailable')
    },
    recordMarkup: async () => {
      calls.push('markup')
      throw new Error('ledger unavailable')
    },
    recordEvidence: () => {
      calls.push('evidence')
      throw new Error('event append unavailable')
    },
  })

  assert.deepEqual(calls, ['stop', 'markup', 'evidence'])
  assert.deepEqual(result, {
    ok: true,
    status: 'settled',
    idempotent: false,
    result: providerResult,
    markup: {
      stage: 'deferred',
      failingStage: 'unexpected',
      attempts: 3,
      evidenceDisposition: 'response-only-deferred',
      observationStopDisposition: 'deferred',
    },
  })
})
