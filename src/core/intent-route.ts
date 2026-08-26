import { DurableObject } from 'cloudflare:workers'

import type { AgentRegistryRecord } from './agent-registry'
import { normalizeDiscoveryReceipt } from './discovery-receipt'
import { readUpstreamEvidencePin } from './upstream-evidence'
import { callMcpTool } from './mcp-provider'
import { canonicalJson, sha256Hex } from '../shared/digest'
import type { RoutingIntent } from '../domain/exclusive-category-router'

export type IntentDispatchInput = Readonly<{
  intent: RoutingIntent
  agent: AgentRegistryRecord
}>

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
        discovery_tool TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'completed', 'unknown')),
        response_json TEXT,
        failure_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )`)
    })
  }

  async dispatch(input: IntentDispatchInput): Promise<unknown> {
    const requestDigest = await sha256Hex(canonicalJson(input))
    const intentDigest = await sha256Hex(canonicalJson(input.intent))
    const prior = this.#read()
    if (prior) {
      if (prior.request_digest !== requestDigest) return rejected('intent_dispatch_precondition_failed')
      if (prior.state === 'completed' && prior.response_json) {
        return Object.freeze({
          ok: true,
          status: 'completed',
          idempotent: true,
          intentId: prior.intent_id,
          agentId: prior.agent_id,
          result: JSON.parse(prior.response_json) as unknown,
        })
      }
      return Object.freeze({
        ok: false,
        status: prior.state,
        code: prior.failure_code ?? 'dispatch_result_unknown',
        intentId: prior.intent_id,
        agentId: prior.agent_id,
      })
    }

    const startedAt = new Date().toISOString()
    this.#sql.exec(
      `INSERT INTO intent_dispatch (
        singleton, request_digest, intent_id, agent_id, discovery_tool, state, started_at
      ) VALUES (1, ?, ?, ?, ?, 'dispatching', ?)`,
      requestDigest,
      input.intent.intentId,
      input.agent.agentId,
      input.agent.discoveryTool,
      startedAt,
    )

    try {
      const providerResult = await callMcpTool(this.env.DOCS_MCP, {
        name: input.agent.discoveryTool,
        arguments: {
          ...input.intent.constraints,
          commerceContext: {
            contract: 'commerce.discovery-dispatch/v1',
            intentId: input.intent.intentId,
            intentDigest,
            agentId: input.agent.agentId,
            category: input.intent.category,
            idempotencyKey: `intent:${input.intent.intentId}`,
          },
        },
      })
      const result = await normalizeDiscoveryReceipt(
        providerResult,
        input.intent.intentId,
        intentDigest,
        input.agent.agentId,
      )
      const evidencePin = readUpstreamEvidencePin(this.env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON)
      if (!evidencePin || result.offers.some(({ providerRevision }) => (
        providerRevision !== evidencePin.sourceRevision
      ))) throw new Error('discovery_provider_revision_mismatch')
      this.#sql.exec(
        `UPDATE intent_dispatch SET state = 'completed', response_json = ?, completed_at = ?
         WHERE singleton = 1 AND state = 'dispatching'`,
        canonicalJson(result),
        new Date().toISOString(),
      )
      return Object.freeze({
        ok: true,
        status: 'completed',
        idempotent: false,
        intentId: input.intent.intentId,
        agentId: input.agent.agentId,
        result,
      })
    } catch (error) {
      this.#sql.exec(
        `UPDATE intent_dispatch SET state = 'unknown', failure_code = ?, completed_at = ?
         WHERE singleton = 1 AND state = 'dispatching'`,
        classifyProviderFailure(error),
        new Date().toISOString(),
      )
      return Object.freeze({
        ok: false,
        status: 'unknown',
        code: classifyProviderFailure(error),
        intentId: input.intent.intentId,
        agentId: input.agent.agentId,
      })
    }
  }

  async status(): Promise<unknown> {
    const dispatch = this.#read()
    if (!dispatch) return rejected('intent_dispatch_not_found')
    return Object.freeze({
      ok: dispatch.state === 'completed',
      status: dispatch.state,
      intentId: dispatch.intent_id,
      agentId: dispatch.agent_id,
      failureCode: dispatch.failure_code,
      receipt: dispatch.response_json ? JSON.parse(dispatch.response_json) as unknown : null,
    })
  }

  #read(): StoredDispatch | null {
    return this.#sql.exec<StoredDispatch>('SELECT * FROM intent_dispatch WHERE singleton = 1').toArray()[0] ?? null
  }
}

type StoredDispatch = {
  request_digest: string
  intent_id: string
  agent_id: string
  discovery_tool: string
  state: 'dispatching' | 'completed' | 'unknown'
  response_json: string | null
  failure_code: string | null
}

function classifyProviderFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('tool')) return 'discovery_tool_failed'
  if (message.includes('mcp')) return 'discovery_mcp_failed'
  return 'discovery_result_unknown'
}

function rejected(code: string): Readonly<{ ok: false; status: 'rejected'; code: string }> {
  return Object.freeze({ ok: false, status: 'rejected', code })
}
