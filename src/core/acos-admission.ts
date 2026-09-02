import { isHttpFailure, isRecord, readJsonResponse } from '../shared/http.ts'
import type { ClaimMutationPermit } from '../domain/authoring-claim-policy.js'
import { authenticateAcosAdmissionRequest } from '../shared/acos-admission-auth.ts'
import {
  authoringMutationHeaders,
  responseMatchesAuthoringMutation,
} from './authoring-mutation-headers.ts'

export const ACOS_ADMISSION_RECEIPT_SCHEMA = 'acos-adapter-registration/v2' as const
export const ACOS_ADMISSION_FINDING_SCHEMA = 'acos-adapter-registration-finding/v1' as const
export const ACOS_ADMISSION_PROVIDER_CONTRACT = 'commerce.acos-admission-provider/v3' as const
export const ACOS_DEPLOYMENT_IDENTITY_SCHEMA = 'acos-cloudflare-deployment-identity/v1' as const
export const ACOS_ADMISSION_PATH = '/internal/v2/adapter-registrations' as const
export const COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF =
  'operator://agentic-graph/commerce-adapter-admission/2026-09-03' as const

const MAXIMUM_ADMISSION_RESPONSE_BYTES = 262_144
const ACOS_AGENT_DEFINITION_FIELDS = Object.freeze([
  'id', 'revision', 'name', 'source', 'model', 'instructions', 'tools', 'guardrails',
  'mcpServers', 'handoffs', 'output', 'status',
])
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'adapter_identity',
  'agent_definition_id',
  'tool_allowlist_entry_id',
  'invocation_register_tokens',
  'resulting_status',
  'operator_instruction_reference',
  'registered_at_ms',
  'deployment_identity',
])
const DEPLOYMENT_IDENTITY_KEYS = Object.freeze([
  'schema', 'sourceRevision', 'candidateDigest', 'versionId', 'versionTag', 'versionTimestamp',
])
const REJECTION_KEYS = Object.freeze(['status', 'record', 'finding'])
const FINDING_KEYS = Object.freeze([
  'schema',
  'type',
  'adapter_identity',
  'reason_code',
  'message',
  'details',
])
const UNFEDERATED_TERMINAL_REJECTION_CODES = new Set([
  'agent_capacity',
  'agent_definition_invalid',
  'agent_revision_capacity',
  'agent_revision_conflict',
  'fence_stale',
  'lease_expired',
  'mutation_out_of_write_set',
  'mutation_request_mismatch',
  'operator_instruction_required',
  'outcome_capacity',
  'registration_input_invalid',
  'registration_status_not_active',
  'tool_allowlist_capacity',
  'tool_allowlist_entry_conflict',
  'tool_allowlist_entry_invalid',
  'tool_allowlist_entry_missing',
])
const UNCATALOGUED_TERMINAL_REJECTION_CODES = new Set(['invocation_register_entry_invalid'])
const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u

export type AcosAdmissionInputs = Readonly<{
  agentDefinition: unknown
  toolAllowlistEntry: unknown
  invocationRegisterEntry: unknown
  operatorInstructionRef: string
}>

export type AcosAdmissionReceipt = Readonly<{
  schema: typeof ACOS_ADMISSION_RECEIPT_SCHEMA
  adapter_identity: string
  agent_definition_id: string
  tool_allowlist_entry_id: string
  invocation_register_tokens: readonly string[]
  resulting_status: 'active'
  operator_instruction_reference: string
  registered_at_ms: number
  deployment_identity: AcosDeploymentIdentity
}>

export type AcosDeploymentPin = Readonly<{
  sourceRevision: string
  candidateDigest: string
}>

export type AcosDeploymentIdentity = Readonly<{
  schema: typeof ACOS_DEPLOYMENT_IDENTITY_SCHEMA
  sourceRevision: string
  candidateDigest: string
  versionId: string
  versionTag: string
  versionTimestamp: string
}>

export function projectCommerceAgentDefinitionForAcos(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)
    || !isRecord(value.executableTarget)
    || Object.keys(value).some((key) => key !== 'executableTarget' && !ACOS_AGENT_DEFINITION_FIELDS.includes(key))
    || !['id', 'revision', 'name', 'source', 'model', 'instructions']
      .every((key) => Object.hasOwn(value, key))) return null
  return Object.freeze(Object.fromEntries(ACOS_AGENT_DEFINITION_FIELDS.flatMap((key) => (
    Object.hasOwn(value, key) ? [[key, value[key]]] : []
  ))))
}

export type AcosAdmissionFinding = Readonly<{
  schema: typeof ACOS_ADMISSION_FINDING_SCHEMA
  type: 'unfederated-tool' | 'uncatalogued-tool'
  adapter_identity: string | null
  reason_code: string
  message: string
  details: Readonly<Record<string, unknown>>
}>

export type AcosAdmissionResult =
  | Readonly<{ ok: true; receipt: AcosAdmissionReceipt }>
  | Readonly<{
      ok: false
      code: string
      providerStatus: number
      finding: AcosAdmissionFinding | null
      reservationSafeToComplete: boolean
    }>

export async function requestAcosAdmission(
  binding: Fetcher,
  input: AcosAdmissionInputs,
  authoringMutationIntent: unknown,
  permit: ClaimMutationPermit,
  deploymentPin: AcosDeploymentPin,
  authenticationSecret: string,
): Promise<AcosAdmissionResult> {
  if (input.operatorInstructionRef !== COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF) {
    return rejected('acos_admission_operator_instruction_reference_invalid', 0, null, false)
  }
  let response: Response
  try {
    const body = JSON.stringify({
      agent_definition: input.agentDefinition,
      authoring_mutation_intent: authoringMutationIntent,
      tool_allowlist_entry: input.toolAllowlistEntry,
      invocation_register_entry: input.invocationRegisterEntry,
      operator_instruction_ref: input.operatorInstructionRef,
    })
    const unsigned = new Request(`https://acos-admission.internal${ACOS_ADMISSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authoringMutationHeaders(permit) },
      body,
      signal: AbortSignal.timeout(3_000),
    })
    const authenticated = await authenticateAcosAdmissionRequest(
      unsigned, body, ACOS_ADMISSION_PROVIDER_CONTRACT, authenticationSecret,
    )
    if (!authenticated) return rejected('acos_admission_authentication_unavailable', 0, null, false)
    response = await binding.fetch(authenticated)
  } catch {
    return rejected('acos_admission_provider_unavailable', 503, null, false)
  }

  if (!responseMatchesAuthoringMutation(response, permit)) {
    try {
      await response.body?.cancel('acos_admission_fence_unconfirmed')
    } catch {
      // The response is untrusted and must not change the fail-closed result.
    }
    return rejected('acos_admission_fence_unconfirmed', response.status, null, false)
  }

  const payload = await readJsonResponse(response, MAXIMUM_ADMISSION_RESPONSE_BYTES)
  if (isHttpFailure(payload)) return rejected('acos_admission_response_invalid', response.status, null, false)
  if (!response.ok) {
    const finding = response.status === 409 ? readDurableTerminalRejection(payload) : null
    return finding
      ? rejected('acos_admission_rejected', response.status, finding, true)
      : rejected('acos_admission_rejection_invalid', response.status, null, false)
  }
  if (response.status !== 200
    || !isRecord(payload)
    || !hasExactKeys(payload, ['status', 'record', 'finding'])
    || payload.status !== 'registered'
    || payload.finding !== null
    || !isAcosAdmissionReceiptBoundToInputs(payload.record, input, deploymentPin)) {
    return rejected('acos_admission_receipt_invalid', response.status, null, false)
  }
  return Object.freeze({ ok: true, receipt: payload.record })
}

export async function probeAcosAdmission(
  binding: Fetcher,
  deploymentPin: AcosDeploymentPin | null,
  authenticationSecret: string,
): Promise<unknown> {
  if (!deploymentPin) return Object.freeze({ ok: false, code: 'acos_deployment_pin_invalid' })
  let response: Response
  try {
    const unsigned = new Request(`https://acos-admission.internal${ACOS_ADMISSION_PATH}/readyz`, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    })
    const authenticated = await authenticateAcosAdmissionRequest(
      unsigned, '', ACOS_ADMISSION_PROVIDER_CONTRACT, authenticationSecret,
    )
    if (!authenticated) return Object.freeze({ ok: false, code: 'acos_admission_authentication_unavailable' })
    response = await binding.fetch(authenticated)
  } catch {
    return Object.freeze({ ok: false, code: 'acos_admission_provider_unavailable' })
  }
  const payload = await readJsonResponse(response, MAXIMUM_ADMISSION_RESPONSE_BYTES)
  const identity = isRecord(payload) ? readDeploymentIdentity(payload.deploymentIdentity, deploymentPin) : null
  const valid = response.status === 200
    && isRecord(payload)
    && hasExactKeys(payload, [
      'ok', 'contract', 'receiptSchema', 'operations', 'deploymentIdentity', 'productionReady',
    ])
    && payload.ok === true
    && payload.productionReady === true
    && payload.contract === ACOS_ADMISSION_PROVIDER_CONTRACT
    && payload.receiptSchema === ACOS_ADMISSION_RECEIPT_SCHEMA
    && Array.isArray(payload.operations)
    && payload.operations.length === 1
    && payload.operations[0] === 'register-fenced'
    && identity !== null
  return Object.freeze({
    ok: response.ok && valid,
    status: response.status,
    contract: valid ? payload.contract : null,
    receiptSchema: valid ? payload.receiptSchema : null,
    deploymentIdentity: valid ? identity : null,
  })
}

export function readAcosDeploymentPin(sourceRevision: unknown, candidateDigest: unknown): AcosDeploymentPin | null {
  return typeof sourceRevision === 'string'
    && SHA1_PATTERN.test(sourceRevision)
    && typeof candidateDigest === 'string'
    && SHA256_PATTERN.test(candidateDigest)
    ? Object.freeze({ sourceRevision, candidateDigest })
    : null
}

export function isAcosAdmissionReceiptBoundToInputs(
  value: unknown,
  input: AcosAdmissionInputs,
  deploymentPin?: AcosDeploymentPin,
): value is AcosAdmissionReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false
  if (value.schema !== ACOS_ADMISSION_RECEIPT_SCHEMA
    || value.resulting_status !== 'active'
    || !isNonemptyString(value.adapter_identity)
    || !isNonemptyString(value.agent_definition_id)
    || !isNonemptyString(value.tool_allowlist_entry_id)
    || typeof value.operator_instruction_reference !== 'string'
    || value.operator_instruction_reference !== input.operatorInstructionRef
    || !Number.isSafeInteger(value.registered_at_ms)
    || Number(value.registered_at_ms) < 0
    || readDeploymentIdentity(value.deployment_identity, deploymentPin) === null) return false

  const definition = isRecord(input.agentDefinition) ? input.agentDefinition : null
  const allowlist = isRecord(input.toolAllowlistEntry) ? input.toolAllowlistEntry : null
  const invocation = isRecord(input.invocationRegisterEntry) ? input.invocationRegisterEntry : null
  if (!definition || !allowlist || !invocation) return false
  if (definition.id !== value.agent_definition_id
    || allowlist.agent_definition_id !== value.agent_definition_id
    || allowlist.entry_id !== value.tool_allowlist_entry_id
    || allowlist.adapter_identity !== value.adapter_identity) return false

  const expectedTokens = ['route', 'tag', 'binding', 'tool_identity'].map((field) => invocation[field])
  const receiptTokens = value.invocation_register_tokens
  return expectedTokens.every((token): token is string => typeof token === 'string' && token.length > 0)
    && Array.isArray(receiptTokens)
    && receiptTokens.length === expectedTokens.length
    && expectedTokens.every((token, index) => receiptTokens[index] === token)
}

function readDeploymentIdentity(
  value: unknown,
  expected?: AcosDeploymentPin,
): AcosDeploymentIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, DEPLOYMENT_IDENTITY_KEYS)) return null
  if (value.schema !== ACOS_DEPLOYMENT_IDENTITY_SCHEMA
    || typeof value.sourceRevision !== 'string'
    || !SHA1_PATTERN.test(value.sourceRevision)
    || typeof value.candidateDigest !== 'string'
    || !SHA256_PATTERN.test(value.candidateDigest)
    || typeof value.versionId !== 'string'
    || !UUID_PATTERN.test(value.versionId)
    || value.versionTag !== `acos-prod-${value.candidateDigest}`
    || typeof value.versionTimestamp !== 'string'
    || !UTC_TIMESTAMP_PATTERN.test(value.versionTimestamp)
    || !Number.isFinite(Date.parse(value.versionTimestamp))
    || (expected !== undefined && (value.sourceRevision !== expected.sourceRevision
      || value.candidateDigest !== expected.candidateDigest))) return null
  return Object.freeze({
    schema: ACOS_DEPLOYMENT_IDENTITY_SCHEMA,
    sourceRevision: value.sourceRevision,
    candidateDigest: value.candidateDigest,
    versionId: value.versionId,
    versionTag: value.versionTag,
    versionTimestamp: value.versionTimestamp,
  })
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText)
  const expected = [...keys].sort(compareText)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readDurableTerminalRejection(value: unknown): AcosAdmissionFinding | null {
  if (!isRecord(value)
    || !hasExactKeys(value, REJECTION_KEYS)
    || value.status !== 'rejected'
    || value.record !== null
    || !isRecord(value.finding)
    || !hasExactKeys(value.finding, FINDING_KEYS)) return null
  const finding = value.finding
  const exactTerminalPair = finding.type === 'unfederated-tool'
    ? UNFEDERATED_TERMINAL_REJECTION_CODES.has(String(finding.reason_code))
    : finding.type === 'uncatalogued-tool'
      && UNCATALOGUED_TERMINAL_REJECTION_CODES.has(String(finding.reason_code))
  if (finding.schema !== ACOS_ADMISSION_FINDING_SCHEMA
    || (finding.type !== 'unfederated-tool' && finding.type !== 'uncatalogued-tool')
    || (finding.adapter_identity !== null && !isNonemptyString(finding.adapter_identity))
    || typeof finding.reason_code !== 'string'
    || !exactTerminalPair
    || !isNonemptyString(finding.message)
    || !isRecord(finding.details)) return null
  return Object.freeze({
    schema: ACOS_ADMISSION_FINDING_SCHEMA,
    type: finding.type,
    adapter_identity: finding.adapter_identity,
    reason_code: finding.reason_code,
    message: finding.message,
    details: Object.freeze({ ...finding.details }),
  })
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function rejected(
  code: string,
  providerStatus: number,
  finding: AcosAdmissionFinding | null,
  reservationSafeToComplete: boolean,
): Exclude<AcosAdmissionResult, { ok: true }> {
  return Object.freeze({ ok: false, code, providerStatus, finding, reservationSafeToComplete })
}
