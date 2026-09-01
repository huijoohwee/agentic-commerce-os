import { env, runInDurableObject } from 'cloudflare:test'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CheckoutSession } from '../../src/core/checkout-session.ts'
import { digestCheckoutBlockers } from '../../src/core/checkout-state.ts'
import { DEV_PROVIDER_PINS } from '../../src/dev/provider.ts'
import { canonicalJson, sha256Hex } from '../../src/shared/digest.ts'

type BlockingEventType = 'offer_changed' | 'offer_observation_suspended' | 'offer_agent_inactive'
type Acknowledgement = 'missing' | 'wrong' | 'exact'

const sessionSequenceArbitrary = fc.record({
  events: fc.array(
    fc.constantFrom<BlockingEventType>(
      'offer_changed',
      'offer_observation_suspended',
      'offer_agent_inactive',
    ),
    { minLength: 1, maxLength: 6 },
  ),
  acknowledgement: fc.constantFrom<Acknowledgement>('missing', 'wrong', 'exact'),
  amountMinor: fc.integer({ min: 1, max: 1_000_000 }),
})

describe('checkout settlement-gate Worker property evidence', () => {
  it('Feature: agentic-graph-commerce-platform, Property 21: CP-21 — Settlement blocking after change', { timeout: 30_000 }, async () => {
    await fc.assert(fc.asyncProperty(sessionSequenceArbitrary, async ({ events, acknowledgement, amountMinor }) => {
      const checkoutId = `checkout-${crypto.randomUUID()}`
      const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
      const tokenDigest = await sha256Hex(token)
      const stub = env.CHECKOUT_SESSION.get(env.CHECKOUT_SESSION.newUniqueId())
      const evidence = await runInDurableObject(stub, async (instance, state) => {
        const session = instance as CheckoutSession
        seedConfirmationRequired(state, {
          checkoutId,
          confirmationToken: token,
          confirmationTokenDigest: tokenDigest,
          amountMinor,
        })
        const blockers = events.map((eventType, index) => Object.freeze({
          sequence: index + 1,
          eventType,
          evidence: eventEvidence(eventType, index),
        }))
        for (const blocker of blockers) {
          state.storage.sql.exec(
            'INSERT INTO checkout_event (event_type, evidence_json, created_at) VALUES (?, ?, ?)',
            blocker.eventType,
            canonicalJson(blocker.evidence),
            new Date(1_800_000_000_000 + blocker.sequence - 1).toISOString(),
          )
        }
        const exactBlockerDigest = await digestCheckoutBlockers(blockers)
        const blockerDigest = acknowledgement === 'exact'
          ? exactBlockerDigest
          : acknowledgement === 'wrong'
            ? 'f'.repeat(64)
            : await digestCheckoutBlockers([])
        const confirmation = {
          checkoutId,
          confirmationToken: token,
          offerId: 'offer-property',
          amountMinor,
          currency: 'USD',
          blockerDigest,
          shopperPrincipalDigest: 'd'.repeat(64),
        }
        const result = await session.confirm(confirmation)
        const status = await session.status()
        const storedEvents = state.storage.sql.exec<{
          sequence: number
          event_type: string
        }>('SELECT sequence, event_type FROM checkout_event ORDER BY sequence').toArray()
        return Object.freeze({ result, status, storedEvents })
      })

      const includesInactiveAgent = events.includes('offer_agent_inactive')
      const settlementIsAdmitted = acknowledgement === 'exact' && !includesInactiveAgent
      if (settlementIsAdmitted) {
        expect(evidence.result).toMatchObject({ ok: true, status: 'settled' })
        expect(evidence.status).toMatchObject({ ok: true, status: 'settled' })
        const eventTypes = evidence.storedEvents.map(({ event_type }) => event_type)
        expect(eventTypes.filter((eventType) => eventType === 'offer_change_acknowledged')).toHaveLength(events.length)
        expect(eventTypes.indexOf('human_confirmed')).toBeGreaterThan(events.length - 1)
        expect(eventTypes.indexOf('settlement_recorded')).toBeGreaterThan(eventTypes.indexOf('human_confirmed'))
        return
      }

      expect(evidence.result).toMatchObject({
        ok: false,
        status: 'rejected',
        code: includesInactiveAgent ? 'offer_agent_inactive' : 'offer_reconfirmation_required',
      })
      expect(evidence.status).toMatchObject({ ok: true, status: 'confirmation_required' })
      expect(evidence.storedEvents.some(({ event_type }) => event_type === 'human_confirmed')).toBe(false)
      expect(evidence.storedEvents.some(({ event_type }) => event_type === 'settlement_recorded')).toBe(false)
    }), { numRuns: 500, seed: 21_021 })
  })

  it('observes an ambiguous session before read-only reconciliation and re-arms unknown status', async () => {
    for (const disposition of ['settled', 'unknown'] as const) {
      const checkoutId = `checkout-reconcile-alarm-${disposition}-${crypto.randomUUID()}`
      const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
      const tokenDigest = await sha256Hex(token)
      const stub = env.CHECKOUT_SESSION.get(env.CHECKOUT_SESSION.newUniqueId())
      const evidence = await runInDurableObject(stub, async (instance, state) => {
        const session = instance as CheckoutSession
        seedConfirmationRequired(state, {
          checkoutId,
          confirmationToken: token,
          confirmationTokenDigest: tokenDigest,
          amountMinor: 12_500,
        })
        const first = await session.confirm({
          checkoutId,
          confirmationToken: token,
          offerId: 'offer-property',
          amountMinor: 12_500,
          currency: 'USD',
          blockerDigest: await digestCheckoutBlockers([]),
          shopperPrincipalDigest: 'd'.repeat(64),
        })
        const persistedRateBeforeReconciliation = state.storage.sql.exec<{
          applied_rate_basis_points: number | null
        }>('SELECT applied_rate_basis_points FROM checkout_state WHERE singleton = 1').one()
          ?.applied_rate_basis_points
        await session.alarm()
        const status = await session.status() as Readonly<{
          status: string
          events: readonly Readonly<{ eventType: string }>[]
        }>
        return Object.freeze({
          first,
          status,
          alarm: await state.storage.getAlarm(),
          persistedRateBeforeReconciliation,
        })
      })
      expect(evidence.first).toMatchObject({ ok: false, status: 'reconciliation_required' })
      expect(evidence.persistedRateBeforeReconciliation).toBe(250)
      const counts = await env.CHECKOUT_PROVIDER.fetch(
        `https://commerce.internal/__test__/checkout-provider-counts/${encodeURIComponent(checkoutId)}`,
      ).then((response) => response.json<{ confirmPosts: number; statusGets: number }>())
      expect(counts).toEqual({ confirmPosts: 1, statusGets: 1 })
      const events = evidence.status.events.map(({ eventType }) => eventType)
      expect(events.indexOf('offer_agent_inactive')).toBeGreaterThan(-1)
      expect(events.indexOf('settlement_reconciliation_requested'))
        .toBeGreaterThan(events.indexOf('offer_agent_inactive'))
      if (disposition === 'settled') {
        expect(evidence.status.status).toBe('settled')
        expect(events.indexOf('settlement_recorded')).toBeGreaterThan(events.indexOf('offer_agent_inactive'))
      } else {
        expect(evidence.status.status).toBe('reconciliation_required')
        expect(events).not.toContain('settlement_recorded')
        expect(evidence.alarm).toEqual(expect.any(Number))
      }
    }
  })
})

function seedConfirmationRequired(
  state: DurableObjectState,
  input: Readonly<{
    checkoutId: string
    confirmationToken: string
    confirmationTokenDigest: string
    amountMinor: number
  }>,
): void {
  state.storage.sql.exec(
    `INSERT INTO checkout_state (
      singleton, checkout_id, request_digest, intent_id, agent_id, offer_id,
      offer_receipt_digest, offer_provider_revision, amount_minor, budget_minor,
      currency, state, guardrail_receipt_json, guardrail_receipt_digest,
      confirmation_token, confirmation_token_digest, confirmation_expires_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmation_required', ?, ?, ?, ?, ?, ?)`,
    input.checkoutId,
    'a'.repeat(64),
    'intent-property',
    'agent-property',
    'offer-property',
    'b'.repeat(64),
    DEV_PROVIDER_PINS.checkoutEvidence.sourceRevision,
    input.amountMinor,
    input.amountMinor,
    'USD',
    canonicalJson({ seeded: true }),
    'c'.repeat(64),
    input.confirmationToken,
    input.confirmationTokenDigest,
    Date.now() + 60_000,
    new Date().toISOString(),
  )
}

function eventEvidence(eventType: BlockingEventType, index: number): Readonly<Record<string, unknown>> {
  const observedAt = new Date(1_800_000_000_000 + index).toISOString()
  if (eventType === 'offer_changed') {
    return Object.freeze({
      eventType,
      attribute: 'priceMinor',
      recordedValue: 100,
      observedValue: 101 + index,
      observedAt,
    })
  }
  if (eventType === 'offer_agent_inactive') {
    return Object.freeze({ agentId: 'agent-property', observedAt })
  }
  return Object.freeze({ attempts: 3, observedAt })
}
