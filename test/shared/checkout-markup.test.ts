import { describe, expect, it } from 'vitest'

import {
  createSettlementMarkupOutbox,
  MARKUP_ATTEMPT_LIMIT,
  readSettlementMarkupOutbox,
  recordSettlementMarkup,
  type MarkupComputation,
} from '../../src/core/checkout-markup.ts'
import type { SettlementReceipt } from '../../src/core/checkout-receipts.ts'
import type { StoredCheckout } from '../../src/core/checkout-state.ts'

const SETTLEMENT_ID = 'settlement-compute-fault'

describe('settlement markup computation retries', () => {
  it('retains settlement inputs after three compute faults and recovers without a provider call', async () => {
    let callCount = 0
    const forcedFault: MarkupComputation = () => {
      callCount += 1
      throw new Error('forced_compute_fault')
    }

    const outbox = createSettlementMarkupOutbox(
      250,
      checkoutState(),
      settlementReceipt(),
      Date.parse('2026-08-30T00:00:00.000Z'),
      forcedFault,
    )

    expect(callCount).toBe(MARKUP_ATTEMPT_LIMIT)
    expect(outbox).toEqual({
      schema: 'commerce.markup-outbox/v2',
      state: 'deferred',
      input: {
        settlementId: SETTLEMENT_ID,
        agentId: 'agent-owner',
        settledAmountMinor: 12_500,
        currency: 'USD',
        appliedRateBasisPoints: 250,
        recordedAtMs: 1_788_048_000_000,
        recordedAt: '2026-08-30T00:00:00.000Z',
      },
      outcome: {
        settlementId: SETTLEMENT_ID,
        stage: 'deferred',
        failingStage: 'compute',
        attempts: 3,
      },
    })
    if (outbox.state !== 'deferred') throw new Error('forced computation fault did not defer')
    expect(readSettlementMarkupOutbox(JSON.stringify(outbox))).toEqual(outbox)
    const appendedLines: unknown[] = []
    const changedConfiguration = markupEnv(async (line) => {
      appendedLines.push(line)
      return Object.freeze({ ok: true, idempotent: false })
    }, '900')
    await expect(recordSettlementMarkup(changedConfiguration, outbox)).resolves.toMatchObject({
      stage: 'recorded', markupMinor: 313, attempts: 1,
    })
    expect(appendedLines).toEqual([expect.objectContaining({
      appliedRateBasisPoints: 250,
      markupMinor: 313,
    })])
  })

  it('rejects unpinned legacy or non-integer deferred recovery records', () => {
    const deferred = createSettlementMarkupOutbox(
      250,
      checkoutState(),
      settlementReceipt(),
      Date.parse('2026-08-30T00:00:00.000Z'),
      () => { throw new Error('forced_compute_fault') },
    )
    expect(deferred.state).toBe('deferred')
    expect(readSettlementMarkupOutbox(JSON.stringify({ ...deferred, schema: 'commerce.markup-outbox/v1' }))).toBeNull()
    if (deferred.state !== 'deferred') throw new Error('forced computation fault did not defer')
    expect(readSettlementMarkupOutbox(JSON.stringify({
      ...deferred,
      input: { ...deferred.input, appliedRateBasisPoints: 250.5 },
    }))).toBeNull()
  })

  it('keeps settlement amount, owner, currency, and canonical take-rate output unchanged', () => {
    const outbox = createSettlementMarkupOutbox(
      250,
      checkoutState(),
      settlementReceipt(),
      Date.parse('2026-08-30T00:00:00.000Z'),
    )
    expect(outbox).toMatchObject({
      state: 'ready',
      line: {
        settlementId: SETTLEMENT_ID,
        agentId: 'agent-owner',
        settledAmountMinor: 12_500,
        currency: 'USD',
        appliedRateBasisPoints: 250,
        markupMinor: 313,
      },
    })
  })

  it('keeps an append deferral retryable across bounded three-attempt batches', async () => {
    let calls = 0
    const env = markupEnv(async () => {
      calls += 1
      return calls <= MARKUP_ATTEMPT_LIMIT
        ? Object.freeze({ ok: false, code: 'temporarily_unavailable' })
        : Object.freeze({ ok: true, idempotent: false })
    })
    const outbox = createSettlementMarkupOutbox(
      250, checkoutState(), settlementReceipt(), Date.parse('2026-08-30T00:00:00.000Z'),
    )
    await expect(recordSettlementMarkup(env, outbox)).resolves.toMatchObject({
      stage: 'deferred', failingStage: 'append', attempts: MARKUP_ATTEMPT_LIMIT,
    })
    await expect(recordSettlementMarkup(env, outbox)).resolves.toMatchObject({
      stage: 'recorded', attempts: 1,
    })
    expect(calls).toBe(MARKUP_ATTEMPT_LIMIT + 1)
  })
})

function markupEnv(
  appendLine: (line: unknown) => Promise<unknown> = async () => Object.freeze({ ok: true, idempotent: false }),
  takeRateBasisPoints = '250',
): CoreEnv {
  return Object.freeze({
    AG_TAKE_RATE_BASIS_POINTS: takeRateBasisPoints,
    REGISTRY_ID: 'primary',
    REVENUE_LEDGER: { getByName: () => Object.freeze({ appendLine }) },
  }) as unknown as CoreEnv
}

function checkoutState(): StoredCheckout {
  return Object.freeze({ agent_id: 'agent-owner' }) as StoredCheckout
}

function settlementReceipt(): SettlementReceipt {
  return Object.freeze({
    settlementId: SETTLEMENT_ID,
    amountMinor: 12_500,
    currency: 'USD',
  }) as SettlementReceipt
}
