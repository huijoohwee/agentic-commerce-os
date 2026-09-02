import {
  COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  isAcosAdmissionReceiptBoundToInputs,
  type AcosAdmissionInputs,
  type AcosAdmissionReceipt,
} from './acos-admission.js'
import { normalizeAgentCategory } from '../domain/exclusive-category-router.js'
import type { DeclaredAttributes } from '../domain/selection-policy.js'
import { CATALOG_LIMIT } from '../invocation/catalog.js'
import { canonicalJson, sha256Hex } from '../shared/digest.js'
import { isRecord } from '../shared/http.js'
import { isRegistrationDryRunRecord } from './sandbox-registration.js'
import type {
  AgentRegistrationInput,
  AgentRegistrationIntent,
  AgentRegistryRecord,
  CommerceAgentProjection,
  InvocationPinProof,
} from './agent-registry.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u
type StoredRegistryRecord = Omit<AgentRegistryRecord, 'admissionVerified'>

export type StoredAgent = {
  agent_id: string
  category: string
  discovery_tool: string
  declared_attributes_json: string | null
  fallback_agent_id: string | null
  admission_input_json: string
  admission_input_hash: string
  admission_receipt_json: string
  invocation_proof_json: string | null
  content_hash: string
  sandbox_dry_run_json: string | null
  registration_state: 'active' | 'inactive'
  updated_at: string
}

export function readStoredAgent(row: StoredAgent): StoredRegistryRecord {
  const parsedAttributes: unknown = row.declared_attributes_json
    ? JSON.parse(row.declared_attributes_json) as unknown
    : null
  const declaredAttributes: DeclaredAttributes = readDeclaredAttributes(parsedAttributes)
    ?? Object.freeze({ priceMinor: -1, qualityScore: -1, latencyMs: -1 })
  const commerceProjection = Object.freeze({
    category: row.category,
    discoveryTool: row.discovery_tool,
    declaredAttributes,
    fallbackAgentId: row.fallback_agent_id,
  })
  const sandboxDryRun: unknown = row.sandbox_dry_run_json
    ? JSON.parse(row.sandbox_dry_run_json) as unknown
    : null
  return Object.freeze({
    agentId: row.agent_id,
    category: row.category,
    declaredAttributes,
    fallbackAgentId: row.fallback_agent_id,
    commerceProjection,
    admissionInputs: JSON.parse(row.admission_input_json) as AcosAdmissionInputs,
    admissionReceipt: JSON.parse(row.admission_receipt_json) as AcosAdmissionReceipt,
    invocationProof: row.invocation_proof_json
      ? JSON.parse(row.invocation_proof_json) as InvocationPinProof
      : invalidInvocationProof(),
    admissionInputHash: row.admission_input_hash,
    contentHash: row.content_hash,
    discoveryTool: row.discovery_tool,
    sandboxDryRun: isRegistrationDryRunRecord(sandboxDryRun) ? sandboxDryRun : null,
    registrationState: row.registration_state,
    updatedAt: row.updated_at,
  })
}

export async function verifyStoredAgent(record: StoredRegistryRecord): Promise<AgentRegistryRecord> {
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
    && isRegistrationDryRunRecord(record.sandboxDryRun)
    && record.admissionInputHash === expectedInputHash
    && record.contentHash === expectedContentHash
  return Object.freeze({ ...record, admissionVerified })
}

export function readCommerceProjection(
  value: unknown,
  admissionInputs: AcosAdmissionInputs,
): CommerceAgentProjection | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => ![
      'category', 'discoveryTool', 'declaredAttributes', 'fallbackAgentId',
    ].includes(key))) return null
  const category = normalizeAgentCategory(value.category)
  if (!category || typeof value.discoveryTool !== 'string' || !TOOL_NAME_PATTERN.test(value.discoveryTool)) return null
  const declaredAttributes = readDeclaredAttributes(value.declaredAttributes)
  const fallbackAgentId = value.fallbackAgentId === null ? null
    : typeof value.fallbackAgentId === 'string' && validAgentId(value.fallbackAgentId)
      ? value.fallbackAgentId
      : undefined
  const definition = isRecord(admissionInputs.agentDefinition) ? admissionInputs.agentDefinition : null
  if (!declaredAttributes
    || fallbackAgentId === undefined
    || (fallbackAgentId !== null && fallbackAgentId === definition?.id)) return null
  const allowlist = isRecord(admissionInputs.toolAllowlistEntry) ? admissionInputs.toolAllowlistEntry : null
  if (!allowlist || !Array.isArray(allowlist.tool_names) || !allowlist.tool_names.includes(value.discoveryTool)) return null
  return Object.freeze({ category, discoveryTool: value.discoveryTool, declaredAttributes, fallbackAgentId })
}

function readDeclaredAttributes(value: unknown): DeclaredAttributes | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['priceMinor', 'qualityScore', 'latencyMs'].includes(key))) return null
  const entries = [value.priceMinor, value.qualityScore, value.latencyMs]
  if (!entries.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)) return null
  return Object.freeze({
    priceMinor: Number(value.priceMinor),
    qualityScore: Number(value.qualityScore),
    latencyMs: Number(value.latencyMs),
  })
}

export function validRegistrationEnvelope(input: AgentRegistrationInput): boolean {
  return validRegistrationIntent(input)
}

export function validRegistrationIntent(input: AgentRegistrationIntent): boolean {
  return Boolean(input)
    && input.admissionInputs?.operatorInstructionRef === COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF
    && isRegistrationDryRunRecord(input.sandboxDryRun)
    && validInvocationProof(input.invocationProof)
    && (input.expectedPreviousContentHash === null || SHA256_PATTERN.test(input.expectedPreviousContentHash))
}

export function validAgentId(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256
}

export async function registrationContentHash(
  admissionInputs: AcosAdmissionInputs,
  admissionReceipt: AcosAdmissionReceipt,
  invocationProof: InvocationPinProof,
  commerceProjection: CommerceAgentProjection,
): Promise<string> {
  return sha256Hex(canonicalJson({ admissionInputs, admissionReceipt, invocationProof, commerceProjection }))
}

export function sameRegistration(
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

export function validInvocationProof(value: InvocationPinProof): boolean {
  return Boolean(value)
    && /^[0-9a-f]{40}$/u.test(value.sourceRevision)
    && SHA256_PATTERN.test(value.catalogDigest)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.routingSchema)
    && SHA256_PATTERN.test(value.routingDigest)
    && [value.counts?.command, value.counts?.semantic, value.counts?.binding]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    && Array.isArray(value.requiredTokens)
    && value.requiredTokens.length >= 3
    && value.requiredTokens.length <= CATALOG_LIMIT
    && value.requiredTokens.every((token) => (
      /^[/#@][A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}|[A-Za-z0-9._-]{0,125}:)$/u.test(token)
    ))
    && new Set(value.requiredTokens).size === value.requiredTokens.length
}

export function invocationAligned(record: AgentRegistryRecord, expected: InvocationPinProof): boolean {
  return record.admissionVerified
    && canonicalJson(record.invocationProof) === canonicalJson(expected)
    && expected.requiredTokens.slice(0, 3).every((token, index) => (
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
