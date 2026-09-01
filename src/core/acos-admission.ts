import { isHttpFailure, isRecord, readJsonResponse } from '../shared/http.ts'
import type { ClaimMutationPermit } from '../domain/authoring-claim-policy.js'
import {
  authoringMutationHeaders,
  responseMatchesAuthoringMutation,
} from './authoring-mutation-headers.ts'

export const ACOS_ADMISSION_RECEIPT_SCHEMA = 'acos-adapter-registration/v1' as const
export const ACOS_ADMISSION_PROVIDER_CONTRACT = 'commerce.acos-admission-provider/v1' as const
export const ACOS_ADMISSION_PATH = '/internal/v1/adapter-registrations' as const

const MAXIMUM_ADMISSION_RESPONSE_BYTES = 262_144
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'adapter_identity',
  'agent_definition_id',
  'tool_allowlist_entry_id',
  'invocation_register_tokens',
  'resulting_status',
  'operator_instruction_reference',
  'registered_at_ms',
])

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
}>

export type AcosAdmissionResult =
  | Readonly<{ ok: true; receipt: AcosAdmissionReceipt }>
  | Readonly<{
      ok: false
      code: string
      providerStatus: number
      finding: unknown
      reservationSafeToComplete: boolean
    }>

export async function requestAcosAdmission(
  binding: Fetcher,
  input: AcosAdmissionInputs,
  permit: ClaimMutationPermit,
): Promise<AcosAdmissionResult> {
  let response: Response
  try {
    response = await binding.fetch(new Request(`https://acos-admission.internal${ACOS_ADMISSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authoringMutationHeaders(permit) },
      body: JSON.stringify({
        agent_definition: input.agentDefinition,
        tool_allowlist_entry: input.toolAllowlistEntry,
        invocation_register_entry: input.invocationRegisterEntry,
        operator_instruction_ref: input.operatorInstructionRef,
      }),
      signal: AbortSignal.timeout(3_000),
    }))
  } catch {
    return rejected('acos_admission_provider_unavailable', 503, null, false)
  }

  if (!responseMatchesAuthoringMutation(response, permit)) {
    return rejected('acos_admission_fence_unconfirmed', response.status, null, false)
  }

  const payload = await readJsonResponse(response, MAXIMUM_ADMISSION_RESPONSE_BYTES)
  if (isHttpFailure(payload)) return rejected('acos_admission_response_invalid', response.status, null, false)
  if (!response.ok) {
    return rejected('acos_admission_rejected', response.status, isRecord(payload) ? payload.finding ?? null : null, true)
  }
  if (!isRecord(payload)
    || !hasExactKeys(payload, ['status', 'record', 'finding'])
    || payload.status !== 'registered'
    || payload.finding !== null
    || !isAcosAdmissionReceiptBoundToInputs(payload.record, input)) {
    return rejected('acos_admission_receipt_invalid', response.status, null, false)
  }
  return Object.freeze({ ok: true, receipt: payload.record })
}

export async function probeAcosAdmission(binding: Fetcher): Promise<unknown> {
  let response: Response
  try {
    response = await binding.fetch(new Request(`https://acos-admission.internal${ACOS_ADMISSION_PATH}/readyz`, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    }))
  } catch {
    return Object.freeze({ ok: false, code: 'acos_admission_provider_unavailable' })
  }
  const payload = await readJsonResponse(response, MAXIMUM_ADMISSION_RESPONSE_BYTES)
  const valid = isRecord(payload)
    && hasExactKeys(payload, ['ok', 'contract', 'receiptSchema', 'operations'])
    && payload.ok === true
    && payload.contract === ACOS_ADMISSION_PROVIDER_CONTRACT
    && payload.receiptSchema === ACOS_ADMISSION_RECEIPT_SCHEMA
    && Array.isArray(payload.operations)
    && payload.operations.length === 1
    && payload.operations[0] === 'register-fenced'
  return Object.freeze({
    ok: response.ok && valid,
    status: response.status,
    contract: valid ? payload.contract : null,
    receiptSchema: valid ? payload.receiptSchema : null,
  })
}

export function isAcosAdmissionReceiptBoundToInputs(
  value: unknown,
  input: AcosAdmissionInputs,
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
    || Number(value.registered_at_ms) < 0) return false

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

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText)
  const expected = [...keys].sort(compareText)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function rejected(
  code: string,
  providerStatus: number,
  finding: unknown,
  reservationSafeToComplete: boolean,
): Exclude<AcosAdmissionResult, { ok: true }> {
  return Object.freeze({ ok: false, code, providerStatus, finding, reservationSafeToComplete })
}
