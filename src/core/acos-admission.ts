import { isHttpFailure, isRecord, readJsonResponse } from '../shared/http.ts'
import {
  AGENT_REGISTRY_CLAIM,
  authoringMutationRequestDigest,
  type ClaimMutationPermit,
} from '../domain/authoring-claim-policy.ts'
import { authenticateAcosAdmissionRequest } from '../shared/acos-admission-auth.ts'
import { canonicalJson, sha256Hex } from '../shared/digest.ts'
import {
  ACOS_DEPLOYMENT_IDENTITY_SCHEMA,
  readAcosDeploymentIdentity,
  readAcosDeploymentPin,
  validAcosDeploymentPin,
  type AcosDeploymentIdentity,
  type AcosDeploymentPin,
} from './acos-deployment-identity.ts'

export {
  ACOS_DEPLOYMENT_IDENTITY_SCHEMA,
  readAcosDeploymentPin,
  type AcosDeploymentIdentity,
  type AcosDeploymentPin,
}

export const ACOS_ADMISSION_RECEIPT_SCHEMA = 'agentic-os-adapter-registration/v2' as const
export const ACOS_ADMISSION_FINDING_SCHEMA = 'agentic-os-adapter-registration-finding/v1' as const
export const ACOS_ADMISSION_PROVIDER_CONTRACT = 'commerce.agentic-os-admission-provider/v3' as const
export const ACOS_ADMISSION_PATH = '/agentic-os/internal/v2/adapter-registrations' as const
export const ACOS_ADMISSION_SERVING_IDENTITY_HEADER =
  'x-agentic-os-serving-deployment-identity' as const
export const COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF =
  'operator://agentic-graph/commerce-adapter-admission/2026-09-03' as const

const MAXIMUM_ADMISSION_RESPONSE_BYTES = 262_144
const MAXIMUM_SERVING_IDENTITY_HEADER_BYTES = 2_048
const ACOS_ADMISSION_ORIGIN = 'https://agentic-os-admission.internal'
const COMMERCE_MUTATION_PERMIT_SCHEMA = 'agentic-graph-authoring-mutation-permit/v2' as const
const AGENTIC_OS_MUTATION_PERMIT_SCHEMA = 'agentic-os-authoring-mutation-permit/v2' as const
const AGENTIC_OS_OPERATION_SCHEMA = 'agentic-os-authoring-operation/v1' as const
const AGENTIC_GRAPH_AUTHORITY_SCHEMA = 'agentic-graph-commerce-admission-authority-projection/v1' as const
const AGENTIC_GRAPH_AUTHORITY_REF_PREFIX = 'authority://agentic-graph/commerce-admission/'
const AGENTIC_GRAPH_ISSUER_REPOSITORY = 'huijoohwee/agentic-graph'
const ADMISSION_SCOPE = 'operator-registry'
const ADMISSION_WRITE_TARGET = 'registry'
const AUTHORING_HEADER_FIELDS = Object.freeze([
  ['x-authoring-mutation-contract', 'schema'],
  ['x-authoring-mutation-id', 'mutationId'],
  ['x-authoring-operation-id', 'operationId'],
  ['x-authoring-request-digest', 'requestDigest'],
  ['x-authoring-mutation-sequence', 'mutationSequence'],
  ['x-authoring-semantic-scope', 'semanticScope'],
  ['x-authoring-claim-id', 'claimId'],
  ['x-authoring-lease-epoch', 'leaseEpoch'],
  ['x-authoring-lease-expires-at-ms', 'leaseExpiresAtMs'],
  ['x-authoring-fence-revision', 'fenceRevision'],
  ['x-authoring-write-target', 'requiredWriteTarget'],
  ['x-authoring-reserved-at-ms', 'reservedAtMs'],
] as const)
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
  'agentic_graph_authority',
  'deployment_identity',
])
const AUTHORITY_KEYS = Object.freeze([
  'schema',
  'admission_inputs_digest',
  'admission_request_digest',
  'authority_ref',
  'evidence_digest',
  'issuer_repository',
  'issuer_revision',
  'permit_digest',
  'expires_at_ms',
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
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const AUTHORITY_SUFFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

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
  agentic_graph_authority: AgenticGraphAdmissionAuthority
  deployment_identity: AcosDeploymentIdentity
}>

export type AgenticGraphAdmissionAuthority = Readonly<{
  schema: typeof AGENTIC_GRAPH_AUTHORITY_SCHEMA
  admission_inputs_digest: string
  admission_request_digest: string
  authority_ref: string
  evidence_digest: string
  issuer_repository: typeof AGENTIC_GRAPH_ISSUER_REPOSITORY
  issuer_revision: string
  permit_digest: string
  expires_at_ms: number
}>

export type AgenticOsAdmissionPermit = Readonly<{
  schema: typeof AGENTIC_OS_MUTATION_PERMIT_SCHEMA
  mutationId: string
  operationId: string
  requestDigest: string
  mutationSequence: number
  semanticScope: string
  claimId: string
  leaseEpoch: number
  leaseExpiresAtMs: number
  fenceRevision: string
  requiredWriteTarget: string
  reservedAtMs: number
}>

export async function createAgenticOsAdmissionPermit(
  authoringMutationIntent: unknown,
  permit: ClaimMutationPermit,
): Promise<AgenticOsAdmissionPermit | null> {
  if (permit.schema !== COMMERCE_MUTATION_PERMIT_SCHEMA
    || permit.semanticScope !== ADMISSION_SCOPE
    || permit.requiredWriteTarget !== ADMISSION_WRITE_TARGET
    || !validPermitFields({ ...permit })) return null
  const internalRequestDigest = await authoringMutationRequestDigest(
    AGENT_REGISTRY_CLAIM,
    authoringMutationIntent,
  )
  if (permit.requestDigest !== internalRequestDigest) return null
  const requestDigest = await agenticOsAdmissionRequestDigest(authoringMutationIntent)
  return Object.freeze({
    ...permit,
    schema: AGENTIC_OS_MUTATION_PERMIT_SCHEMA,
    mutationId: `mutation:${permit.leaseEpoch}:${permit.mutationSequence}:${requestDigest.slice(0, 32)}`,
    operationId: `operation:${requestDigest}`,
    requestDigest,
  })
}

export function agenticOsAdmissionRequestDigest(authoringMutationIntent: unknown): Promise<string> {
  return sha256Hex(canonicalJson({
    schema: AGENTIC_OS_OPERATION_SCHEMA,
    semanticScope: ADMISSION_SCOPE,
    writeTarget: ADMISSION_WRITE_TARGET,
    payload: authoringMutationIntent,
  }))
}

export function agenticOsAdmissionHeaders(
  permit: AgenticOsAdmissionPermit,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(AUTHORING_HEADER_FIELDS.map(([header, field]) => (
    [header, String(permit[field])]
  ))))
}

export function agenticOsAdmissionServingIdentityHeaders(
  identity: AcosDeploymentIdentity,
): Readonly<Record<string, string>> {
  const exact = readAcosDeploymentIdentity(identity)
  if (!exact) throw new TypeError('ACOS serving deployment identity is malformed.')
  return Object.freeze({
    [ACOS_ADMISSION_SERVING_IDENTITY_HEADER]: canonicalJson(exact),
  })
}

export function readAcosAdmissionServingIdentity(
  response: Response,
  expectedPin: AcosDeploymentPin,
): AcosDeploymentIdentity | null {
  const serialized = response.headers.get(ACOS_ADMISSION_SERVING_IDENTITY_HEADER)
  if (!serialized
    || new TextEncoder().encode(serialized).byteLength > MAXIMUM_SERVING_IDENTITY_HEADER_BYTES) return null
  try {
    const identity = readAcosDeploymentIdentity(JSON.parse(serialized), expectedPin)
    return identity && canonicalJson(identity) === serialized ? identity : null
  } catch {
    return null
  }
}

export function readAgenticOsAdmissionPermit(request: Request): AgenticOsAdmissionPermit | null {
  const values = Object.fromEntries(AUTHORING_HEADER_FIELDS.map(([header, field]) => (
    [field, request.headers.get(header)]
  ))) as Record<string, string | null>
  const permit = {
    schema: values.schema,
    mutationId: values.mutationId,
    operationId: values.operationId,
    requestDigest: values.requestDigest,
    mutationSequence: positiveInteger(values.mutationSequence),
    semanticScope: values.semanticScope,
    claimId: values.claimId,
    leaseEpoch: positiveInteger(values.leaseEpoch),
    leaseExpiresAtMs: positiveInteger(values.leaseExpiresAtMs),
    fenceRevision: values.fenceRevision,
    requiredWriteTarget: values.requiredWriteTarget,
    reservedAtMs: nonnegativeInteger(values.reservedAtMs),
  }
  return permit.schema === AGENTIC_OS_MUTATION_PERMIT_SCHEMA && validPermitFields(permit)
    ? Object.freeze(permit as AgenticOsAdmissionPermit) : null
}

function responseMatchesAgenticOsAdmission(response: Response, permit: AgenticOsAdmissionPermit): boolean {
  return Object.entries(agenticOsAdmissionHeaders(permit))
    .every(([name, value]) => response.headers.get(name) === value)
}

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
  if (!validAcosDeploymentPin(deploymentPin)) {
    return rejected('acos_deployment_pin_invalid', 0, null, false)
  }
  const admissionPermit = await createAgenticOsAdmissionPermit(authoringMutationIntent, permit)
  if (!admissionPermit) return rejected('acos_admission_permit_invalid', 0, null, false)
  let response: Response
  try {
    const body = JSON.stringify({
      agent_definition: input.agentDefinition,
      authoring_mutation_intent: authoringMutationIntent,
      tool_allowlist_entry: input.toolAllowlistEntry,
      invocation_register_entry: input.invocationRegisterEntry,
      operator_instruction_ref: input.operatorInstructionRef,
    })
    const unsigned = new Request(`${ACOS_ADMISSION_ORIGIN}${ACOS_ADMISSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...agenticOsAdmissionHeaders(admissionPermit) },
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

  if (!responseMatchesAgenticOsAdmission(response, admissionPermit)) {
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
  const servingIdentity = readAcosAdmissionServingIdentity(response, deploymentPin)
  if (!servingIdentity) {
    return rejected('acos_admission_serving_identity_invalid', response.status, null, false)
  }
  if (response.status !== 200
    || !isRecord(payload)
    || !hasExactKeys(payload, ['status', 'record', 'finding'])
    || payload.status !== 'registered'
    || payload.finding !== null
    || !isAcosAdmissionReceiptBoundToInputs(payload.record, input, {
      admissionInputsDigest: await sha256Hex(canonicalJson(input)),
      admissionRequestDigest: admissionPermit.requestDigest,
      permitDigest: await sha256Hex(canonicalJson(admissionPermit)),
    })) {
    return rejected('acos_admission_receipt_invalid', response.status, null, false)
  }
  return Object.freeze({ ok: true, receipt: payload.record })
}

export async function probeAcosAdmission(
  binding: Fetcher,
  deploymentPin: AcosDeploymentPin | null,
  authenticationSecret: string,
): Promise<unknown> {
  if (!deploymentPin || !validAcosDeploymentPin(deploymentPin)) {
    return Object.freeze({ ok: false, code: 'acos_deployment_pin_invalid' })
  }
  let response: Response
  try {
    const unsigned = new Request(`${ACOS_ADMISSION_ORIGIN}${ACOS_ADMISSION_PATH}/readyz`, {
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
  const authority = isRecord(payload) ? readGraphAuthority(payload.authority) : null
  const identity = isRecord(payload)
    ? readAcosDeploymentIdentity(payload.deploymentIdentity, deploymentPin) : null
  const valid = response.status === 200
    && isRecord(payload)
    && hasExactKeys(payload, [
      'ok', 'contract', 'receiptSchema', 'operations', 'productionReady',
      'deploymentIdentity', 'authority',
    ])
    && payload.ok === true
    && payload.productionReady === true
    && payload.contract === ACOS_ADMISSION_PROVIDER_CONTRACT
    && payload.receiptSchema === ACOS_ADMISSION_RECEIPT_SCHEMA
    && Array.isArray(payload.operations)
    && payload.operations.length === 1
    && payload.operations[0] === 'register-fenced'
    && authority !== null
    && identity !== null
  return Object.freeze({
    ok: response.ok && valid,
    status: response.status,
    contract: valid ? payload.contract : null,
    receiptSchema: valid ? payload.receiptSchema : null,
    deploymentIdentity: valid ? identity : null,
    authority: valid ? authority : null,
  })
}

export function isAcosAdmissionReceiptBoundToInputs(
  value: unknown,
  input: AcosAdmissionInputs,
  expectedAuthority?: Readonly<{
    admissionInputsDigest: string
    admissionRequestDigest: string
    permitDigest: string
  }>,
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
    || readGraphAuthority(value.agentic_graph_authority, expectedAuthority) === null
    || readAcosDeploymentIdentity(value.deployment_identity, deploymentPin) === null) return false

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

function readGraphAuthority(
  value: unknown,
  expected?: Readonly<{
    admissionInputsDigest: string
    admissionRequestDigest: string
    permitDigest: string
  }>,
): AgenticGraphAdmissionAuthority | null {
  if (!isRecord(value) || !hasExactKeys(value, AUTHORITY_KEYS)) return null
  if (value.schema !== AGENTIC_GRAPH_AUTHORITY_SCHEMA
    || typeof value.admission_inputs_digest !== 'string'
    || !SHA256_PATTERN.test(value.admission_inputs_digest)
    || typeof value.admission_request_digest !== 'string'
    || !SHA256_PATTERN.test(value.admission_request_digest)
    || typeof value.authority_ref !== 'string'
    || !value.authority_ref.startsWith(AGENTIC_GRAPH_AUTHORITY_REF_PREFIX)
    || !AUTHORITY_SUFFIX_PATTERN.test(value.authority_ref.slice(AGENTIC_GRAPH_AUTHORITY_REF_PREFIX.length))
    || typeof value.evidence_digest !== 'string'
    || !SHA256_PATTERN.test(value.evidence_digest)
    || value.issuer_repository !== AGENTIC_GRAPH_ISSUER_REPOSITORY
    || typeof value.issuer_revision !== 'string'
    || !SHA1_PATTERN.test(value.issuer_revision)
    || typeof value.permit_digest !== 'string'
    || !SHA256_PATTERN.test(value.permit_digest)
    || !Number.isSafeInteger(value.expires_at_ms)
    || Number(value.expires_at_ms) < 0
    || (expected !== undefined && (
      value.admission_inputs_digest !== expected.admissionInputsDigest
      || value.admission_request_digest !== expected.admissionRequestDigest
      || value.permit_digest !== expected.permitDigest
    ))) return null
  return Object.freeze({
    schema: AGENTIC_GRAPH_AUTHORITY_SCHEMA,
    admission_inputs_digest: value.admission_inputs_digest,
    admission_request_digest: value.admission_request_digest,
    authority_ref: value.authority_ref,
    evidence_digest: value.evidence_digest,
    issuer_repository: AGENTIC_GRAPH_ISSUER_REPOSITORY,
    issuer_revision: value.issuer_revision,
    permit_digest: value.permit_digest,
    expires_at_ms: Number(value.expires_at_ms),
  })
}

function validPermitFields(value: Record<string, unknown>): boolean {
  return typeof value.mutationId === 'string'
    && IDENTIFIER_PATTERN.test(value.mutationId)
    && typeof value.operationId === 'string'
    && IDENTIFIER_PATTERN.test(value.operationId)
    && typeof value.requestDigest === 'string'
    && SHA256_PATTERN.test(value.requestDigest)
    && Number.isSafeInteger(value.mutationSequence)
    && Number(value.mutationSequence) >= 1
    && typeof value.semanticScope === 'string'
    && IDENTIFIER_PATTERN.test(value.semanticScope)
    && typeof value.claimId === 'string'
    && IDENTIFIER_PATTERN.test(value.claimId)
    && Number.isSafeInteger(value.leaseEpoch)
    && Number(value.leaseEpoch) >= 1
    && Number.isSafeInteger(value.leaseExpiresAtMs)
    && Number(value.leaseExpiresAtMs) >= 1
    && typeof value.fenceRevision === 'string'
    && IDENTIFIER_PATTERN.test(value.fenceRevision)
    && typeof value.requiredWriteTarget === 'string'
    && value.requiredWriteTarget.length >= 1
    && value.requiredWriteTarget.length <= 512
    && Number.isSafeInteger(value.reservedAtMs)
    && Number(value.reservedAtMs) >= 0
    && Number(value.reservedAtMs) < Number(value.leaseExpiresAtMs)
    && value.operationId === `operation:${value.requestDigest}`
    && value.mutationId
      === `mutation:${value.leaseEpoch}:${value.mutationSequence}:${value.requestDigest.slice(0, 32)}`
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
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
