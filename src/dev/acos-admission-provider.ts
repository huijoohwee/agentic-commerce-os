import {
  ACOS_ADMISSION_RECEIPT_SCHEMA,
  COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  type AcosDeploymentIdentity,
} from '../core/acos-admission.js'
import {
  AGENT_REGISTRY_CLAIM,
  authoringMutationRequestDigest,
  type ClaimMutationPermit,
} from '../domain/authoring-claim-policy.js'
import { canonicalJson } from '../shared/digest.js'
import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.js'
import { readAuthoringMutationHeaders } from '../core/authoring-mutation-headers.ts'
import { verifyAcosAdmissionRequestAuthentication } from '../shared/acos-admission-auth.ts'
import { admitDevAuthoringMutation, devAuthoringHeaders } from './authoring-fence.js'

const MAXIMUM_REQUEST_BYTES = 262_144
const BODY_FIELDS = Object.freeze([
  'agent_definition', 'authoring_mutation_intent', 'invocation_register_entry',
  'operator_instruction_ref', 'tool_allowlist_entry',
])
const INTENT_FIELDS = Object.freeze([
  'admissionInputs', 'commerceProjection', 'expectedPreviousContentHash', 'invocationProof', 'sandboxDryRun',
])
const INPUT_FIELDS = Object.freeze([
  'agentDefinition', 'invocationRegisterEntry', 'operatorInstructionRef', 'toolAllowlistEntry',
])
export const DEV_ACOS_ADMISSION_AUTH_SECRET = 'acos-admission-dev-secret-rotate-before-production'

export async function devAcosAdmissionResponse(
  request: Request,
  deploymentIdentity: AcosDeploymentIdentity,
  catalogTokens: readonly string[],
  authenticationSecret = DEV_ACOS_ADMISSION_AUTH_SECRET,
): Promise<Response> {
  const authenticationPermit = readAuthoringMutationHeaders(request)
  if (!authenticationPermit
    || !await verifyAcosAdmissionRequestAuthentication(
      request, 'commerce.acos-admission-provider/v3', authenticationSecret,
    )) {
    return Response.json({ ok: false, code: 'acos_admission_authentication_invalid' }, { status: 401 })
  }
  const fenced = admitDevAuthoringMutation(request, AGENT_REGISTRY_CLAIM)
  if (!fenced.ok) return rejection(devFenceReason(fenced.code), fenced.permit)
  const body = await bodyRecord(request)
  if (!body || !hasExactFields(body, BODY_FIELDS)) {
    return rejection('registration_input_invalid', fenced.permit)
  }
  const intent = isRecord(body.authoring_mutation_intent)
    && hasExactFields(body.authoring_mutation_intent, INTENT_FIELDS)
    && isRecord(body.authoring_mutation_intent.admissionInputs)
    && hasExactFields(body.authoring_mutation_intent.admissionInputs, INPUT_FIELDS)
    ? body.authoring_mutation_intent : null
  if (!intent || await authoringMutationRequestDigest(AGENT_REGISTRY_CLAIM, intent)
    !== fenced.permit.requestDigest) return rejection('mutation_request_mismatch', fenced.permit)
  const wireInputs = {
    agentDefinition: body.agent_definition,
    toolAllowlistEntry: body.tool_allowlist_entry,
    invocationRegisterEntry: body.invocation_register_entry,
    operatorInstructionRef: body.operator_instruction_ref,
  }
  if (canonicalJson(intent.admissionInputs) !== canonicalJson(wireInputs)) {
    return rejection('mutation_request_mismatch', fenced.permit)
  }
  const definition = isRecord(body.agent_definition) ? body.agent_definition : null
  const allowlist = isRecord(body.tool_allowlist_entry) ? body.tool_allowlist_entry : null
  const invocation = isRecord(body.invocation_register_entry) ? body.invocation_register_entry : null
  const invocationTokens = invocation
    ? ['route', 'tag', 'binding', 'tool_identity'].map((field) => invocation[field]) : []
  const declaredTokens = new Set([...catalogTokens, 'acos.adapter.register'])
  if (!definition || typeof definition.id !== 'string'
    || (definition.status !== undefined && definition.status !== 'active')
    || !allowlist || typeof allowlist.entry_id !== 'string'
    || allowlist.agent_definition_id !== definition.id
    || typeof allowlist.adapter_identity !== 'string'
    || !Array.isArray(allowlist.tool_names) || allowlist.tool_names.length === 0
    || allowlist.tool_names.some((tool) => typeof tool !== 'string')
    || !invocation
    || invocationTokens.some((token) => typeof token !== 'string' || !declaredTokens.has(token))
    || body.operator_instruction_ref !== COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF) {
    return rejection('agent_definition_invalid', fenced.permit)
  }
  return Response.json({
    status: 'registered',
    record: {
      schema: ACOS_ADMISSION_RECEIPT_SCHEMA,
      adapter_identity: allowlist.adapter_identity,
      agent_definition_id: definition.id,
      tool_allowlist_entry_id: allowlist.entry_id,
      invocation_register_tokens: invocationTokens,
      resulting_status: 'active',
      operator_instruction_reference: body.operator_instruction_ref,
      registered_at_ms: 1_787_702_400_000,
      deployment_identity: deploymentIdentity,
    },
    finding: null,
  }, { headers: devAuthoringHeaders(fenced.permit) })
}

function rejection(reasonCode: string, permit: ClaimMutationPermit | null): Response {
  return Response.json({
    status: 'rejected',
    record: null,
    finding: {
      schema: 'acos-adapter-registration-finding/v1',
      type: 'unfederated-tool',
      adapter_identity: null,
      reason_code: reasonCode,
      message: 'The demo-only ACOS admission fixture rejected the registration.',
      details: {},
    },
  }, { status: 409, headers: devAuthoringHeaders(permit) })
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readJsonObject(request, MAXIMUM_REQUEST_BYTES)
  return isHttpFailure(body) ? null : body
}

function hasExactFields(value: Record<string, unknown>, expectedFields: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...expectedFields].sort()
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

function devFenceReason(code: string): string {
  return code === 'authoring_mutation_lease_expired' ? 'lease_expired'
    : code === 'authoring_mutation_fence_stale' ? 'fence_stale' : 'mutation_request_mismatch'
}
