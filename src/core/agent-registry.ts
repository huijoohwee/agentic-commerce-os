import { DurableObject } from 'cloudflare:workers'

import {
  isAcosAdmissionReceiptBoundToInputs,
  type AcosAdmissionInputs,
  type AcosAdmissionReceipt,
} from './acos-admission'
import {
  normalizeAgentCategory,
  routeIntentExclusively,
  type RegisteredAgent,
  type RoutingIntent,
} from '../domain/exclusive-category-router'
import { canonicalJson, sha256Hex } from '../shared/digest'
import { isRecord } from '../shared/http'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u
const REQUIRED_CATEGORIES = Object.freeze(['flight', 'shopping'])

export type CommerceAgentProjection = Readonly<{
  category: string
  discoveryTool: string
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
}>

export type AgentRegistryRecord = RegisteredAgent & Readonly<{
  commerceProjection: CommerceAgentProjection
  admissionInputs: AcosAdmissionInputs
  admissionReceipt: AcosAdmissionReceipt
  invocationProof: InvocationPinProof
  admissionInputHash: string
  contentHash: string
  discoveryTool: string
  updatedAt: string
}>

type StoredRegistryRecord = Omit<AgentRegistryRecord, 'admissionVerified'>

export class AgentRegistry extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#migrate()
    })
  }

  async register(input: AgentRegistrationInput): Promise<unknown> {
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
    const existing = await this.#readStored(agentId)
    if (!existing && input.expectedPreviousContentHash !== null) return rejected('registration_precondition_failed')
    if (existing && existing.contentHash !== input.expectedPreviousContentHash) {
      if (sameRegistration(existing, admissionInputHash, input.invocationProof, commerceProjection)) {
        return this.#registrationResult(existing, true)
      }
      return rejected('registration_precondition_failed')
    }
    if (existing && sameRegistration(existing, admissionInputHash, input.invocationProof, commerceProjection)) {
      return this.#registrationResult(existing, true)
    }
    const categoryOwner = (await this.#allStored()).find((record) => (
      record.registrationState === 'active'
      && record.category === commerceProjection.category
      && record.agentId !== agentId
    ))
    if (categoryOwner) return rejected('category_already_registered')

    const updatedAt = new Date().toISOString()
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `INSERT INTO agent_admission (
          agent_id, category, discovery_tool, admission_input_json,
          admission_input_hash, admission_receipt_json, invocation_proof_json, content_hash,
          registration_state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          category = excluded.category,
          discovery_tool = excluded.discovery_tool,
          admission_input_json = excluded.admission_input_json,
          admission_input_hash = excluded.admission_input_hash,
          admission_receipt_json = excluded.admission_receipt_json,
          invocation_proof_json = excluded.invocation_proof_json,
          content_hash = excluded.content_hash,
          registration_state = 'active',
          updated_at = excluded.updated_at`,
        agentId,
        commerceProjection.category,
        commerceProjection.discoveryTool,
        canonicalJson(input.admissionInputs),
        admissionInputHash,
        canonicalJson(input.admissionReceipt),
        canonicalJson(input.invocationProof),
        contentHash,
        updatedAt,
      )
      this.#appendEvent('registered', agentId, contentHash)
    })
    const record = await this.#readStored(agentId)
    return record ? this.#registrationResult(record, false) : rejected('registration_persistence_failed')
  }

  async deregister(agentId: string, expectedContentHash: string): Promise<unknown> {
    if (!validAgentId(agentId) || !SHA256_PATTERN.test(expectedContentHash)) {
      return rejected('deregistration_malformed')
    }
    const existing = await this.#readStored(agentId)
    if (!existing) return rejected('agent_not_found')
    if (existing.contentHash !== expectedContentHash) return rejected('registration_precondition_failed')
    if (existing.registrationState === 'inactive') return this.#registrationResult(existing, true)
    const updatedAt = new Date().toISOString()
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        "UPDATE agent_admission SET registration_state = 'inactive', updated_at = ? WHERE agent_id = ?",
        updatedAt,
        agentId,
      )
      this.#appendEvent('deregistered', agentId, expectedContentHash)
    })
    const record = await this.#readStored(agentId)
    return record ? this.#registrationResult(record, false) : rejected('registration_persistence_failed')
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

  async route(intent: RoutingIntent, expectedInvocationProof: InvocationPinProof): Promise<unknown> {
    if (!validInvocationProof(expectedInvocationProof)) return rejected('invocation_pin_invalid')
    const agents = (await this.#allStored()).map((agent) => Object.freeze({
      ...agent,
      admissionVerified: agent.admissionVerified && invocationAligned(agent, expectedInvocationProof),
    }))
    const decision = routeIntentExclusively(intent, agents)
    const prior = this.#sql.exec<{
      intent_id: string
      intent_digest: string
      decision_json: string
    }>('SELECT intent_id, intent_digest, decision_json FROM route_event WHERE intent_id = ?', intent.intentId)
      .toArray()[0]
    const intentDigest = await sha256Hex(canonicalJson(intent))
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
    const ready = Object.values(categories).every((count) => count === 1) && staleAgents.length === 0
    return Object.freeze({
      ok: ready,
      contract: 'commerce.agent-registry/v1',
      revision: this.#eventRevision(),
      requiredCategories: categories,
      staleAgents: Object.freeze(staleAgents),
      reason: ready ? null : staleAgents.length > 0
        ? 'active_admission_invocation_pin_mismatch'
        : 'exactly_one_verified_active_admission_per_required_category_required',
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
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS agent_admission (
      agent_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      discovery_tool TEXT NOT NULL,
      admission_input_json TEXT NOT NULL,
      admission_input_hash TEXT NOT NULL,
      admission_receipt_json TEXT NOT NULL,
      invocation_proof_json TEXT,
      content_hash TEXT NOT NULL,
      registration_state TEXT NOT NULL CHECK (registration_state IN ('active', 'inactive')),
      updated_at TEXT NOT NULL
    )`)
    const columns = this.#sql.exec<{ name: string }>('PRAGMA table_info(agent_admission)').toArray()
    if (!columns.some(({ name }) => name === 'invocation_proof_json')) {
      this.#sql.exec('ALTER TABLE agent_admission ADD COLUMN invocation_proof_json TEXT')
    }
    this.#sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_admission_per_category
      ON agent_admission(category) WHERE registration_state = 'active'`)
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

type StoredAgent = {
  agent_id: string
  category: string
  discovery_tool: string
  admission_input_json: string
  admission_input_hash: string
  admission_receipt_json: string
  invocation_proof_json: string | null
  content_hash: string
  registration_state: 'active' | 'inactive'
  updated_at: string
}

function readStoredAgent(row: StoredAgent): StoredRegistryRecord {
  const commerceProjection = Object.freeze({ category: row.category, discoveryTool: row.discovery_tool })
  return Object.freeze({
    agentId: row.agent_id,
    category: row.category,
    commerceProjection,
    admissionInputs: JSON.parse(row.admission_input_json) as AcosAdmissionInputs,
    admissionReceipt: JSON.parse(row.admission_receipt_json) as AcosAdmissionReceipt,
    invocationProof: row.invocation_proof_json
      ? JSON.parse(row.invocation_proof_json) as InvocationPinProof
      : invalidInvocationProof(),
    admissionInputHash: row.admission_input_hash,
    contentHash: row.content_hash,
    discoveryTool: row.discovery_tool,
    registrationState: row.registration_state,
    updatedAt: row.updated_at,
  })
}

async function verifyStoredAgent(record: StoredRegistryRecord): Promise<AgentRegistryRecord> {
  const expectedInputHash = await sha256Hex(canonicalJson(record.admissionInputs))
  const expectedContentHash = await registrationContentHash(
    record.admissionInputs,
    record.admissionReceipt,
    record.invocationProof,
    record.commerceProjection,
  )
  const admissionVerified = record.agentId === record.admissionReceipt.agent_definition_id
    && record.category === record.commerceProjection.category
    && record.discoveryTool === record.commerceProjection.discoveryTool
    && isAcosAdmissionReceiptBoundToInputs(record.admissionReceipt, record.admissionInputs)
    && validInvocationProof(record.invocationProof)
    && readCommerceProjection(record.commerceProjection, record.admissionInputs) !== null
    && record.admissionInputHash === expectedInputHash
    && record.contentHash === expectedContentHash
  return Object.freeze({ ...record, admissionVerified })
}

function readCommerceProjection(
  value: unknown,
  admissionInputs: AcosAdmissionInputs,
): CommerceAgentProjection | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'category' && key !== 'discoveryTool')) return null
  const category = normalizeAgentCategory(value.category)
  if (!category || typeof value.discoveryTool !== 'string' || !TOOL_NAME_PATTERN.test(value.discoveryTool)) return null
  const allowlist = isRecord(admissionInputs.toolAllowlistEntry) ? admissionInputs.toolAllowlistEntry : null
  if (!allowlist || !Array.isArray(allowlist.tool_names) || !allowlist.tool_names.includes(value.discoveryTool)) return null
  return Object.freeze({ category, discoveryTool: value.discoveryTool })
}

function validRegistrationEnvelope(input: AgentRegistrationInput): boolean {
  return Boolean(input)
    && typeof input.admissionInputs?.operatorInstructionRef === 'string'
    && input.admissionInputs.operatorInstructionRef.trim().length > 0
    && validInvocationProof(input.invocationProof)
    && (input.expectedPreviousContentHash === null || SHA256_PATTERN.test(input.expectedPreviousContentHash))
}

function validAgentId(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256
}

async function registrationContentHash(
  admissionInputs: AcosAdmissionInputs,
  admissionReceipt: AcosAdmissionReceipt,
  invocationProof: InvocationPinProof,
  commerceProjection: CommerceAgentProjection,
): Promise<string> {
  return sha256Hex(canonicalJson({ admissionInputs, admissionReceipt, invocationProof, commerceProjection }))
}

function sameRegistration(
  existing: AgentRegistryRecord,
  admissionInputHash: string,
  invocationProof: InvocationPinProof,
  commerceProjection: CommerceAgentProjection,
): boolean {
  return existing.registrationState === 'active'
    && existing.admissionVerified
    && existing.admissionInputHash === admissionInputHash
    && canonicalJson(existing.invocationProof) === canonicalJson(invocationProof)
    && canonicalJson(existing.commerceProjection) === canonicalJson(commerceProjection)
}

function validInvocationProof(value: InvocationPinProof): boolean {
  return Boolean(value)
    && /^[0-9a-f]{40}$/u.test(value.sourceRevision)
    && SHA256_PATTERN.test(value.catalogDigest)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.routingSchema)
    && SHA256_PATTERN.test(value.routingDigest)
    && [value.counts?.command, value.counts?.semantic, value.counts?.binding]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    && Array.isArray(value.requiredTokens)
    && value.requiredTokens.length === 3
    && value.requiredTokens.every((token) => /^[/#@][A-Za-z0-9][A-Za-z0-9._-]{0,95}:?$/u.test(token))
    && new Set(value.requiredTokens).size === value.requiredTokens.length
}

export function invocationAligned(record: AgentRegistryRecord, expected: InvocationPinProof): boolean {
  return record.admissionVerified
    && canonicalJson(record.invocationProof) === canonicalJson(expected)
    && expected.requiredTokens.every((token, index) => (
      record.admissionReceipt.invocation_register_tokens[index] === token
    ))
}

function invalidInvocationProof(): InvocationPinProof {
  return Object.freeze({
    sourceRevision: '',
    catalogDigest: '',
    routingSchema: '',
    routingDigest: '',
    counts: Object.freeze({ command: -1, semantic: -1, binding: -1 }),
    requiredTokens: Object.freeze([]),
  })
}

function rejected(code: string): Readonly<{ ok: false; code: string }> {
  return Object.freeze({ ok: false, code })
}
