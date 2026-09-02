import { isRecord } from '../shared/http.js'
import type { SettlementReceipt } from './checkout-receipts.js'
import type { StoredCheckout } from './checkout-state.js'
import type { RevenueLedger, RevenueLine } from './revenue-ledger.js'
import { computeMarkupMinor, readRateBasisPoints } from './take-rate.js'

export type MarkupOutcome =
  | Readonly<{ stage: 'recorded'; markupMinor: number; idempotent: boolean; attempts: number }>
  | Readonly<{
      stage: 'deferred'
      failingStage: 'compute' | 'append' | 'unexpected'
      attempts: typeof MARKUP_ATTEMPT_LIMIT
    }>

export type MarkupComputation = (
  settledAmountMinor: number,
  appliedRateBasisPoints: unknown,
) => Readonly<{ appliedRateBasisPoints: number; markupMinor: number }>

type ComputeDeferredOutcome = Extract<MarkupOutcome, { stage: 'deferred' }> & Readonly<{
  settlementId: string
  failingStage: 'compute'
}>

type MarkupRetryInput = Readonly<{
  settlementId: string
  agentId: string
  settledAmountMinor: number
  currency: string
  appliedRateBasisPoints: number
  recordedAtMs: number
  recordedAt: string
}>

export type MarkupOutbox =
  | Readonly<{ schema: 'commerce.markup-outbox/v2'; state: 'ready'; line: RevenueLine }>
  | Readonly<{
      schema: 'commerce.markup-outbox/v2'
      state: 'deferred'
      input: MarkupRetryInput
      outcome: ComputeDeferredOutcome
    }>

type LedgerClient = Readonly<{ appendLine: RevenueLedger['appendLine'] }>

export const MARKUP_ATTEMPT_LIMIT = 3 as const
const APPEND_ATTEMPT_TIMEOUT_MS = 1_500

export function createSettlementMarkupOutbox(
  appliedRateBasisPointsInput: unknown,
  state: StoredCheckout,
  receipt: SettlementReceipt,
  recordedAtMs: number,
  compute: MarkupComputation = computeSettlementMarkup,
): MarkupOutbox {
  const appliedRateBasisPoints = readRateBasisPoints(appliedRateBasisPointsInput)
  if (appliedRateBasisPoints === null) throw new RangeError('rate_basis_points_invalid')
  const input = Object.freeze({
    settlementId: receipt.settlementId,
    agentId: state.agent_id,
    settledAmountMinor: receipt.amountMinor,
    currency: receipt.currency,
    appliedRateBasisPoints,
    recordedAtMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
  })
  const line = computeRevenueLine(input, compute)
  return line
    ? Object.freeze({ schema: 'commerce.markup-outbox/v2', state: 'ready', line })
    : deferredOutbox(input)
}

export function readSettlementMarkupOutbox(serialized: string | null): MarkupOutbox | null {
  if (!serialized) return null
  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value)
      || (value.schema !== 'commerce.markup-outbox/v1'
        && value.schema !== 'commerce.markup-outbox/v2')) return null
    if (value.state === 'ready' && validRevenueLine(value.line)) {
      return Object.freeze({ schema: 'commerce.markup-outbox/v2', state: 'ready', line: value.line })
    }
    if (value.schema === 'commerce.markup-outbox/v2'
      && value.state === 'deferred'
      && validRetryInput(value.input)
      && validDeferredOutcome(value.outcome)
      && value.outcome.settlementId === value.input.settlementId) {
      return Object.freeze({
        schema: 'commerce.markup-outbox/v2',
        state: 'deferred',
        input: value.input,
        outcome: value.outcome,
      })
    }
    return null
  } catch {
    return null
  }
}

export async function recordSettlementMarkup(env: CoreEnv, outbox: MarkupOutbox): Promise<MarkupOutcome> {
  const retriedLine = outbox.state === 'deferred' ? computeRevenueLine(outbox.input) : outbox.line
  if (!retriedLine) return outbox.state === 'deferred' ? outbox.outcome : unexpectedDeferred()
  const ledger = env.REVENUE_LEDGER.getByName(env.REGISTRY_ID) as unknown as LedgerClient
  for (let attempt = 1; attempt <= MARKUP_ATTEMPT_LIMIT; attempt += 1) {
    try {
      const result = await withTimeout(ledger.appendLine(retriedLine), APPEND_ATTEMPT_TIMEOUT_MS)
      if (isAppendSuccess(result)) {
        return Object.freeze({
          stage: 'recorded',
          markupMinor: retriedLine.markupMinor,
          idempotent: result.idempotent,
          attempts: attempt,
        })
      }
    } catch {
      // The bounded loop records one typed deferral after the final failed append.
    }
  }
  return Object.freeze({
    settlementId: retriedLine.settlementId,
    stage: 'deferred',
    failingStage: 'append',
    attempts: MARKUP_ATTEMPT_LIMIT,
  })
}

function deferredOutbox(input: MarkupRetryInput): MarkupOutbox {
  return Object.freeze({
    schema: 'commerce.markup-outbox/v2',
    state: 'deferred',
    input,
    outcome: Object.freeze({
      settlementId: input.settlementId,
      stage: 'deferred',
      failingStage: 'compute',
      attempts: MARKUP_ATTEMPT_LIMIT,
    }),
  })
}

function computeRevenueLine(
  input: MarkupRetryInput,
  compute: MarkupComputation = computeSettlementMarkup,
): RevenueLine | null {
  for (let attempt = 1; attempt <= MARKUP_ATTEMPT_LIMIT; attempt += 1) {
    try {
      const computed = compute(input.settledAmountMinor, input.appliedRateBasisPoints)
      if (!validComputation(computed, input.settledAmountMinor, input.appliedRateBasisPoints)) continue
      return Object.freeze({ ...input, ...computed })
    } catch {
      // A later bounded attempt or recovery alarm may recover a transient computation fault.
    }
  }
  return null
}

function unexpectedDeferred(): MarkupOutcome {
  return Object.freeze({ stage: 'deferred', failingStage: 'unexpected', attempts: MARKUP_ATTEMPT_LIMIT })
}

function computeSettlementMarkup(
  settledAmountMinor: number,
  appliedRateBasisPointsInput: unknown,
): ReturnType<MarkupComputation> {
  const appliedRateBasisPoints = readRateBasisPoints(appliedRateBasisPointsInput)
  if (appliedRateBasisPoints === null) throw new RangeError('rate_basis_points_invalid')
  return Object.freeze({
    appliedRateBasisPoints,
    markupMinor: computeMarkupMinor(settledAmountMinor, appliedRateBasisPoints),
  })
}

function validComputation(
  value: unknown,
  settledAmountMinor: number,
  appliedRateBasisPoints: unknown,
): value is ReturnType<MarkupComputation> {
  if (!isRecord(value)) return false
  const pinnedRate = readRateBasisPoints(appliedRateBasisPoints)
  if (pinnedRate === null
    || value.appliedRateBasisPoints !== pinnedRate
    || !Number.isSafeInteger(value.markupMinor)
    || Number(value.markupMinor) < 0
    || Number(value.markupMinor) > settledAmountMinor) return false
  return Number(value.markupMinor) === computeMarkupMinor(settledAmountMinor, pinnedRate)
}

function validRevenueLine(value: unknown): value is RevenueLine {
  if (!isRecord(value)) return false
  if (!validPinnedRate(value.appliedRateBasisPoints)) return false
  const appliedRateBasisPoints = value.appliedRateBasisPoints
  return typeof value.settlementId === 'string'
    && value.settlementId.length > 0
    && typeof value.agentId === 'string'
    && value.agentId.length > 0
    && Number.isSafeInteger(value.settledAmountMinor)
    && Number(value.settledAmountMinor) > 0
    && typeof value.currency === 'string'
    && /^[A-Z]{3}$/u.test(value.currency)
    && Number.isSafeInteger(value.markupMinor)
    && Number(value.markupMinor) >= 0
    && Number(value.markupMinor) <= Number(value.settledAmountMinor)
    && Number(value.markupMinor) === computeMarkupMinor(Number(value.settledAmountMinor), appliedRateBasisPoints)
    && Number.isSafeInteger(value.recordedAtMs)
    && typeof value.recordedAt === 'string'
    && new Date(Number(value.recordedAtMs)).toISOString() === value.recordedAt
}

function validDeferredOutcome(value: unknown): value is ComputeDeferredOutcome {
  return isRecord(value)
    && typeof value.settlementId === 'string'
    && value.settlementId.length > 0
    && value.stage === 'deferred'
    && value.failingStage === 'compute'
    && value.attempts === MARKUP_ATTEMPT_LIMIT
}

function validRetryInput(value: unknown): value is MarkupRetryInput {
  return isRecord(value)
    && typeof value.settlementId === 'string'
    && value.settlementId.length > 0
    && typeof value.agentId === 'string'
    && value.agentId.length > 0
    && Number.isSafeInteger(value.settledAmountMinor)
    && Number(value.settledAmountMinor) > 0
    && typeof value.currency === 'string'
    && /^[A-Z]{3}$/u.test(value.currency)
    && validPinnedRate(value.appliedRateBasisPoints)
    && Number.isSafeInteger(value.recordedAtMs)
    && typeof value.recordedAt === 'string'
    && new Date(Number(value.recordedAtMs)).toISOString() === value.recordedAt
}

function validPinnedRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && readRateBasisPoints(value) === value
}

function withTimeout<Value>(operation: Promise<Value>, timeoutMs: number): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('revenue_ledger_timeout')), timeoutMs)
    void operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error('revenue_ledger_failed'))
      },
    )
  })
}

function isAppendSuccess(value: unknown): value is Readonly<{ ok: true; idempotent: boolean }> {
  return isRecord(value) && value.ok === true && typeof value.idempotent === 'boolean'
}
