import { env, runInDurableObject } from 'cloudflare:test'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { AgentRegistryRecord } from '../../src/core/agent-registry.ts'
import {
  DISCOVERY_DISPATCH_DEADLINE_MS,
  IntentRoute,
  dispatchSelectedWithFallback,
} from '../../src/core/intent-route.ts'
import {
  routeIntentExclusively,
  type RegisteredAgent,
  type RoutingIntent,
} from '../../src/domain/exclusive-category-router.ts'

const SUCCESS_TOOL = 'commerce.flight.discover'
const TIMEOUT_TOOL = 'commerce.test.timeout'

type DispatchArm = 'no-match' | 'selected' | 'fallback' | 'exhausted'

const dispatchArmArbitrary = fc.constantFrom<DispatchArm>('no-match', 'selected', 'fallback', 'exhausted')
const constraintArbitrary = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/u),
  fc.oneof(fc.boolean(), fc.integer({ min: -1_000, max: 1_000 }), fc.string({ maxLength: 24 })),
  { maxKeys: 5 },
)

describe('exclusive dispatch Worker property evidence', () => {
  it('gives selected and fallback dispatch distinct 30-second attempt deadlines', async () => {
    expect(DISCOVERY_DISPATCH_DEADLINE_MS).toBe(30_000)
    const selectedDeadline = new AbortController()
    const fallbackDeadline = new AbortController()
    const observedSignals: AbortSignal[] = []
    const completed = await dispatchSelectedWithFallback(
      async (signal) => {
        observedSignals.push(signal)
        selectedDeadline.abort(new DOMException('selected attempt deadline elapsed', 'TimeoutError'))
        expect(signal.aborted).toBe(true)
        return failedAttempt('agent-selected', 'selected', 'timeout', 'discovery_timeout')
      },
      async (signal) => {
        observedSignals.push(signal)
        expect(signal.aborted).toBe(false)
        return completedAttempt('agent-fallback', 'fallback')
      },
      (role) => role === 'selected' ? selectedDeadline.signal : fallbackDeadline.signal,
    )
    expect(completed).toMatchObject({ ok: true, attempts: [{ role: 'selected' }, { role: 'fallback' }] })
    expect(observedSignals).toEqual([selectedDeadline.signal, fallbackDeadline.signal])

    const exhaustedDeadlines = [new AbortController(), new AbortController()]
    const deadlineRoles: Array<'selected' | 'fallback'> = []
    const exhausted = await dispatchSelectedWithFallback(
      async (signal) => {
        exhaustedDeadlines[0]?.abort(new DOMException('selected attempt deadline elapsed', 'TimeoutError'))
        expect(signal.aborted).toBe(true)
        return failedAttempt('agent-selected', 'selected', 'timeout', 'discovery_timeout')
      },
      async (signal) => {
        exhaustedDeadlines[1]?.abort(new DOMException('fallback attempt deadline elapsed', 'TimeoutError'))
        expect(signal.aborted).toBe(true)
        return failedAttempt('agent-fallback', 'fallback', 'timeout', 'discovery_timeout')
      },
      (role) => {
        deadlineRoles.push(role)
        return exhaustedDeadlines[deadlineRoles.length - 1]?.signal ?? AbortSignal.abort()
      },
    )
    expect(exhausted).toMatchObject({
      ok: false,
      code: 'dispatch_exhausted',
      attempts: [
        { role: 'selected', outcome: 'timeout' },
        { role: 'fallback', outcome: 'timeout' },
      ],
    })
    expect(deadlineRoles).toEqual(['selected', 'fallback'])
  })

  it('Feature: agentic-graph-commerce-platform, Property 14: CP-14 — Dispatch count totality', { timeout: 35_000 }, async () => {
    await fc.assert(fc.asyncProperty(
      dispatchArmArbitrary,
      constraintArbitrary,
      async (arm, constraints) => {
        const intent: RoutingIntent = Object.freeze({
          intentId: `intent-${crypto.randomUUID()}`,
          category: 'flight',
          constraints: Object.freeze({ ...constraints }),
        })
        const registry = arm === 'no-match' ? noMatchRegistry() : eligibleRegistry()
        const decision = routeIntentExclusively(intent, registry)

        if (arm === 'no-match') {
          expect(decision).toMatchObject({
            status: 'no-dispatch',
            intentId: intent.intentId,
            reason: 'unmatched-category',
          })
          return
        }

        if (decision.status !== 'dispatch') throw new Error('eligible generated registry did not dispatch')
        const selectedTool = arm === 'selected' ? SUCCESS_TOOL : TIMEOUT_TOOL
        const fallbackTool = arm === 'exhausted' ? TIMEOUT_TOOL : SUCCESS_TOOL
        const stub = env.INTENT_ROUTE.get(env.INTENT_ROUTE.newUniqueId())
        const result = await runInDurableObject(stub, (instance) => {
          const route = instance as IntentRoute
          return route.dispatch({
            intent,
            agent: dispatchRecord(decision.agentId, selectedTool),
            fallbackAgent: decision.fallbackAgentId
              ? dispatchRecord(decision.fallbackAgentId, fallbackTool)
              : null,
          })
        })

        if (!isDispatchResult(result)) throw new Error('dispatch returned an untyped result')
        const expectedAttempts = arm === 'selected' ? 1 : 2
        expect(result.attempts).toHaveLength(expectedAttempts)
        expect(result.attempts.map(({ role }) => role)).toEqual(
          expectedAttempts === 1 ? ['selected'] : ['selected', 'fallback'],
        )
        expect(result.attempts.every(({ startedAt, completedAt }) => (
          Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(completedAt))
        ))).toBe(true)

        if (arm === 'exhausted') {
          expect(result).toMatchObject({ ok: false, status: 'unknown', code: 'dispatch_exhausted' })
          expect(result.attempts.map(({ outcome }) => outcome)).toEqual(['timeout', 'timeout'])
        } else {
          expect(result).toMatchObject({ ok: true, status: 'completed' })
          expect(result.attempts.at(-1)?.outcome).toBe('completed')
        }


        const deadlineEvidence = await injectedDeadlineDispatch(arm)
        expect(deadlineEvidence.attempts).toHaveLength(expectedAttempts)
        expect(deadlineEvidence.deadlineRoles).toEqual(
          expectedAttempts === 1 ? ['selected'] : ['selected', 'fallback'],
        )
        if (expectedAttempts === 2) {
          expect(deadlineEvidence.signals[0]).not.toBe(deadlineEvidence.signals[1])
          expect(deadlineEvidence.signals[0]?.aborted).toBe(true)
        }
      },
    ), { numRuns: 500, seed: 14_014 })
  })
})

function eligibleRegistry(): readonly RegisteredAgent[] {
  return Object.freeze([
    Object.freeze({
      agentId: 'agent-selected',
      category: 'flight',
      declaredAttributes: Object.freeze({ priceMinor: 100, qualityScore: 100, latencyMs: 10 }),
      fallbackAgentId: 'agent-fallback',
      admissionVerified: true,
      registrationState: 'active' as const,
    }),
    Object.freeze({
      agentId: 'agent-fallback',
      category: 'flight',
      declaredAttributes: Object.freeze({ priceMinor: 200, qualityScore: 0, latencyMs: 100 }),
      fallbackAgentId: null,
      admissionVerified: true,
      registrationState: 'active' as const,
    }),
  ])
}

function noMatchRegistry(): readonly RegisteredAgent[] {
  return Object.freeze([
    Object.freeze({
      agentId: 'agent-inactive',
      category: 'flight',
      declaredAttributes: Object.freeze({ priceMinor: 100, qualityScore: 100, latencyMs: 10 }),
      fallbackAgentId: null,
      admissionVerified: true,
      registrationState: 'inactive' as const,
    }),
    Object.freeze({
      agentId: 'agent-other-category',
      category: 'shopping',
      declaredAttributes: Object.freeze({ priceMinor: 100, qualityScore: 100, latencyMs: 10 }),
      fallbackAgentId: null,
      admissionVerified: true,
      registrationState: 'active' as const,
    }),
  ])
}

function dispatchRecord(agentId: string, discoveryTool: string): AgentRegistryRecord {
  return Object.freeze({ agentId, discoveryTool }) as AgentRegistryRecord
}

function completedAttempt(agentId: string, role: 'selected' | 'fallback') {
  return Object.freeze({
    ok: true as const,
    result: Object.freeze({ ok: true }),
    attempt: Object.freeze({
      agentId,
      role,
      outcome: 'completed' as const,
      startedAt: '2026-08-30T00:00:00.000Z',
      completedAt: '2026-08-30T00:00:00.001Z',
    }),
  })
}

function failedAttempt(
  agentId: string,
  role: 'selected' | 'fallback',
  outcome: 'timeout' | 'failed',
  code: string,
) {
  return Object.freeze({
    ok: false as const,
    code,
    attempt: Object.freeze({
      agentId,
      role,
      outcome,
      startedAt: '2026-08-30T00:00:00.000Z',
      completedAt: '2026-08-30T00:00:00.001Z',
    }),
  })
}

async function injectedDeadlineDispatch(arm: Exclude<DispatchArm, 'no-match'>) {
  const controllers = [new AbortController(), new AbortController()]
  const deadlineRoles: Array<'selected' | 'fallback'> = []
  const signals: AbortSignal[] = []
  const dispatch = await dispatchSelectedWithFallback(
    async (signal) => {
      signals.push(signal)
      if (arm === 'selected') return completedAttempt('agent-selected', 'selected')
      controllers[0]?.abort(new DOMException('selected attempt deadline elapsed', 'TimeoutError'))
      expect(signal.aborted).toBe(true)
      return failedAttempt('agent-selected', 'selected', 'timeout', 'discovery_timeout')
    },
    async (signal) => {
      signals.push(signal)
      expect(signal.aborted).toBe(false)
      if (arm === 'fallback') return completedAttempt('agent-fallback', 'fallback')
      controllers[1]?.abort(new DOMException('fallback attempt deadline elapsed', 'TimeoutError'))
      expect(signal.aborted).toBe(true)
      return failedAttempt('agent-fallback', 'fallback', 'timeout', 'discovery_timeout')
    },
    (role) => {
      deadlineRoles.push(role)
      return controllers[deadlineRoles.length - 1]?.signal ?? AbortSignal.abort()
    },
  )
  return Object.freeze({ ...dispatch, deadlineRoles: Object.freeze(deadlineRoles), signals: Object.freeze(signals) })
}

type DispatchResult = Readonly<{
  ok: boolean
  status: string
  code?: string
  attempts: readonly Readonly<{
    role: 'selected' | 'fallback'
    outcome: 'completed' | 'timeout' | 'failed'
    startedAt: string
    completedAt: string
  }>[]
}>

function isDispatchResult(value: unknown): value is DispatchResult {
  return isRecord(value)
    && typeof value.ok === 'boolean'
    && typeof value.status === 'string'
    && Array.isArray(value.attempts)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
