import { DurableObject } from 'cloudflare:workers'
import { constantTimeTextMatch } from '../shared/auth.js'
import { canonicalJson, sha256Hex } from '../shared/digest.js'
import { settledResult } from './checkout-finalization.js'
import {
  createSettlementMarkupOutbox,
  readSettlementMarkupOutbox,
  recordSettlementMarkup,
  type MarkupOutcome,
} from './checkout-markup.js'
import {
  reconcileSettlement,
  requestGuardrail,
  submitSettlement,
  type SettlementProviderResult,
} from './checkout-provider-client.js'
import {
  digestCheckoutBlockers,
  digestHumanConfirmation,
  preparedResult,
  rejected,
  validConfirm,
  validPrepare,
  type CheckoutConfirmInput,
  type CheckoutPrepareInput,
  type StoredCheckout,
} from './checkout-state.js'
import { restoreSettlementReceipt } from './checkout-receipts.js'
import { readRateBasisPoints } from './take-rate.js'
import {
  MAXIMUM_OBSERVATION_RETRIES,
  OBSERVATION_INTERVAL_MS,
  observeHeldOffer,
  type ChangeEvent,
  type HeldOffer,
  type ObservationOutcome,
} from './offer-watch.js'

export type { CheckoutConfirmInput, CheckoutPrepareInput } from './checkout-state.js'
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000
const MARKUP_RETRY_MAX_MS = 15 * 60 * 1_000
const BLOCKING_EVENT_TYPES = Object.freeze(['offer_changed', 'offer_observation_suspended', 'offer_agent_inactive'])

export class CheckoutSession extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage
  #offerGate: Promise<void> = Promise.resolve()

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
        applied_rate_basis_points INTEGER,
        provider_result_json TEXT,
        settlement_receipt_json TEXT,
        markup_outbox_json TEXT,
        markup_finalization_state TEXT NOT NULL DEFAULT 'pending',
        markup_finalization_json TEXT,
        failure_code TEXT,
        observation_failure_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`)
      const columns = this.#sql.exec<{ name: string }>('PRAGMA table_info(checkout_state)').toArray()
      if (!columns.some(({ name }) => name === 'observation_failure_count')) this.#sql.exec('ALTER TABLE checkout_state ADD COLUMN observation_failure_count INTEGER NOT NULL DEFAULT 0')
      if (!columns.some(({ name }) => name === 'settlement_receipt_json')) this.#sql.exec('ALTER TABLE checkout_state ADD COLUMN settlement_receipt_json TEXT')
      if (!columns.some(({ name }) => name === 'applied_rate_basis_points')) this.#sql.exec('ALTER TABLE checkout_state ADD COLUMN applied_rate_basis_points INTEGER')
      if (!columns.some(({ name }) => name === 'markup_outbox_json')) this.#sql.exec('ALTER TABLE checkout_state ADD COLUMN markup_outbox_json TEXT')
      if (!columns.some(({ name }) => name === 'markup_finalization_state')) this.#sql.exec("ALTER TABLE checkout_state ADD COLUMN markup_finalization_state TEXT NOT NULL DEFAULT 'pending'")
      if (!columns.some(({ name }) => name === 'markup_finalization_json')) this.#sql.exec('ALTER TABLE checkout_state ADD COLUMN markup_finalization_json TEXT')
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
      return rejected(prior.state === 'preparing' ? 'checkout_prepare_result_unknown' : 'checkout_not_preparable')
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
      this.#appendEvent('checkout_prepare_requested', input)
    })

    const receipt = await requestGuardrail(this.env, input)
    if (!receipt) return this.#prepareFailure('guardrail_provider_unavailable')
    try {
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`
      const tokenDigest = await sha256Hex(token)
      const expiresAt = Date.now() + CONFIRMATION_TTL_MS
      this.ctx.storage.transactionSync(() => {
        this.#sql.exec(
          `UPDATE checkout_state SET state = 'confirmation_required', guardrail_receipt_json = ?,
            guardrail_receipt_digest = ?, confirmation_token = ?, confirmation_token_digest = ?,
            confirmation_expires_at = ?, updated_at = ?
           WHERE singleton = 1 AND state = 'preparing'`,
          canonicalJson(receipt),
          receipt.receiptDigest,
          token,
          tokenDigest,
          expiresAt,
          new Date().toISOString(),
        )
        this.#appendEvent('guardrail_passed', receipt)
      })
      await this.ctx.storage.setAlarm(Date.now() + OBSERVATION_INTERVAL_MS)
      const stored = this.#read()
      return stored ? preparedResult(stored, false) : rejected('checkout_persistence_failed')
    } catch {
      return this.#prepareFailure('checkout_persistence_failed')
    }
  }

  async confirm(input: CheckoutConfirmInput): Promise<unknown> {
    return this.#withOfferGate(() => this.#confirm(input))
  }
  async #confirm(input: CheckoutConfirmInput): Promise<unknown> {
    if (!validConfirm(input)) return rejected('checkout_confirmation_malformed')
    const state = this.#read()
    if (!state || state.checkout_id !== input.checkoutId) return rejected('checkout_not_prepared')
    if (state.offer_id !== input.offerId
      || state.amount_minor !== input.amountMinor
      || state.currency !== input.currency) {
      return rejected('checkout_confirmation_precondition_failed')
    }
    const candidateTokenDigest = await sha256Hex(input.confirmationToken)
    if (!state.confirmation_token_digest
      || !await constantTimeTextMatch(candidateTokenDigest, state.confirmation_token_digest)) {
      return rejected('confirmation_token_invalid')
    }
    const humanConfirmationDigest = await digestHumanConfirmation(input, candidateTokenDigest)

    if (state.state === 'settled' && state.provider_result_json) {
      if (state.human_confirmation_digest !== humanConfirmationDigest) {
        return rejected('checkout_confirmation_precondition_failed')
      }
      return this.#resumeSettledFinalization(state, true)
    }
    if (state.state === 'confirming' || state.state === 'reconciliation_required') {
      if (state.human_confirmation_digest !== humanConfirmationDigest || !state.settlement_idempotency_key) {
        return rejected('checkout_confirmation_precondition_failed')
      }
      if (!await this.#armRecoveryAlarm()) return rejected('checkout_recovery_alarm_unavailable')
      return this.#reconcile(state, humanConfirmationDigest, state.settlement_idempotency_key)
    }
    if (state.state !== 'confirmation_required') return rejected('checkout_not_confirmable')
    if (!state.confirmation_expires_at || Date.now() > state.confirmation_expires_at) {
      return this.#terminalFailure('confirmation_expired')
    }
    if (!state.guardrail_receipt_json || !state.guardrail_receipt_digest || !state.offer_provider_revision) {
      return rejected('guardrail_receipt_required')
    }

    const blockers = this.#unacknowledgedBlockingEvents()
    const blockerDigest = await digestCheckoutBlockers(blockers)
    const inactive = blockers.findLast(({ eventType }) => eventType === 'offer_agent_inactive')
    if (inactive) {
      return rejected('offer_agent_inactive', {
        blockerDigest,
        blockers: Object.freeze(blockers),
        eventSequence: inactive.sequence,
        evidence: inactive.evidence,
      })
    }
    if (input.blockerDigest !== blockerDigest) {
      return rejected('offer_reconfirmation_required', {
        blockerDigest,
        blockers: Object.freeze(blockers),
      })
    }

    const appliedRateBasisPoints = readRateBasisPoints(this.env.AG_TAKE_RATE_BASIS_POINTS)
    if (appliedRateBasisPoints === null) return rejected('rate_basis_points_invalid')
    const idempotencyKey = `checkout-confirm:${input.checkoutId}`
    // Arm recovery before consuming the confirmation. If alarm persistence is
    // unavailable, the checkout remains retryable and no provider call occurs.
    if (!await this.#armRecoveryAlarm()) return rejected('checkout_recovery_alarm_unavailable')
    let confirmationRecorded = false
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'confirming', confirmation_token = NULL,
          human_confirmation_digest = ?, settlement_idempotency_key = ?, applied_rate_basis_points = ?, failure_code = NULL,
          updated_at = ? WHERE singleton = 1 AND state = 'confirmation_required'`,
        humanConfirmationDigest,
        idempotencyKey,
        appliedRateBasisPoints,
        new Date().toISOString(),
      )
      confirmationRecorded = update.rowsWritten === 1
      if (confirmationRecorded) {
        for (const blocker of blockers) {
          this.#appendEvent('offer_change_acknowledged', {
            eventSequence: blocker.sequence,
            blockerDigest,
          })
        }
        this.#appendEvent('human_confirmed', {
          checkoutId: input.checkoutId,
          offerId: input.offerId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          blockerDigest,
          shopperPrincipalDigest: input.shopperPrincipalDigest,
          acknowledgedEventSequences: blockers.map(({ sequence }) => sequence),
          humanConfirmationDigest,
          idempotencyKey,
          appliedRateBasisPoints,
        })
      }
    })
    if (!confirmationRecorded) return rejected('checkout_confirmation_precondition_failed')
    const confirming = this.#read()
    if (!confirming || confirming.applied_rate_basis_points !== appliedRateBasisPoints) {
      return rejected('rate_basis_points_pin_persistence_failed')
    }
    return this.#consumeSettlement(
      await submitSettlement(this.env, confirming, humanConfirmationDigest, idempotencyKey),
      false,
    )
  }

  override async alarm(): Promise<void> {
    await this.#withOfferGate(async () => {
      const state = this.#read()
      if (state?.state === 'settled'
        && state.provider_result_json
        && state.markup_finalization_state !== 'completed') {
        await this.#resumeSettledFinalization(state, true)
        return
      }
      if (state && ['confirming', 'reconciliation_required'].includes(state.state)
        && state.human_confirmation_digest && state.settlement_idempotency_key) {
        await this.#observeHeldOffer()
        const observed = this.#read()
        if (observed && ['confirming', 'reconciliation_required'].includes(observed.state)
          && observed.human_confirmation_digest && observed.settlement_idempotency_key) {
          await this.#reconcile(observed, observed.human_confirmation_digest, observed.settlement_idempotency_key)
          const remaining = this.#read()
          if (remaining && ['confirming', 'reconciliation_required'].includes(remaining.state)
            && await this.ctx.storage.getAlarm() === null) await this.#armRecoveryAlarm()
        }
        return
      }
      await this.#observeHeldOffer()
    })
  }
  async #observeHeldOffer(): Promise<void> {
    const state = this.#read()
    if (!state || !['confirmation_required', 'confirming', 'reconciliation_required'].includes(state.state)) {
      if (state) await this.#stopObservation(state.state === 'settled' ? 'settled' : 'closed')
      return
    }
    const priorChanges = this.#events('offer_changed').map(({ evidence }) => evidence).filter(isChangeEvent)
    const held: HeldOffer = Object.freeze({
      offerId: state.offer_id,
      agentId: state.agent_id,
      recorded: Object.freeze({ priceMinor: state.amount_minor, available: true, agentActive: true }),
      priorChanges: Object.freeze(priorChanges),
      failedAttempts: state.observation_failure_count ?? 0,
    })
    const outcome = await observeHeldOffer(this.env, held)
    const suspended = this.#recordObservation(outcome)
    if (!suspended) await this.ctx.storage.setAlarm(Date.now() + OBSERVATION_INTERVAL_MS)
  }
  async status(): Promise<unknown> {
    const state = this.#read()
    if (!state) return rejected('checkout_not_found')
    return Object.freeze({
      ok: true,
      checkoutId: state.checkout_id,
      status: state.state,
      failureCode: state.failure_code,
      events: Object.freeze(this.#events()),
    })
  }
  async #reconcile(state: StoredCheckout, digest: string, key: string): Promise<unknown> {
    if (readRateBasisPoints(state.applied_rate_basis_points) === null) {
      return this.#requireReconciliation('rate_basis_points_pin_required')
    }
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'reconciliation_required', updated_at = ?
         WHERE singleton = 1 AND state IN ('confirming', 'reconciliation_required')`,
        new Date().toISOString(),
      )
      if (update.rowsWritten === 1) this.#appendEvent('settlement_reconciliation_requested', {
        checkoutId: state.checkout_id, humanConfirmationDigest: digest, idempotencyKey: key,
      })
    })
    return this.#consumeSettlement(await reconcileSettlement(this.env, state, digest, key), true)
  }
  async #consumeSettlement(
    provider: SettlementProviderResult,
    idempotent: boolean,
  ): Promise<unknown> {
    if (!provider.ok) return this.#requireReconciliation(provider.code)
    const pending = this.#read()
    if (!pending) return rejected('checkout_persistence_failed')
    const appliedRateBasisPoints = readRateBasisPoints(pending.applied_rate_basis_points)
    if (appliedRateBasisPoints === null) return this.#requireReconciliation('rate_basis_points_pin_required')
    const markupOutbox = createSettlementMarkupOutbox(appliedRateBasisPoints, pending, provider.receipt, Date.now())
    let recorded = false
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'settled', provider_result_json = ?, settlement_receipt_json = ?,
          markup_outbox_json = ?, markup_finalization_state = 'pending', markup_finalization_json = NULL,
          failure_code = NULL,
          updated_at = ? WHERE singleton = 1 AND state IN ('confirming', 'reconciliation_required')`,
        canonicalJson(provider.payload),
        canonicalJson(provider.receipt),
        canonicalJson(markupOutbox),
        new Date().toISOString(),
      )
      recorded = update.rowsWritten === 1
      if (recorded) this.#appendEvent('settlement_recorded', provider.receipt)
    })
    const stored = this.#read()
    if (!stored?.provider_result_json) return rejected('checkout_persistence_failed')
    return this.#resumeSettledFinalization(stored, recorded ? idempotent : true)
  }

  async #resumeSettledFinalization(state: StoredCheckout, idempotent: boolean): Promise<unknown> {
    const providerResult = JSON.parse(state.provider_result_json ?? 'null') as unknown
    if (state.markup_finalization_state === 'completed' && state.markup_finalization_json) {
      return settledResult(providerResult, idempotent, JSON.parse(state.markup_finalization_json) as unknown)
    }
    let observationStopDisposition: 'completed' | 'deferred' = 'completed'
    try {
      await this.ctx.storage.setAlarm(Date.now() + OBSERVATION_INTERVAL_MS)
      this.#recordObservationStopped('settled')
    } catch {
      observationStopDisposition = 'deferred'
    }
    const receipt = await restoreSettlementReceipt(state.settlement_receipt_json, {
      checkoutId: state.checkout_id,
      offerId: state.offer_id,
      amountMinor: state.amount_minor,
      currency: state.currency,
      idempotencyKey: state.settlement_idempotency_key ?? '',
      humanConfirmationDigest: state.human_confirmation_digest ?? '',
      guardrailReceiptDigest: state.guardrail_receipt_digest ?? '',
      providerRevision: state.offer_provider_revision,
    })
    const markupOutbox = readSettlementMarkupOutbox(state.markup_outbox_json)
    let markup: MarkupOutcome
    try {
      markup = receipt && markupOutbox
        ? await recordSettlementMarkup(this.env, markupOutbox)
        : Object.freeze({ stage: 'deferred', failingStage: 'unexpected', attempts: 3 })
    } catch {
      markup = Object.freeze({ stage: 'deferred', failingStage: 'unexpected', attempts: 3 })
    }
    const retryAttempt = this.#events('markup_deferred').length + 1
    const retryAt = markup.stage === 'deferred'
      ? Date.now() + Math.min(MARKUP_RETRY_MAX_MS, OBSERVATION_INTERVAL_MS * (2 ** Math.min(retryAttempt - 1, 4)))
      : null
    const finalization = Object.freeze({
      ...markup,
      evidenceDisposition: 'persisted' as const,
      observationStopDisposition,
      retryAt,
    })
    try {
      this.ctx.storage.transactionSync(() => {
        if (markup.stage === 'deferred' || this.#events('markup_recorded').length === 0) {
          this.#appendEvent(
            markup.stage === 'recorded' ? 'markup_recorded' : 'markup_deferred',
            { settlementId: receipt?.settlementId ?? null, ...markup, retryAttempt, retryAt },
          )
        }
        this.#sql.exec(
          `UPDATE checkout_state SET markup_finalization_state = ?, markup_finalization_json = ?,
            updated_at = ? WHERE singleton = 1 AND state = 'settled'`,
          markup.stage === 'recorded' ? 'completed' : 'pending',
          canonicalJson(finalization),
          new Date().toISOString(),
        )
      })
    } catch {
      return settledResult(providerResult, idempotent, Object.freeze({
        ...markup,
        evidenceDisposition: 'response-only-deferred' as const,
        observationStopDisposition,
      }))
    }
    try {
      if (retryAt === null) await this.ctx.storage.deleteAlarm()
      else await this.ctx.storage.setAlarm(retryAt)
    } catch { /* The already-armed recovery alarm remains the fallback. */ }
    return settledResult(providerResult, idempotent, finalization)
  }

  async #armRecoveryAlarm(): Promise<boolean> {
    try { await this.ctx.storage.setAlarm(Date.now() + OBSERVATION_INTERVAL_MS) } catch { return false }
    return await this.ctx.storage.getAlarm() !== null
  }
  #recordObservation(outcome: ObservationOutcome): boolean {
    if (outcome.kind === 'changed') {
      this.ctx.storage.transactionSync(() => {
        for (const event of outcome.events) this.#appendEvent(event.eventType, event)
        this.#setObservationFailures(0)
      })
      return false
    }
    if (outcome.kind === 'agent-inactive') {
      if (this.#events('offer_agent_inactive').length === 0) {
        this.#appendEvent('offer_agent_inactive', { agentId: outcome.agentId, observedAt: new Date().toISOString() })
      }
      return false
    }
    if (outcome.kind === 'failed') {
      this.ctx.storage.transactionSync(() => {
        this.#setObservationFailures(outcome.attempt)
        this.#appendEvent('offer_observation_failed', {
          attempt: outcome.attempt,
          observedAt: new Date().toISOString(),
        })
      })
      return false
    }
    if (outcome.kind === 'suspended') {
      if (this.#events('offer_observation_suspended').length === 0) {
        this.#appendEvent('offer_observation_suspended', {
          attempts: MAXIMUM_OBSERVATION_RETRIES,
          observedAt: new Date().toISOString(),
        })
      }
      this.#setObservationFailures(MAXIMUM_OBSERVATION_RETRIES)
      return true
    }
    this.#setObservationFailures(0)
    return false
  }
  #unacknowledgedBlockingEvents(): StoredEvent[] {
    const acknowledged = new Set(this.#events('offer_change_acknowledged').map(({ evidence }) => (
      isRecord(evidence) && Number.isSafeInteger(evidence.eventSequence) ? Number(evidence.eventSequence) : -1
    )))
    return this.#events().filter(({ eventType }) => BLOCKING_EVENT_TYPES.includes(eventType))
      .filter(({ sequence }) => !acknowledged.has(sequence))
  }
  async #withOfferGate<Result>(operation: () => Promise<Result>): Promise<Result> {
    const prior = this.#offerGate
    let release: () => void = () => undefined
    this.#offerGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }
  async #stopObservation(reason: 'settled' | 'closed'): Promise<void> {
    this.#recordObservationStopped(reason)
    await this.ctx.storage.deleteAlarm()
  }
  #recordObservationStopped(reason: 'settled' | 'closed'): void {
    if (this.#events('offer_observation_stopped').length === 0) {
      this.#appendEvent('offer_observation_stopped', { reason, stoppedAt: new Date().toISOString() })
    }
  }
  #prepareFailure(code: string): unknown {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec("UPDATE checkout_state SET state = 'failed', failure_code = ?, updated_at = ? WHERE singleton = 1", code, new Date().toISOString())
      this.#appendEvent('checkout_prepare_failed', { code })
    })
    return rejected(code)
  }

  #requireReconciliation(code: string): unknown {
    this.ctx.storage.transactionSync(() => {
      const update = this.#sql.exec(
        `UPDATE checkout_state SET state = 'reconciliation_required', failure_code = ?, updated_at = ?
         WHERE singleton = 1 AND state IN ('confirming', 'reconciliation_required')`,
        code,
        new Date().toISOString(),
      )
      if (update.rowsWritten === 1) this.#appendEvent('settlement_reconciliation_required', { code })
    })
    const stored = this.#read()
    if (stored?.state === 'settled' && stored.provider_result_json) {
      return settledResult(JSON.parse(stored.provider_result_json) as unknown, true)
    }
    return Object.freeze({ ok: false, status: 'reconciliation_required', code })
  }

  async #terminalFailure(code: string): Promise<unknown> {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `UPDATE checkout_state SET state = 'failed', confirmation_token = NULL,
          failure_code = ?, updated_at = ? WHERE singleton = 1`,
        code,
        new Date().toISOString(),
      )
      this.#appendEvent('checkout_failed', { code })
    })
    await this.#stopObservation('closed')
    return rejected(code)
  }

  #setObservationFailures(value: number): void {
    this.#sql.exec('UPDATE checkout_state SET observation_failure_count = ? WHERE singleton = 1', value)
  }

  #appendEvent(eventType: string, evidence: unknown): number {
    this.#sql.exec(
      'INSERT INTO checkout_event (event_type, evidence_json, created_at) VALUES (?, ?, ?)',
      eventType,
      canonicalJson(evidence),
      new Date().toISOString(),
    )
    return this.#sql.exec<{ sequence: number }>('SELECT MAX(sequence) AS sequence FROM checkout_event').one()?.sequence ?? 0
  }

  #events(eventType?: string): StoredEvent[] {
    const rows = eventType
      ? this.#sql.exec<StoredEventRow>(
          'SELECT sequence, event_type, evidence_json, created_at FROM checkout_event WHERE event_type = ? ORDER BY sequence',
          eventType,
        ).toArray()
      : this.#sql.exec<StoredEventRow>(
          'SELECT sequence, event_type, evidence_json, created_at FROM checkout_event ORDER BY sequence',
        ).toArray()
    return rows.map((event) => Object.freeze({
      sequence: event.sequence,
      eventType: event.event_type,
      evidence: JSON.parse(event.evidence_json) as unknown,
      createdAt: event.created_at,
    }))
  }

  #read(): StoredCheckout | null {
    return this.#sql.exec<StoredCheckout>('SELECT * FROM checkout_state WHERE singleton = 1').toArray()[0] ?? null
  }
}

type StoredEventRow = Readonly<{
  sequence: number; event_type: string; evidence_json: string; created_at: string
}>

type StoredEvent = Readonly<{
  sequence: number; eventType: string; evidence: unknown; createdAt: string
}>

function isChangeEvent(value: unknown): value is ChangeEvent {
  return isRecord(value)
    && value.eventType === 'offer_changed'
    && ['priceMinor', 'available', 'agentActive'].includes(String(value.attribute))
    && 'observedValue' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
