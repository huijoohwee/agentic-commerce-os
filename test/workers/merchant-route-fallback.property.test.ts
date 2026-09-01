import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  type AgentRegistryRecord,
  type InvocationPinProof,
} from '../../src/core/agent-registry.ts'
import { resolveEligibleMerchantFallback } from '../../src/core/core-actions.ts'
import { DISCOVERY_DISPATCH_DEADLINE_MS, IntentRoute } from '../../src/core/intent-route.ts'
import { DEV_PROVIDER_PINS } from '../../src/dev/provider.ts'
import {
  routeIntentExclusively,
  type DispatchDecision,
  type RoutingIntent,
} from '../../src/domain/exclusive-category-router.ts'
import { DEFAULT_SELECTION_POLICY } from '../../src/domain/selection-policy.ts'

const OWNER_ID = 'merchant-owner'
const FALLBACK_ID = 'merchant-fallback'
const SUCCESS_TOOL = 'commerce.flight.discover'
const TIMEOUT_TOOL = 'commerce.test.timeout'
const INVOCATION_PROOF: InvocationPinProof = Object.freeze({
  sourceRevision: DEV_PROVIDER_PINS.sourceRevision,
  catalogDigest: DEV_PROVIDER_PINS.catalogDigest,
  routingSchema: DEV_PROVIDER_PINS.routingSchema,
  routingDigest: DEV_PROVIDER_PINS.routingDigest,
  counts: DEV_PROVIDER_PINS.counts,
  requiredTokens: DEV_PROVIDER_PINS.requiredTokens,
})

describe('merchant-pinned fallback dispatch evidence', () => {
  it('dispatches one scoped eligible fallback after the pinned owner times out', async () => {
    expect(DISCOVERY_DISPATCH_DEADLINE_MS).toBe(30_000)
    const agents = merchantAgents()
    const fallback = resolveEligibleMerchantFallback(
      agents,
      OWNER_ID,
      'flight',
      [OWNER_ID, FALLBACK_ID],
      INVOCATION_PROOF,
    )
    expect(fallback?.agentId).toBe(FALLBACK_ID)

    const decision = pinnedDecision(agents, fallback?.agentId ?? null)
    expect(decision).toMatchObject({
      agentId: OWNER_ID,
      fallbackAgentId: FALLBACK_ID,
      consideredAgentIds: [OWNER_ID],
    })
    expect(Object.keys(decision.decidingAttributes)).toEqual([OWNER_ID])

    const evidence = await dispatch(decision, agents)
    expect(evidence.result).toMatchObject({
      ok: true,
      status: 'completed',
      agentId: FALLBACK_ID,
      attempts: [
        { agentId: OWNER_ID, role: 'selected', outcome: 'timeout' },
        { agentId: FALLBACK_ID, role: 'fallback', outcome: 'completed' },
      ],
    })
    expect(evidence.result.attempts.filter(({ role }) => role === 'fallback')).toHaveLength(1)
    expect(evidence.status).toMatchObject({ fallbackAgentId: FALLBACK_ID })
    expect(evidence.persistedFallbackAgentId).toBe(FALLBACK_ID)
  })

  it.each([
    ['outside activated catalog scope', merchantAgents(), [OWNER_ID]],
    ['inactive', merchantAgents({ fallbackState: 'inactive' }), [OWNER_ID, FALLBACK_ID]],
    ['invocation-misaligned', merchantAgents({ fallbackAligned: false }), [OWNER_ID, FALLBACK_ID]],
    ['undeclared by owner', merchantAgents({ ownerFallbackAgentId: null }), [OWNER_ID, FALLBACK_ID]],
    ['in a different category', merchantAgents({ fallbackCategory: 'shopping' }), [OWNER_ID, FALLBACK_ID]],
  ] as const)('dispatches zero fallback attempts when the declared fallback is %s', async (_reason, agents, scope) => {
    const fallback = resolveEligibleMerchantFallback(agents, OWNER_ID, 'flight', scope, INVOCATION_PROOF)
    expect(fallback).toBeNull()

    const decision = pinnedDecision(agents, null)
    expect(decision).toMatchObject({
      agentId: OWNER_ID,
      fallbackAgentId: null,
      consideredAgentIds: [OWNER_ID],
    })
    const evidence = await dispatch(decision, agents)
    expect(evidence.result).toMatchObject({
      ok: false,
      status: 'unknown',
      code: 'dispatch_exhausted',
      attempts: [{ agentId: OWNER_ID, role: 'selected', outcome: 'timeout' }],
    })
    expect(evidence.result.attempts.filter(({ role }) => role === 'fallback')).toHaveLength(0)
    expect(evidence.status).toMatchObject({ fallbackAgentId: null })
    expect(evidence.persistedFallbackAgentId).toBeNull()
  })

  it('rejects a request-supplied fallback field before it can widen merchant scope', () => {
    const decision = routeIntentExclusively({
      ...intent(),
      fallbackAgentId: FALLBACK_ID,
    }, merchantAgents(), DEFAULT_SELECTION_POLICY, {
      pinnedAgentId: OWNER_ID,
      fallbackAgentId: null,
    })
    expect(decision).toMatchObject({ status: 'no-dispatch', reason: 'invalid-intent' })
  })
})

function pinnedDecision(
  agents: readonly AgentRegistryRecord[],
  fallbackAgentId: string | null,
): DispatchDecision {
  const decision = routeIntentExclusively(intent(), agents, DEFAULT_SELECTION_POLICY, {
    pinnedAgentId: OWNER_ID,
    fallbackAgentId,
  })
  if (decision.status !== 'dispatch') throw new Error(`merchant route did not dispatch: ${decision.reason}`)
  return decision
}

async function dispatch(
  decision: DispatchDecision,
  agents: readonly AgentRegistryRecord[],
): Promise<Readonly<{
  result: DispatchResult
  status: unknown
  persistedFallbackAgentId: string | null
}>> {
  const selected = agents.find(({ agentId }) => agentId === decision.agentId)
  const fallback = decision.fallbackAgentId === null
    ? null
    : agents.find(({ agentId }) => agentId === decision.fallbackAgentId) ?? null
  if (!selected) throw new Error('selected merchant agent fixture is missing')
  const stub = env.INTENT_ROUTE.get(env.INTENT_ROUTE.newUniqueId())
  return runInDurableObject(stub, async (instance, state) => {
    const route = instance as IntentRoute
    const result = await route.dispatch({ intent: decision.discoveryInput, agent: selected, fallbackAgent: fallback })
    if (!isDispatchResult(result)) throw new Error('intent route returned an untyped result')
    const status = await route.status()
    const row = state.storage.sql.exec<{ fallback_agent_id: string | null }>(
      'SELECT fallback_agent_id FROM intent_dispatch WHERE singleton = 1',
    ).one()
    return Object.freeze({ result, status, persistedFallbackAgentId: row.fallback_agent_id })
  })
}

function intent(): RoutingIntent {
  return Object.freeze({
    intentId: `merchant-intent-${crypto.randomUUID()}`,
    category: 'flight',
    constraints: Object.freeze({ origin: 'SIN', destination: 'NRT' }),
    merchantId: 'merchant-one',
    listingId: OWNER_ID,
  })
}

function merchantAgents(options: Readonly<{
  ownerFallbackAgentId?: string | null
  fallbackState?: 'active' | 'inactive'
  fallbackAligned?: boolean
  fallbackCategory?: string
}> = {}): readonly AgentRegistryRecord[] {
  return Object.freeze([
    registryRecord({
      agentId: OWNER_ID,
      category: 'flight',
      fallbackAgentId: options.ownerFallbackAgentId === undefined ? FALLBACK_ID : options.ownerFallbackAgentId,
      discoveryTool: TIMEOUT_TOOL,
      declaredAttributes: { priceMinor: 90_000, qualityScore: 1, latencyMs: 90_000 },
    }),
    registryRecord({
      agentId: FALLBACK_ID,
      category: options.fallbackCategory ?? 'flight',
      fallbackAgentId: null,
      discoveryTool: SUCCESS_TOOL,
      ...(options.fallbackState === undefined ? {} : { registrationState: options.fallbackState }),
      ...(options.fallbackAligned === undefined ? {} : { invocationAligned: options.fallbackAligned }),
      declaredAttributes: { priceMinor: 1, qualityScore: 100, latencyMs: 1 },
    }),
  ])
}

function registryRecord(input: Readonly<{
  agentId: string
  category: string
  fallbackAgentId: string | null
  discoveryTool: string
  declaredAttributes: Readonly<{ priceMinor: number; qualityScore: number; latencyMs: number }>
  registrationState?: 'active' | 'inactive'
  invocationAligned?: boolean
}>): AgentRegistryRecord {
  const invocationProof = input.invocationAligned === false
    ? Object.freeze({ ...INVOCATION_PROOF, routingDigest: 'f'.repeat(64) })
    : INVOCATION_PROOF
  return Object.freeze({
    agentId: input.agentId,
    category: input.category,
    declaredAttributes: Object.freeze({ ...input.declaredAttributes }),
    fallbackAgentId: input.fallbackAgentId,
    admissionVerified: true,
    registrationState: input.registrationState ?? 'active',
    invocationProof,
    admissionReceipt: Object.freeze({ invocation_register_tokens: INVOCATION_PROOF.requiredTokens }),
    discoveryTool: input.discoveryTool,
  }) as unknown as AgentRegistryRecord
}

type DispatchResult = Readonly<{
  ok: boolean
  status: string
  code?: string
  agentId: string
  attempts: readonly Readonly<{
    agentId: string
    role: 'selected' | 'fallback'
    outcome: 'completed' | 'timeout' | 'failed'
  }>[]
}>

function isDispatchResult(value: unknown): value is DispatchResult {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).ok === 'boolean'
    && typeof (value as Record<string, unknown>).status === 'string'
    && Array.isArray((value as Record<string, unknown>).attempts)
}
