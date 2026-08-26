import { DurableObject } from 'cloudflare:workers'

import { constantTimeTextMatch } from '../shared/auth'
import { canonicalJson, sha256Hex } from '../shared/digest'
import { readJsonResponse } from '../shared/http'
import {
  normalizeGuardrailReceipt,
  normalizeSettlementReceipt,
  type GuardrailReceipt,
  type SettlementReceipt,
} from './checkout-receipts'
import { CHECKOUT_PROVIDER_CONTRACT } from './provider-contract'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REVISION_PATTERN = /^[0-9a-f]{40}$/u
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 65_536

export type CheckoutPrepareInput = Readonly<{
  checkoutId: string
  intentId: string
  agentId: string
  offerId: string
  offerReceiptDigest: string
  offerProviderRevision: string
  amountMinor: number
  budgetMinor: number
  currency: string
}>

export type CheckoutConfirmInput = Readonly<{
  checkoutId: string
  confirmationToken: string
  offerId: string
  amountMinor: number
}>

export class CheckoutSession extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS checkout_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        checkout_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        offer_receipt_digest TEXT NOT NULL,
        offer_provider_revision TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        budget_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        state TEXT NOT NULL,
        guardrail_receipt_json TEXT,
        guardrail_receipt_digest TEXT,
        confirmation_token TEXT,
        confirmation_token_digest TEXT,
        confirmation_expires_at INTEGER,
        human_confirmation_digest TEXT,
        settlement_idempotency_key TEXT,
        provider_result_json TEXT,
        failure_code TEXT,
        updated_at TEXT NOT NULL
      )`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS checkout_event (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`)
    })
  }

  async prepare(input: CheckoutPrepareInput): Promise<unknown> {
    if (!validPrepare(input)) return rejected('checkout_prepare_malformed')
    const requestDigest = await sha256Hex(canonicalJson(input))
    const prior = this.#read()
    if (prior) {
      if (prior.request_digest !== requestDigest) return rejected('checkout_prepare_precondition_failed')
      if (prior.state === 'confirmation_required') return preparedResult(prior, true)
      return rejected(prior.state === 'preparing'
        ? 'checkout_prepare_result_unknown'
        : 'checkout_not_preparable')
    }

    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `INSERT INTO checkout_state (
          singleton, checkout_id, request_digest, intent_id, agent_id, offer_id, amount_minor,
          offer_receipt_digest, offer_provider_revision, budget_minor, currency, state, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`,
        input.checkoutId,
        requestDigest,
        input.intentId,
        input.agentId,
        input.offerId,
        input.amountMinor,
        input.offerReceiptDigest,
        input.offerProviderRevision,
        input.budgetMinor,
        input.currency,
        new Date().toISOString(),
      )
      this.#appendEvent('checkout_prepare_requested', {
        checkoutId: input.checkoutId,
        intentId: input.intentId,
        agentId: input.agentId,
        offerId: input.offerId,
        offerReceiptDigest: input.offerReceiptDigest,
        offerProviderRevision: input.offerProviderRevision,
        amountMinor: input.amountMinor,
        budgetMinor: input.budgetMinor,
        currency: input.currency,
      })
    })

    let response: Response
    try {
      response = await this.env.CHECKOUT_PROVIDER.fetch(
        new Request('https://commerce.internal/internal/v1/checkouts/prepare', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT,
          },
          body: JSON.stringify({
            contract: CHECKOUT_PROVIDER_CONTRACT,
            ...input,
            idempotencyKey: `checkout-prepare:${input.checkoutId}`,
          }),
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        }),
      )
    } catch {
      return this.#prepareFailure('guardrail_provider_unavailable')
    }
    let payload: unknown
    try {
      payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
    } catch {
      return this.#prepareFailure('guardrail_provider_unavailable')
    }
    if (!response.ok) return this.#prepareFailure('guardrail_provider_rejected')
    let receipt: GuardrailReceipt
    try {
      receipt = await normalizeGuardrailReceipt(payload, {
        checkoutId: input.checkoutId,
        intentId: input.intentId,
        agentId: input.agentId,
        offerReceiptDigest: input.offerReceiptDigest,
        amountMinor: input.amountMinor,
        budgetMinor: input.budgetMinor,
        currency: input.currency,
        providerRevision: input.offerProviderRevision,
      })
    } catch {
      return this.#prepareFailure('guardrail_receipt_invalid')
    }
    try {
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`
      const tokenDigest = await sha256Hex(token)
      const expiresAt = Date.now() + CONFIRMATION_TTL_MS
      this.ctx.storage.transactionSync(() => {
        this.#sql.exec(
          `UPDATE checkout_state SET state = 'confirmation_required', guardrail_receipt_json = ?,
            guardrail_receipt_digest = ?,
            confirmation_token = ?, confirmation_token_digest = ?, confirmation_expires_at = ?,
            updated_at = ? WHERE singleton = 1 AND state = 'preparing'`,
          canonicalJson(receipt),
          receipt.receiptDigest,
          token,
          tokenDigest,
          expiresAt,
          new Date().toISOString(),
        )
        this.#appendEvent('guardrail_passed', receipt)
      })
      const stored = this.#read()
      return stored ? preparedResult(stored, false) : rejected('checkout_persistence_failed')
    } catch {
      return this.#prepareFailure('checkout_persistence_failed')
    }
  }

  async confirm(input: CheckoutConfirmInput): Promise<unknown> {
    if (!validConfirm(input)) return rejected('checkout_confirmation_malformed')
    const state = this.#read()
    if (!state || state.checkout_id !== input.checkoutId) return rejected('checkout_not_prepared')
    if (state.offer_id !== input.offerId || state.amount_minor !== input.amountMinor) {
      return rejected('checkout_confirmation_precondition_failed')
    }
    const candidateTokenDigest = await sha256Hex(input.confirmationToken)
    if (!state.confirmation_token_digest
      || !await constantTimeTextMatch(candidateTokenDigest, state.confirmation_token_digest)) {
      return rejected('confirmation_token_invalid')
    }
    const humanConfirmationDigest = await digestHumanConfirmation(input, candidateTokenDigest)

    if (state.state === 'settled' && state.provider_result_json) {
      if (!state.human_confirmation_digest
        || !await constantTimeTextMatch(humanConfirmationDigest, state.human_confirmation_digest)) {
        return rejected('checkout_confirmation_precondition_failed')
      }
      return settledResult(JSON.parse(state.provider_result_json) as unknown, true)
    }

    if (state.state === 'confirming' || state.state === 'reconciliation_required') {
      if (!state.human_confirmation_digest
        || !state.settlement_idempotency_key
        || !await constantTimeTextMatch(humanConfirmationDigest, state.human_confirmation_digest)) {
        return rejected('checkout_confirmation_precondition_failed')
      }
      return this.#reconcileSettlement(state, humanConfirmationDigest, state.settlement_idempotency_key)
    }

    if (state.state !== 'confirmation_required') return rejected('checkout_not_confirmable')
    if (!state.confirmation_expires_at || Date.now() > state.confirmation_expires_at) {
      return this.#terminalFailure('confirmation_expired')
    }
    if (!state.guardrail_receipt_json
      || !state.guardrail_receipt_digest
      || !state.offer_provider_revision) {
      return rejected('guardrail_receipt_required')
    }

    const idempotencyKey = `checkout-confirm:${input.checkoutId}`

    let confirmationRecorded = false
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'confirming', confirmation_token = NULL,
          human_confirmation_digest = ?, settlement_idempotency_key = ?, failure_code = NULL,
          updated_at = ? WHERE singleton = 1 AND state = 'confirmation_required'`,
        humanConfirmationDigest,
        idempotencyKey,
        new Date().toISOString(),
      )
      confirmationRecorded = update.rowsWritten === 1
      if (confirmationRecorded) {
        this.#appendEvent('human_confirmed', {
          checkoutId: input.checkoutId,
          offerId: input.offerId,
          amountMinor: input.amountMinor,
          humanConfirmationDigest,
          idempotencyKey,
        })
      }
    })

    if (!confirmationRecorded) {
      const concurrent = this.#read()
      if (concurrent?.state === 'settled' && concurrent.provider_result_json) {
        return settledResult(JSON.parse(concurrent.provider_result_json) as unknown, true)
      }
      if (concurrent
        && (concurrent.state === 'confirming' || concurrent.state === 'reconciliation_required')
        && concurrent.human_confirmation_digest === humanConfirmationDigest
        && concurrent.settlement_idempotency_key === idempotencyKey) {
        return this.#reconcileSettlement(concurrent, humanConfirmationDigest, idempotencyKey)
      }
      return rejected('checkout_confirmation_precondition_failed')
    }

    return this.#submitSettlement(state, humanConfirmationDigest, idempotencyKey)
  }

  async #submitSettlement(
    state: StoredCheckout,
    humanConfirmationDigest: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    try {
      const response = await this.env.CHECKOUT_PROVIDER.fetch(
        new Request('https://commerce.internal/internal/v1/checkouts/confirm', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT,
          },
          body: JSON.stringify({
            contract: CHECKOUT_PROVIDER_CONTRACT,
            checkoutId: state.checkout_id,
            offerId: state.offer_id,
            amountMinor: state.amount_minor,
            currency: state.currency,
            guardrailReceipt: JSON.parse(state.guardrail_receipt_json ?? 'null') as unknown,
            guardrailReceiptDigest: state.guardrail_receipt_digest,
            humanConfirmationDigest,
            idempotencyKey,
          }),
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        }),
      )
      return await this.#consumeSettlementResponse(
        response, state, humanConfirmationDigest, idempotencyKey, false,
      )
    } catch {
      return this.#requireReconciliation('settlement_provider_result_unknown')
    }
  }

  async #reconcileSettlement(
    state: StoredCheckout,
    humanConfirmationDigest: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'reconciliation_required', updated_at = ?
         WHERE singleton = 1 AND state IN ('confirming', 'reconciliation_required')`,
        new Date().toISOString(),
      )
      if (update.rowsWritten === 1) {
        this.#appendEvent('settlement_reconciliation_requested', {
          checkoutId: state.checkout_id,
          humanConfirmationDigest,
          idempotencyKey,
        })
      }
    })
    const statusUrl = new URL('/internal/v1/checkouts/status', 'https://commerce.internal')
    statusUrl.searchParams.set('idempotencyKey', idempotencyKey)
    try {
      const response = await this.env.CHECKOUT_PROVIDER.fetch(new Request(statusUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT,
        },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      }))
      return await this.#consumeSettlementResponse(
        response, state, humanConfirmationDigest, idempotencyKey, true,
      )
    } catch {
      return this.#requireReconciliation('settlement_reconciliation_incomplete')
    }
  }

  async #consumeSettlementResponse(
    response: Response,
    state: StoredCheckout,
    humanConfirmationDigest: string,
    idempotencyKey: string,
    idempotent: boolean,
  ): Promise<unknown> {
    if (!response.ok) return this.#requireReconciliation('settlement_provider_result_unknown')
    const payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
    let receipt: SettlementReceipt
    try {
      receipt = await normalizeSettlementReceipt(payload, {
        checkoutId: state.checkout_id,
        offerId: state.offer_id,
        amountMinor: state.amount_minor,
        currency: state.currency,
        idempotencyKey,
        humanConfirmationDigest,
        guardrailReceiptDigest: state.guardrail_receipt_digest ?? '',
        providerRevision: state.offer_provider_revision,
      })
    } catch {
      return this.#requireReconciliation('settlement_receipt_invalid')
    }
    let recorded = false
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'settled', provider_result_json = ?, failure_code = NULL,
          updated_at = ? WHERE singleton = 1 AND state IN ('confirming', 'reconciliation_required')`,
        canonicalJson(payload),
        new Date().toISOString(),
      )
      recorded = update.rowsWritten === 1
      if (recorded) this.#appendEvent('settlement_recorded', receipt)
    })
    const stored = this.#read()
    if (!stored?.provider_result_json) return rejected('checkout_persistence_failed')
    return settledResult(JSON.parse(stored.provider_result_json) as unknown, idempotent || !recorded)
  }

  async status(): Promise<unknown> {
    const state = this.#read()
    if (!state) return rejected('checkout_not_found')
    const events = this.#sql.exec<{
      sequence: number
      event_type: string
      evidence_json: string
      created_at: string
    }>('SELECT sequence, event_type, evidence_json, created_at FROM checkout_event ORDER BY sequence')
      .toArray()
      .map((event) => Object.freeze({
        sequence: event.sequence,
        eventType: event.event_type,
        evidence: JSON.parse(event.evidence_json) as unknown,
        createdAt: event.created_at,
      }))
    return Object.freeze({
      ok: true,
      checkoutId: state.checkout_id,
      status: state.state,
      failureCode: state.failure_code,
      events: Object.freeze(events),
    })
  }

  #prepareFailure(code: string): unknown {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        "UPDATE checkout_state SET state = 'failed', failure_code = ?, updated_at = ? WHERE singleton = 1",
        code,
        new Date().toISOString(),
      )
      this.#appendEvent('checkout_prepare_failed', { code })
    })
    return rejected(code)
  }

  #requireReconciliation(code: string): unknown {
    let recorded = false
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'reconciliation_required', failure_code = ?, updated_at = ?
         WHERE singleton = 1 AND state IN ('confirming', 'reconciliation_required')`,
        code,
        new Date().toISOString(),
      )
      recorded = update.rowsWritten === 1
      if (recorded) this.#appendEvent('settlement_reconciliation_required', { code })
    })
    const stored = this.#read()
    if (stored?.state === 'settled' && stored.provider_result_json) {
      return settledResult(JSON.parse(stored.provider_result_json) as unknown, true)
    }
    return Object.freeze({ ok: false, status: 'reconciliation_required', code })
  }

  #terminalFailure(code: string): unknown {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `UPDATE checkout_state SET state = 'failed', confirmation_token = NULL,
          failure_code = ?, updated_at = ? WHERE singleton = 1`,
        code,
        new Date().toISOString(),
      )
      this.#appendEvent('checkout_failed', { code })
    })
    return rejected(code)
  }

  #appendEvent(eventType: string, evidence: unknown): void {
    this.#sql.exec(
      'INSERT INTO checkout_event (event_type, evidence_json, created_at) VALUES (?, ?, ?)',
      eventType,
      canonicalJson(evidence),
      new Date().toISOString(),
    )
  }

  #read(): StoredCheckout | null {
    return this.#sql.exec<StoredCheckout>('SELECT * FROM checkout_state WHERE singleton = 1').toArray()[0] ?? null
  }
}

type StoredCheckout = {
  checkout_id: string
  request_digest: string
  intent_id: string
  agent_id: string
  offer_id: string
  offer_receipt_digest: string
  offer_provider_revision: string
  amount_minor: number
  budget_minor: number
  currency: string
  state: string
  guardrail_receipt_json: string | null
  guardrail_receipt_digest: string | null
  confirmation_token: string | null
  confirmation_token_digest: string | null
  confirmation_expires_at: number | null
  human_confirmation_digest: string | null
  settlement_idempotency_key: string | null
  provider_result_json: string | null
  failure_code: string | null
}

function validPrepare(input: CheckoutPrepareInput): boolean {
  return [input.checkoutId, input.intentId, input.agentId, input.offerId]
    .every((value) => IDENTIFIER_PATTERN.test(value))
    && SHA256_PATTERN.test(input.offerReceiptDigest)
    && REVISION_PATTERN.test(input.offerProviderRevision)
    && Number.isSafeInteger(input.amountMinor)
    && input.amountMinor > 0
    && Number.isSafeInteger(input.budgetMinor)
    && input.budgetMinor >= input.amountMinor
    && CURRENCY_PATTERN.test(input.currency)
}

function validConfirm(input: CheckoutConfirmInput): boolean {
  return IDENTIFIER_PATTERN.test(input.checkoutId)
    && IDENTIFIER_PATTERN.test(input.offerId)
    && typeof input.confirmationToken === 'string'
    && /^[\x21-\x7e]{64,128}$/u.test(input.confirmationToken)
    && Number.isSafeInteger(input.amountMinor)
    && input.amountMinor > 0
}

function digestHumanConfirmation(
  input: CheckoutConfirmInput,
  confirmationTokenDigest: string,
): Promise<string> {
  return sha256Hex(canonicalJson({
    checkoutId: input.checkoutId,
    offerId: input.offerId,
    amountMinor: input.amountMinor,
    confirmationTokenDigest,
  }))
}

function preparedResult(state: StoredCheckout, idempotent: boolean): unknown {
  return Object.freeze({
    ok: true,
    status: 'confirmation_required',
    idempotent,
    checkoutId: state.checkout_id,
    confirmationToken: state.confirmation_token,
    confirmationExpiresAt: state.confirmation_expires_at,
    guardrailReceipt: state.guardrail_receipt_json
      ? JSON.parse(state.guardrail_receipt_json) as unknown
      : null,
  })
}

function settledResult(result: unknown, idempotent: boolean): unknown {
  return Object.freeze({ ok: true, status: 'settled', idempotent, result })
}

function rejected(code: string): Readonly<{ ok: false; status: 'rejected'; code: string }> {
  return Object.freeze({ ok: false, status: 'rejected', code })
}
