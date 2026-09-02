import { DurableObject } from 'cloudflare:workers'

import type { AgentRegistryRecord } from './agent-registry.js'
import { normalizeDiscoveryReceipt } from './discovery-receipt.js'
import { readUpstreamEvidencePin } from './upstream-evidence.js'
import { callMcpTool } from './mcp-provider.js'
import { discoveryOperationalEvidence } from './provider-operation-gate.js'
import { canonicalJson, sha256Hex } from '../shared/digest.js'
import type { RoutingIntent } from '../domain/exclusive-category-router.js'

export type IntentDispatchInput = Readonly<{
  intent: RoutingIntent
  agent: AgentRegistryRecord
  fallbackAgent: AgentRegistryRecord | null
}>

export type DispatchAttempt = Readonly<{
  agentId: string
  role: 'selected' | 'fallback'
  outcome: 'completed' | 'timeout' | 'failed'
  startedAt: string
  completedAt: string | null
}>

export const DISCOVERY_DISPATCH_DEADLINE_MS = 30_000

type AgentDispatchResult<Result> = Readonly<{
  ok: true
  result: Result
  attempt: DispatchAttempt
}> | Readonly<{
  ok: false
  code: string
  attempt: DispatchAttempt
}>

type DispatchSequenceResult<Result> = Readonly<{
  ok: true
  result: Result
  attempts: readonly DispatchAttempt[]
}> | Readonly<{
  ok: false
  code: string
  agentId: string
  attempts: readonly DispatchAttempt[]
}>

export type DispatchAttemptSignalFactory = (role: DispatchAttempt['role']) => AbortSignal

export async function dispatchSelectedWithFallback<Result>(
  selected: (signal: AbortSignal) => Promise<AgentDispatchResult<Result>>,
  fallback: ((signal: AbortSignal) => Promise<AgentDispatchResult<Result>>) | null,
  signalFactory: DispatchAttemptSignalFactory = dispatchAttemptSignal,
): Promise<DispatchSequenceResult<Result>> {
  const selectedResult = await selected(signalFactory('selected'))
  const attempts = [selectedResult.attempt]
  if (selectedResult.ok) {
    return Object.freeze({ ok: true, result: selectedResult.result, attempts: Object.freeze(attempts) })
  }
  if (selectedResult.attempt.outcome !== 'timeout') {
    return Object.freeze({
      ok: false,
      code: selectedResult.code,
      agentId: selectedResult.attempt.agentId,
      attempts: Object.freeze(attempts),
    })
  }
  if (!fallback) {
    return Object.freeze({
      ok: false,
      code: 'dispatch_exhausted',
      agentId: selectedResult.attempt.agentId,
      attempts: Object.freeze(attempts),
    })
  }

  const fallbackResult = await fallback(signalFactory('fallback'))
  attempts.push(fallbackResult.attempt)
  if (fallbackResult.ok) {
    return Object.freeze({ ok: true, result: fallbackResult.result, attempts: Object.freeze(attempts) })
  }
  return Object.freeze({
    ok: false,
    code: 'dispatch_exhausted',
    agentId: fallbackResult.attempt.agentId,
    attempts: Object.freeze(attempts),
  })
}

function dispatchAttemptSignal(): AbortSignal {
  return AbortSignal.timeout(DISCOVERY_DISPATCH_DEADLINE_MS)
}

export class IntentRoute extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS intent_dispatch (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        request_digest TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        fallback_agent_id TEXT,
        discovery_tool TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'completed', 'unknown')),
        response_json TEXT,
        attempts_json TEXT,
        failure_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )`)
      const columns = this.#sql.exec<{ name: string }>('PRAGMA table_info(intent_dispatch)').toArray()
      if (!columns.some(({ name }) => name === 'fallback_agent_id')) {
        this.#sql.exec('ALTER TABLE intent_dispatch ADD COLUMN fallback_agent_id TEXT')
      }
      if (!columns.some(({ name }) => name === 'attempts_json')) {
        this.#sql.exec('ALTER TABLE intent_dispatch ADD COLUMN attempts_json TEXT')
      }
    })
  }

  async dispatch(input: IntentDispatchInput): Promise<unknown> {
    const requestDigest = await sha256Hex(canonicalJson(input))
    const intentDigest = await sha256Hex(canonicalJson(input.intent))
    const prior = this.#read()
    if (prior) return priorDispatchResult(prior, requestDigest)

    const startedAt = new Date().toISOString()
    this.#sql.exec(
      `INSERT INTO intent_dispatch (
        singleton, request_digest, intent_id, agent_id, fallback_agent_id, discovery_tool,
        state, attempts_json, started_at
      ) VALUES (1, ?, ?, ?, ?, ?, 'dispatching', '[]', ?)`,
      requestDigest,
      input.intent.intentId,
      input.agent.agentId,
      input.fallbackAgent?.agentId ?? null,
      input.agent.discoveryTool,
      startedAt,
    )

    const fallbackAgent = input.fallbackAgent
    const dispatched = await dispatchSelectedWithFallback(
      (signal) => this.#dispatchAgent(input.intent, intentDigest, input.agent, 'selected', signal),
      fallbackAgent
        ? (signal) => this.#dispatchAgent(input.intent, intentDigest, fallbackAgent, 'fallback', signal)
        : null,
    )
    if (dispatched.ok) {
      return this.#complete(input.intent.intentId, dispatched.result, dispatched.attempts, false)
    }
    return this.#fail(input.intent.intentId, dispatched.agentId, dispatched.code, dispatched.attempts)
  }

  async status(): Promise<unknown> {
    const dispatch = this.#read()
    if (!dispatch) return rejected('intent_dispatch_not_found')
    return Object.freeze({
      ok: dispatch.state === 'completed',
      status: dispatch.state,
      intentId: dispatch.intent_id,
      agentId: dispatch.agent_id,
      fallbackAgentId: dispatch.fallback_agent_id,
      failureCode: dispatch.failure_code,
      attempts: readAttempts(dispatch.attempts_json),
      receipt: dispatch.response_json ? JSON.parse(dispatch.response_json) as unknown : null,
    })
  }

  async #dispatchAgent(
    intent: RoutingIntent,
    intentDigest: string,
    agent: AgentRegistryRecord,
    role: DispatchAttempt['role'],
    signal: AbortSignal,
  ): Promise<AgentDispatchResult<unknown>> {
    const startedAt = new Date().toISOString()
    try {
      const operationalEvidence = await discoveryOperationalEvidence(this.env)
      if (!operationalEvidence.ok) throw new Error(`discovery_${operationalEvidence.code}`)
      const providerResult = await callMcpTool(this.env.DOCS_MCP, this.env.DISCOVERY_PROVIDER_BEARER_TOKEN, {
        name: agent.discoveryTool,
        arguments: {
          ...intent.constraints,
          commerceContext: {
            contract: 'commerce.discovery-dispatch/v1',
            intentId: intent.intentId,
            intentDigest,
            agentId: agent.agentId,
            category: intent.category,
            idempotencyKey: `intent:${intent.intentId}:${role}`,
          },
        },
      }, { signal, operationalEvidencePermit: operationalEvidence.permit })
      const result = await normalizeDiscoveryReceipt(providerResult, intent.intentId, intentDigest, agent.agentId)
      const evidencePin = readUpstreamEvidencePin(this.env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON)
      if (!evidencePin || result.offers.some(({ providerRevision }) => providerRevision !== evidencePin.sourceRevision)) {
        throw new Error('discovery_provider_revision_mismatch')
      }
      if (signal.aborted) throw signal.reason ?? new Error('discovery_timeout')
      return Object.freeze({
        ok: true,
        result,
        attempt: attempt(agent.agentId, role, 'completed', startedAt, new Date().toISOString()),
      })
    } catch (error) {
      const code = classifyProviderFailure(error)
      return Object.freeze({
        ok: false,
        code,
        attempt: attempt(
          agent.agentId,
          role,
          code === 'discovery_timeout' ? 'timeout' : 'failed',
          startedAt,
          new Date().toISOString(),
        ),
      })
    }
  }

  #complete(intentId: string, result: unknown, attempts: readonly DispatchAttempt[], idempotent: boolean): unknown {
    this.#sql.exec(
      `UPDATE intent_dispatch SET state = 'completed', agent_id = ?, response_json = ?,
       attempts_json = ?, completed_at = ? WHERE singleton = 1 AND state = 'dispatching'`,
      attempts.at(-1)?.agentId ?? '',
      canonicalJson(result),
      canonicalJson(attempts),
      new Date().toISOString(),
    )
    return Object.freeze({
      ok: true,
      status: 'completed',
      idempotent,
      intentId,
      agentId: attempts.at(-1)?.agentId ?? null,
      attempts: Object.freeze([...attempts]),
      result,
    })
  }

  #fail(intentId: string, agentId: string, code: string, attempts: readonly DispatchAttempt[]): unknown {
    this.#sql.exec(
      `UPDATE intent_dispatch SET state = 'unknown', agent_id = ?, attempts_json = ?,
       failure_code = ?, completed_at = ? WHERE singleton = 1 AND state = 'dispatching'`,
      agentId,
      canonicalJson(attempts),
      code,
      new Date().toISOString(),
    )
    return Object.freeze({
      ok: false,
      status: 'unknown',
      code,
      intentId,
      agentId,
      attempts: Object.freeze([...attempts]),
    })
  }

  #read(): StoredDispatch | null {
    return this.#sql.exec<StoredDispatch>('SELECT * FROM intent_dispatch WHERE singleton = 1').toArray()[0] ?? null
  }
}

type StoredDispatch = Readonly<{
  request_digest: string
  intent_id: string
  agent_id: string
  fallback_agent_id: string | null
  discovery_tool: string
  state: 'dispatching' | 'completed' | 'unknown'
  response_json: string | null
  attempts_json: string | null
  failure_code: string | null
}>

function priorDispatchResult(prior: StoredDispatch, requestDigest: string): unknown {
  if (prior.request_digest !== requestDigest) return rejected('intent_dispatch_precondition_failed')
  if (prior.state === 'completed' && prior.response_json) {
    return Object.freeze({
      ok: true,
      status: 'completed',
      idempotent: true,
      intentId: prior.intent_id,
      agentId: prior.agent_id,
      attempts: readAttempts(prior.attempts_json),
      result: JSON.parse(prior.response_json) as unknown,
    })
  }
  return Object.freeze({
    ok: false,
    status: prior.state,
    code: prior.failure_code ?? 'dispatch_result_unknown',
    intentId: prior.intent_id,
    agentId: prior.agent_id,
    attempts: readAttempts(prior.attempts_json),
  })
}

function readAttempts(value: string | null): readonly DispatchAttempt[] {
  if (!value) return Object.freeze([])
  const parsed: unknown = JSON.parse(value)
  return Object.freeze(Array.isArray(parsed) ? parsed as DispatchAttempt[] : [])
}

function attempt(
  agentId: string,
  role: DispatchAttempt['role'],
  outcome: DispatchAttempt['outcome'],
  startedAt: string,
  completedAt: string,
): DispatchAttempt {
  return Object.freeze({ agentId, role, outcome, startedAt, completedAt })
}

function classifyProviderFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}`.toLowerCase() : ''
  if (message.includes('timeout') || message.includes('abort')) return 'discovery_timeout'
  if (message.includes('provider_evidence')) return 'discovery_provider_evidence_blocked'
  if (message.includes('tool')) return 'discovery_tool_failed'
  if (message.includes('mcp')) return 'discovery_mcp_failed'
  return 'discovery_result_unknown'
}

function rejected(code: string): Readonly<{ ok: false; status: 'rejected'; code: string }> {
  return Object.freeze({ ok: false, status: 'rejected', code })
}
