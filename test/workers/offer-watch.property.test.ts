import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  MAXIMUM_OBSERVATION_RETRIES,
  observeHeldOffer,
  type ChangeEvent,
  type ObservedAttributes,
} from '../../src/core/offer-watch.ts'
import { CHECKOUT_PROVIDER_CONTRACT } from '../../src/core/provider-contract.ts'
import {
  operationalEvidenceResponseHeaders,
  readOperationalEvidenceBinding,
} from '../../src/core/provider-operation-gate.ts'
import { CHECKOUT_EVIDENCE_CHECKS } from '../../src/core/upstream-evidence.ts'
import { DEV_PROVIDER_PINS, devProviderFetch } from '../../src/dev/provider.ts'

const EXACT_PROVIDER_CONTRACT = Symbol('exact-provider-contract')
const MISSING_PROVIDER_CONTRACT = Symbol('missing-provider-contract')

const activeObservationArbitrary: fc.Arbitrary<ObservedAttributes> = fc.record({
  priceMinor: fc.nat({ max: 1_000_000 }),
  available: fc.boolean(),
}).map((observed) => Object.freeze({ ...observed, agentActive: true }))

const observationSequenceArbitrary = fc.tuple(
  activeObservationArbitrary,
  fc.array(fc.record({
    observed: activeObservationArbitrary,
    repeat: fc.boolean(),
  }), { minLength: 1, maxLength: 8 }),
).map(([recorded, steps]) => {
  const generated = steps.flatMap(({ observed, repeat }): readonly ObservedAttributes[] => (
    repeat ? [observed, observed] : [observed]
  ))
  return Object.freeze({
    recorded,
    sequence: Object.freeze([recorded, ...generated, generated[0] ?? recorded]),
  })
})

describe('held-offer observation Worker property evidence', () => {
  it('Feature: agentic-graph-commerce-platform, Property 20: CP-20 — Change-event idempotence', { timeout: 30_000 }, async () => {
    await fc.assert(fc.asyncProperty(observationSequenceArbitrary, async ({ recorded, sequence }) => {
      let providerCalls = 0
      let current = recorded
      const testEnv = observationEnvironment(() => {
        providerCalls += 1
        return current
      })
      const priorChanges: Pick<ChangeEvent, 'attribute' | 'observedValue'>[] = []
      const seen = new Set<string>()

      for (const observed of sequence) {
        current = observed
        const outcome = await observeHeldOffer(testEnv, Object.freeze({
          offerId: 'offer-property',
          agentId: 'agent-property',
          recorded,
          priorChanges: Object.freeze([...priorChanges]),
          failedAttempts: 0,
        }))
        const expectedDifferences = differences(recorded, observed)
          .filter(({ attribute, observedValue }) => !seen.has(changeIdentity(attribute, observedValue)))

        if (expectedDifferences.length === 0) {
          expect(outcome.kind).toBe('unchanged')
          continue
        }
        if (outcome.kind !== 'changed') throw new Error('distinct observation did not emit change evidence')
        expect(outcome.events.map(({ attribute, observedValue }) => ({ attribute, observedValue })))
          .toEqual(expectedDifferences)
        for (const event of outcome.events) {
          expect(event.eventType).toBe('offer_changed')
          expect(event.recordedValue).toBe(recorded[event.attribute])
          expect(event.observedValue).toBe(observed[event.attribute])
          expect(Number.isFinite(Date.parse(event.observedAt))).toBe(true)
          const identity = changeIdentity(event.attribute, event.observedValue)
          expect(seen.has(identity)).toBe(false)
          seen.add(identity)
          priorChanges.push(Object.freeze({ attribute: event.attribute, observedValue: event.observedValue }))
        }
      }

      expect(providerCalls).toBe(sequence.length)
    }), { numRuns: 300, seed: 20_020 })
  })

  it('refuses missing or mismatched provider contracts before accepting observed attributes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.string({ maxLength: 80 }), { nil: undefined })
        .filter((contract) => contract !== CHECKOUT_PROVIDER_CONTRACT),
      fc.integer({ min: 0, max: MAXIMUM_OBSERVATION_RETRIES - 1 }),
      async (contract, failedAttempts) => {
        let registryReads = 0
        let observedHeader: string | null = null
        const testEnv = observationEnvironment(
          () => Object.freeze({ priceMinor: 12_500, available: true, agentActive: true }),
          contract === undefined ? MISSING_PROVIDER_CONTRACT : contract,
          () => { registryReads += 1 },
          (header) => { observedHeader = header },
        )

        const outcome = await observeHeldOffer(testEnv, Object.freeze({
          offerId: 'offer-contract',
          agentId: 'agent-property',
          recorded: Object.freeze({ priceMinor: 12_500, available: true, agentActive: true }),
          priorChanges: Object.freeze([]),
          failedAttempts,
        }))

        expect(observedHeader).toBe(CHECKOUT_PROVIDER_CONTRACT)
        expect(registryReads).toBe(0)
        expect(outcome).toEqual(failedAttempts >= MAXIMUM_OBSERVATION_RETRIES - 1
          ? { kind: 'suspended', attempts: 3 }
          : { kind: 'failed', attempt: failedAttempts + 1 })
      },
    ), { numRuns: 150, seed: 20_021 })
  })
})

function observationEnvironment(
  readObserved: () => ObservedAttributes,
  providerContract: unknown = EXACT_PROVIDER_CONTRACT,
  onRegistryRead: () => void = () => {},
  onRequestContract: (contract: string | null) => void = () => {},
): CoreEnv {
  const checkoutProvider = Object.freeze({
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === '/v1/runtime-evidence') return devProviderFetch(request)
      onRequestContract(request.headers.get('x-commerce-contract'))
      const binding = await readOperationalEvidenceBinding(
        request,
        DEV_PROVIDER_PINS.checkoutEvidence,
        CHECKOUT_EVIDENCE_CHECKS,
      )
      const observed = readObserved()
      const responseContract = providerContract === EXACT_PROVIDER_CONTRACT
        ? CHECKOUT_PROVIDER_CONTRACT
        : providerContract === MISSING_PROVIDER_CONTRACT ? undefined : providerContract
      return Response.json({
        ok: true,
        ...(responseContract === undefined ? {} : { contract: responseContract }),
        observed: { priceMinor: observed.priceMinor, available: observed.available },
      }, { headers: binding ? operationalEvidenceResponseHeaders(binding) : {} })
    },
  })
  const registry = Object.freeze({
    getByName: () => Object.freeze({
      list: async () => {
        onRegistryRead()
        return Object.freeze({
          agents: Object.freeze([Object.freeze({
            agentId: 'agent-property',
            registrationState: 'active',
            admissionVerified: true,
          })]),
        })
      },
    }),
  })
  return Object.freeze({
    CHECKOUT_PROVIDER: checkoutProvider,
    CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify(DEV_PROVIDER_PINS.checkoutEvidence),
    AGENT_REGISTRY: registry,
    REGISTRY_ID: 'property-registry',
  }) as unknown as CoreEnv
}

function differences(
  recorded: ObservedAttributes,
  observed: ObservedAttributes,
): readonly Pick<ChangeEvent, 'attribute' | 'observedValue'>[] {
  const changed: Pick<ChangeEvent, 'attribute' | 'observedValue'>[] = []
  if (recorded.priceMinor !== observed.priceMinor) {
    changed.push(Object.freeze({ attribute: 'priceMinor', observedValue: observed.priceMinor }))
  }
  if (recorded.available !== observed.available) {
    changed.push(Object.freeze({ attribute: 'available', observedValue: observed.available }))
  }
  return changed
}

function changeIdentity(attribute: ChangeEvent['attribute'], observedValue: unknown): string {
  return `${attribute}:${JSON.stringify(observedValue)}`
}
