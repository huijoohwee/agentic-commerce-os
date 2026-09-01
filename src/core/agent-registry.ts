import { DurableObject } from 'cloudflare:workers'

import {
  isAcosAdmissionReceiptBoundToInputs,
  type AcosAdmissionInputs,
  type AcosAdmissionReceipt,
} from './acos-admission'
import {
  readPinnedRouteAuthority,
  routeIntentExclusively,
  type PinnedRouteAuthority,
  type RegisteredAgent,
  type RoutingIntent,
} from '../domain/exclusive-category-router'
import {
  readSelectionPolicy,
  type DeclaredAttributes,
  type SelectionPolicy,
} from '../domain/selection-policy.js'
import { canonicalJson, sha256Hex } from '../shared/digest'
import { isRecord } from '../shared/http'
import type { RegistrationDryRunRecord } from './sandbox-registration.js'
import {
  AGENT_REGISTRY_CLAIM,
  authoringMutationRequestDigest,
  type ClaimMutationPermit,
} from '../domain/authoring-claim-policy.js'
import { runAuthoringFencedMutation } from './authoring-mutation-fence.js'
import {
  invocationAligned,
  readCommerceProjection,
  readStoredAgent,
  registrationContentHash,
  sameRegistration,
  validAgentId,
  validInvocationProof,
  validRegistrationEnvelope,
  validRegistrationIntent,
  verifyStoredAgent,
  type StoredAgent,
} from './agent-registry-record.js'

export { invocationAligned } from './agent-registry-record.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REQUIRED_CATEGORIES = Object.freeze(['flight', 'shopping'])

export type CommerceAgentProjection = Readonly<{
  category: string
  discoveryTool: string
  declaredAttributes: DeclaredAttributes
  fallbackAgentId: string | null
}>

export type InvocationPinProof = Readonly<{
  sourceRevision: string
  catalogDigest: string
  routingSchema: string
  routingDigest: string
  counts: Readonly<{ command: number; semantic: number; binding: number }>
  requiredTokens: readonly string[]
}>

export type AgentRegistrationInput = Readonly<{
  admissionInputs: AcosAdmissionInputs
  admissionReceipt: AcosAdmissionReceipt
  invocationProof: InvocationPinProof
  commerceProjection: unknown
  expectedPreviousContentHash: string | null
  sandboxDryRun: RegistrationDryRunRecord
}>

export type AgentRegistrationIntent = Omit<AgentRegistrationInput, 'admissionReceipt'>

export function agentRegistrationMutationIntent(
  input: AgentRegistrationInput | AgentRegistrationIntent,
): unknown {
  const { startedAt: _startedAt, endedAt: _endedAt, ...stableDryRun } = input.sandboxDryRun
  return Object.freeze({
    admissionInputs: input.admissionInputs,
    invocationProof: input.invocationProof,
    commerceProjection: input.commerceProjection,
    expectedPreviousContentHash: input.expectedPreviousContentHash,
    sandboxDryRun: Object.freeze(stableDryRun),
  })
}

export function agentDeregistrationMutationIntent(agentId: string, expectedContentHash: string): unknown {
  return Object.freeze({ kind: 'deregister', agentId, expectedContentHash })
}

export type AgentRegistryRecord = RegisteredAgent & Readonly<{
  commerceProjection: CommerceAgentProjection
  admissionInputs: AcosAdmissionInputs
  admissionReceipt: AcosAdmissionReceipt
  invocationProof: InvocationPinProof
  admissionInputHash: string
  contentHash: string
  discoveryTool: string
  sandboxDryRun: RegistrationDryRunRecord | null
  updatedAt: string
}>

export class AgentRegistry extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#migrate()
    })
  }

  async preflightRegistration(input: AgentRegistrationIntent): Promise<unknown> {
    if (!validRegistrationIntent(input)) return rejected('registration_malformed')
    const projection = readCommerceProjection(input.commerceProjection, input.admissionInputs)
    const definition = isRecord(input.admissionInputs.agentDefinition) ? input.admissionInputs.agentDefinition : null
    if (!projection || typeof definition?.id !== 'string' || !validAgentId(definition.id)) {
      return rejected('commerce_projection_invalid')
    }
    const existing = await this.#readStored(definition.id)
    const admissionInputHash = await sha256Hex(canonicalJson(input.admissionInputs))
    if (!existing && input.expectedPreviousContentHash !== null) return rejected('registration_precondition_failed')
    if (existing && existing.contentHash !== input.expectedPreviousContentHash
      && !sameRegistration(existing, admissionInputHash, input.invocationProof, projection)) {
      return rejected('registration_precondition_failed')
    }
    return Object.freeze({ ok: true })
  }

  async register(input: AgentRegistrationInput, permit: ClaimMutationPermit): Promise<unknown> {
    if (!validRegistrationEnvelope(input)) return rejected('registration_malformed')
    if (!isAcosAdmissionReceiptBoundToInputs(input.admissionReceipt, input.admissionInputs)) {
      return rejected('acos_admission_receipt_invalid')
    }
    const commerceProjection = readCommerceProjection(input.commerceProjection, input.admissionInputs)
    if (!commerceProjection) return rejected('commerce_projection_invalid')

    const agentId = input.admissionReceipt.agent_definition_id
    const admissionInputHash = await sha256Hex(canonicalJson(input.admissionInputs))
    const contentHash = await registrationContentHash(
      input.admissionInputs,
      input.admissionReceipt,
      input.invocationProof,
      commerceProjection,
    )
    const requestDigest = await authoringMutationRequestDigest(
      AGENT_REGISTRY_CLAIM,
      agentRegistrationMutationIntent(input),
    )
    const existing = await this.#readStored(agentId)
    const updatedAt = new Date().toISOString()
    const record = Object.freeze({
      agentId,
      category: commerceProjection.category,
      declaredAttributes: commerceProjection.declaredAttributes,
      fallbackAgentId: commerceProjection.fallbackAgentId,
      commerceProjection,
      admissionInputs: input.admissionInputs,
      admissionReceipt: input.admissionReceipt,
      invocationProof: input.invocationProof,
      admissionInputHash,
      contentHash,
      discoveryTool: commerceProjection.discoveryTool,
      sandboxDryRun: input.sandboxDryRun,
      registrationState: 'active' as const,
      updatedAt,
      admissionVerified: true,
    }) satisfies AgentRegistryRecord
    const fenced = runAuthoringFencedMutation(
      this.ctx.storage,
      this.#sql,
      permit,
      AGENT_REGISTRY_CLAIM,
      requestDigest,
      () => {
        if (!existing && input.expectedPreviousContentHash !== null) return rejected('registration_precondition_failed')
        if (existing && existing.contentHash !== input.expectedPreviousContentHash) {
          return sameRegistration(existing, admissionInputHash, input.invocationProof, commerceProjection)
            ? this.#registrationResult(existing, true)
            : rejected('registration_precondition_failed')
        }
        if (existing && sameRegistration(existing, admissionInputHash, input.invocationProof, commerceProjection)) {
          return this.#registrationResult(existing, true)
        }
        this.#sql.exec(
          `INSERT INTO agent_admission (
            agent_id, category, discovery_tool, declared_attributes_json, fallback_agent_id, admission_input_json,
            admission_input_hash, admission_receipt_json, invocation_proof_json, content_hash,
            sandbox_dry_run_json, registration_state, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            category = excluded.category,
            discovery_tool = excluded.discovery_tool,
            declared_attributes_json = excluded.declared_attributes_json,
            fallback_agent_id = excluded.fallback_agent_id,
            admission_input_json = excluded.admission_input_json,
            admission_input_hash = excluded.admission_input_hash,
            admission_receipt_json = excluded.admission_receipt_json,
            invocation_proof_json = excluded.invocation_proof_json,
            content_hash = excluded.content_hash,
            sandbox_dry_run_json = excluded.sandbox_dry_run_json,
            registration_state = 'active',
            updated_at = excluded.updated_at`,
          agentId,
          commerceProjection.category,
          commerceProjection.discoveryTool,
          canonicalJson(commerceProjection.declaredAttributes),
          commerceProjection.fallbackAgentId,
          canonicalJson(input.admissionInputs),
          admissionInputHash,
          canonicalJson(input.admissionReceipt),
          canonicalJson(input.invocationProof),
          contentHash,
          canonicalJson(input.sandboxDryRun),
          updatedAt,
        )
        this.#appendEvent('registered', agentId, contentHash)
        return this.#registrationResult(record, false)
      },
    )
    return fenced.ok ? fenced.value : fenced
  }

  async deregister(agentId: string, expectedContentHash: string, permit: ClaimMutationPermit): Promise<unknown> {
    if (!validAgentId(agentId) || !SHA256_PATTERN.test(expectedContentHash)) {
      return rejected('deregistration_malformed')
    }
    const existing = await this.#readStored(agentId)
    const updatedAt = new Date().toISOString()
    const requestDigest = await authoringMutationRequestDigest(
      AGENT_REGISTRY_CLAIM,
      agentDeregistrationMutationIntent(agentId, expectedContentHash),
    )
    const fenced = runAuthoringFencedMutation(
      this.ctx.storage,
      this.#sql,
      permit,
      AGENT_REGISTRY_CLAIM,
      requestDigest,
      () => {
      if (!existing) return rejected('agent_not_found')
      if (existing.contentHash !== expectedContentHash) return rejected('registration_precondition_failed')
      if (existing.registrationState === 'inactive') return this.#registrationResult(existing, true)
      this.#sql.exec(
        "UPDATE agent_admission SET registration_state = 'inactive', updated_at = ? WHERE agent_id = ?",
        updatedAt,
        agentId,
      )
      this.#appendEvent('deregistered', agentId, expectedContentHash)
      return this.#registrationResult(Object.freeze({ ...existing, registrationState: 'inactive', updatedAt }), false)
    },
    )
    return fenced.ok ? fenced.value : fenced
  }

  async list(): Promise<Readonly<{
    ok: true
    revision: number
    digest: string
    agents: readonly AgentRegistryRecord[]
  }>> {
    const agents = Object.freeze(await this.#allStored())
    const revision = this.#eventRevision()
    const digest = await sha256Hex(canonicalJson({ revision, agents }))
    return Object.freeze({ ok: true, revision, digest, agents })
  }

  async route(
    intent: RoutingIntent,
    expectedInvocationProof: InvocationPinProof,
    selectionPolicy: SelectionPolicy,
    routingAuthority: PinnedRouteAuthority | null = null,
  ): Promise<unknown> {
    const authority = routingAuthority === null ? null : readPinnedRouteAuthority(routingAuthority)
    if (!validInvocationProof(expectedInvocationProof) || !readSelectionPolicy(selectionPolicy)
      || (routingAuthority !== null && !authority)) {
      return rejected('routing_configuration_invalid')
    }
    const agents = (await this.#allStored()).map((agent) => Object.freeze({
      ...agent,
      admissionVerified: agent.admissionVerified && invocationAligned(agent, expectedInvocationProof),
    }))
    const decision = routeIntentExclusively(intent, agents, selectionPolicy, authority)
    const prior = this.#sql.exec<{
      intent_id: string
      intent_digest: string
      decision_json: string
    }>('SELECT intent_id, intent_digest, decision_json FROM route_event WHERE intent_id = ?', intent.intentId)
      .toArray()[0]
    const intentDigest = await sha256Hex(canonicalJson({ intent, routingAuthority: authority }))
    if (prior) {
      if (prior.intent_digest !== intentDigest) return rejected('intent_precondition_failed')
      const priorDecision = JSON.parse(prior.decision_json) as unknown
      return canonicalJson(priorDecision) === canonicalJson(decision)
        ? priorDecision
        : rejected('intent_registration_drift')
    }
    this.#sql.exec(
      'INSERT INTO route_event (intent_id, intent_digest, decision_json, created_at) VALUES (?, ?, ?, ?)',
      intent.intentId,
      intentDigest,
      canonicalJson(decision),
      new Date().toISOString(),
    )
    return decision
  }

  async health(expectedInvocationProof: InvocationPinProof): Promise<unknown> {
    if (!validInvocationProof(expectedInvocationProof)) {
      return Object.freeze({ ok: false, contract: 'commerce.agent-registry/v1', reason: 'invocation_pin_invalid' })
    }
    const agents = await this.#allStored()
    const staleAgents = agents.filter((agent) => (
      agent.registrationState === 'active' && !invocationAligned(agent, expectedInvocationProof)
    )).map((agent) => agent.agentId)
    const categories = Object.fromEntries(REQUIRED_CATEGORIES.map((category) => [
      category,
      agents.filter((agent) => (
        agent.registrationState === 'active'
        && agent.admissionVerified
        && agent.category === category
      )).length,
    ]))
    const ready = Object.values(categories).every((count) => count >= 1) && staleAgents.length === 0
    return Object.freeze({
      ok: ready,
      contract: 'commerce.agent-registry/v1',
      revision: this.#eventRevision(),
      requiredCategories: categories,
      staleAgents: Object.freeze(staleAgents),
      reason: ready ? null : staleAgents.length > 0
        ? 'active_admission_invocation_pin_mismatch'
        : 'at_least_one_verified_active_admission_per_required_category_required',
    })
  }

  async events(afterEventId = 0, limit = 100): Promise<unknown> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const events = this.#sql.exec<{
      event_id: number
      event_type: string
      agent_id: string
      content_hash: string
      created_at: string
    }>(
      `SELECT event_id, event_type, agent_id, content_hash, created_at
       FROM registry_event WHERE event_id > ? ORDER BY event_id LIMIT ?`,
      Math.max(0, Math.floor(afterEventId)),
      boundedLimit,
    ).toArray().map((row) => Object.freeze({
      eventId: row.event_id,
      eventType: row.event_type,
      agentId: row.agent_id,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    }))
    return Object.freeze({ ok: true, events: Object.freeze(events) })
  }

  #migrate(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_fence (
      semantic_scope TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL,
      fence_revision TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      mutation_sequence INTEGER NOT NULL,
      request_digest TEXT NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL
    )`)
    const fenceColumns = this.#sql.exec<{ name: string }>('PRAGMA table_info(authoring_mutation_fence)').toArray()
    if (!fenceColumns.some(({ name }) => name === 'mutation_sequence')) {
      this.#sql.exec('ALTER TABLE authoring_mutation_fence ADD COLUMN mutation_sequence INTEGER NOT NULL DEFAULT 0')
    }
    if (!fenceColumns.some(({ name }) => name === 'request_digest')) {
      this.#sql.exec("ALTER TABLE authoring_mutation_fence ADD COLUMN request_digest TEXT NOT NULL DEFAULT ''")
    }
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_outcome (
      mutation_id TEXT PRIMARY KEY,
      semantic_scope TEXT NOT NULL,
      mutation_sequence INTEGER NOT NULL,
      permit_json TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      outcome_json TEXT NOT NULL
    )`)
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS agent_admission (
      agent_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      discovery_tool TEXT NOT NULL,
      declared_attributes_json TEXT,
      fallback_agent_id TEXT,
      admission_input_json TEXT NOT NULL,
      admission_input_hash TEXT NOT NULL,
      admission_receipt_json TEXT NOT NULL,
      invocation_proof_json TEXT,
      content_hash TEXT NOT NULL,
      sandbox_dry_run_json TEXT NOT NULL,
      registration_state TEXT NOT NULL CHECK (registration_state IN ('active', 'inactive')),
      updated_at TEXT NOT NULL
    )`)
    const columns = this.#sql.exec<{ name: string }>('PRAGMA table_info(agent_admission)').toArray()
    if (!columns.some(({ name }) => name === 'invocation_proof_json')) {
      this.#sql.exec('ALTER TABLE agent_admission ADD COLUMN invocation_proof_json TEXT')
    }
    if (!columns.some(({ name }) => name === 'declared_attributes_json')) {
      this.#sql.exec('ALTER TABLE agent_admission ADD COLUMN declared_attributes_json TEXT')
    }
    if (!columns.some(({ name }) => name === 'fallback_agent_id')) {
      this.#sql.exec('ALTER TABLE agent_admission ADD COLUMN fallback_agent_id TEXT')
    }
    if (!columns.some(({ name }) => name === 'sandbox_dry_run_json')) {
      this.#sql.exec('ALTER TABLE agent_admission ADD COLUMN sandbox_dry_run_json TEXT')
    }
    this.#sql.exec('DROP INDEX IF EXISTS one_active_admission_per_category')
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS registry_event (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS route_event (
      intent_id TEXT PRIMARY KEY,
      intent_digest TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
  }

  async #allStored(): Promise<AgentRegistryRecord[]> {
    return Promise.all(this.#sql.exec<StoredAgent>(
      'SELECT * FROM agent_admission ORDER BY agent_id',
    ).toArray().map(readStoredAgent).map(verifyStoredAgent))
  }

  async #readStored(agentId: string): Promise<AgentRegistryRecord | null> {
    const row = this.#sql.exec<StoredAgent>(
      'SELECT * FROM agent_admission WHERE agent_id = ?', agentId,
    ).toArray()[0]
    return row ? verifyStoredAgent(readStoredAgent(row)) : null
  }

  #appendEvent(eventType: string, agentId: string, contentHash: string): void {
    this.#sql.exec(
      'INSERT INTO registry_event (event_type, agent_id, content_hash, created_at) VALUES (?, ?, ?, ?)',
      eventType,
      agentId,
      contentHash,
      new Date().toISOString(),
    )
  }

  #eventRevision(): number {
    return this.#sql.exec<{ revision: number }>(
      'SELECT COUNT(*) AS revision FROM registry_event',
    ).one()?.revision ?? 0
  }

  #registrationResult(record: AgentRegistryRecord, idempotent: boolean): unknown {
    return Object.freeze({ ok: true, idempotent, record })
  }
}

function rejected(code: string): Readonly<{ ok: false; code: string }> {
  return Object.freeze({ ok: false, code })
}
