import { isRecord, readJsonResponse } from '../shared/http.ts'
import { CHECKOUT_PROVIDER_CONTRACT, hasProviderContract } from './provider-contract.ts'
import {
  prepareCheckoutProviderOperation,
  responseMatchesOperationalEvidence,
} from './provider-operation-gate.ts'

export const OBSERVATION_INTERVAL_MS = 60_000
export const MAXIMUM_OBSERVATION_RETRIES = 3

export type ObservedAttributes = Readonly<{
  priceMinor: number
  available: boolean
  agentActive: boolean
}>

export type ChangeEvent = Readonly<{
  eventType: 'offer_changed'
  attribute: 'priceMinor' | 'available' | 'agentActive'
  recordedValue: unknown
  observedValue: unknown
  observedAt: string
}>

export type HeldOffer = Readonly<{
  offerId: string
  agentId: string
  recorded: ObservedAttributes
  priorChanges: readonly Pick<ChangeEvent, 'attribute' | 'observedValue'>[]
  failedAttempts: number
}>

export type ObservationOutcome =
  | Readonly<{ kind: 'unchanged'; observed: ObservedAttributes }>
  | Readonly<{ kind: 'changed'; events: readonly ChangeEvent[]; observed: ObservedAttributes }>
  | Readonly<{ kind: 'agent-inactive'; agentId: string; observed: ObservedAttributes }>
  | Readonly<{ kind: 'failed'; attempt: number }>
  | Readonly<{ kind: 'suspended'; attempts: 3 }>

export function diffObservation(
  recorded: ObservedAttributes,
  observed: ObservedAttributes,
  observedAt = new Date().toISOString(),
): readonly ChangeEvent[] {
  const events: ChangeEvent[] = []
  if (recorded.priceMinor !== observed.priceMinor) {
    events.push(change('priceMinor', recorded.priceMinor, observed.priceMinor, observedAt))
  }
  if (recorded.available !== observed.available) {
    events.push(change('available', recorded.available, observed.available, observedAt))
  }
  if (recorded.agentActive !== observed.agentActive) {
    events.push(change('agentActive', recorded.agentActive, observed.agentActive, observedAt))
  }
  return Object.freeze(events)
}

export async function observeHeldOffer(env: CoreEnv, held: HeldOffer): Promise<ObservationOutcome> {
  let response: Response
  try {
    const url = new URL(`/internal/v1/offers/${encodeURIComponent(held.offerId)}/observe`, 'https://commerce.internal')
    url.searchParams.set('agentId', held.agentId)
    const operation = await prepareCheckoutProviderOperation(env, new Request(url, {
      method: 'GET',
      headers: { 'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT },
      signal: AbortSignal.timeout(10_000),
    }))
    if (!operation.ok) throw new Error(operation.code)
    response = await env.CHECKOUT_PROVIDER.fetch(operation.request)
    if (!responseMatchesOperationalEvidence(response, operation.binding)) {
      throw new Error('offer_observation_evidence_binding_mismatch')
    }
    const payload = await readJsonResponse(response, 65_536)
    const providerAttributes = readProviderAttributes(payload)
    if (!response.ok || !providerAttributes) throw new Error('offer_observation_invalid')
    const registry = env.AGENT_REGISTRY.getByName(env.REGISTRY_ID) as unknown as Readonly<{
      list(): Promise<Readonly<{ agents: readonly Readonly<{
        agentId: string
        registrationState: string
        admissionVerified: boolean
      }>[] }>>
    }>
    const snapshot = await registry.list()
    const agentActive = snapshot.agents.some((agent) => (
      agent.agentId === held.agentId
      && agent.registrationState === 'active'
      && agent.admissionVerified
    ))
    const observed: ObservedAttributes = Object.freeze({ ...providerAttributes, agentActive })
    if (!observed.agentActive) return Object.freeze({ kind: 'agent-inactive', agentId: held.agentId, observed })
    const prior = new Set(held.priorChanges.map(({ attribute, observedValue }) => (
      `${attribute}:${JSON.stringify(observedValue)}`
    )))
    const events = diffObservation(held.recorded, observed).filter(({ attribute, observedValue }) => (
      !prior.has(`${attribute}:${JSON.stringify(observedValue)}`)
    ))
    return events.length === 0
      ? Object.freeze({ kind: 'unchanged', observed })
      : Object.freeze({ kind: 'changed', events: Object.freeze(events), observed })
  } catch {
    const attempt = Math.min(MAXIMUM_OBSERVATION_RETRIES, held.failedAttempts + 1)
    return attempt >= MAXIMUM_OBSERVATION_RETRIES
      ? Object.freeze({ kind: 'suspended', attempts: 3 })
      : Object.freeze({ kind: 'failed', attempt })
  }
}

function readProviderAttributes(value: unknown): Omit<ObservedAttributes, 'agentActive'> | null {
  if (!hasProviderContract(value, CHECKOUT_PROVIDER_CONTRACT)
    || value.ok !== true
    || !isRecord(value.observed)
    || !Number.isSafeInteger(value.observed.priceMinor)
    || Number(value.observed.priceMinor) < 0
    || typeof value.observed.available !== 'boolean') return null
  return Object.freeze({
    priceMinor: Number(value.observed.priceMinor),
    available: value.observed.available,
  })
}

function change(
  attribute: ChangeEvent['attribute'],
  recordedValue: unknown,
  observedValue: unknown,
  observedAt: string,
): ChangeEvent {
  return Object.freeze({ eventType: 'offer_changed', attribute, recordedValue, observedValue, observedAt })
}
