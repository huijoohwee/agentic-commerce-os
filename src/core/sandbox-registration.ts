import { DEVICE_HOST_CONTRACT } from '../sandbox/device-host.ts'
import { canonicalJson, sha256Hex } from '../shared/digest.js'
import { isRecord, readJsonResponse } from '../shared/http.js'
import { REGISTRATION_DRY_RUN_WALL_CLOCK_SECONDS, REGISTRATION_SANDBOX_TIMEOUT_MS } from '../shared/registration-budget.js'

const MAXIMUM_RESPONSE_BYTES = 262_144
const TOOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u

export type RegistrationDryRunAttempt = Readonly<{
  toolId: string
  allowlisted: true
  outcome: 'executed'
}>

export type RegistrationDryRunRecord = Readonly<{
  instanceId: string
  purpose: 'registration-dry-run'
  startedAt: string
  endedAt: string
  outcome: 'completed'
  exceededLimit: null
  configuredValue: null
  attemptedCalls: readonly RegistrationDryRunAttempt[]
}>

export type RegistrationDryRunResult =
  | Readonly<{ ok: true; record: RegistrationDryRunRecord }>
  | Readonly<{
      ok: false
      code: 'registration_dry_run_invalid' | 'registration_dry_run_rejected' | 'sandbox_blocked'
      reason: string
    }>

export type RegistrationSandboxReadiness = Readonly<{
  ok: boolean
  status: number
  contract: 'agentic-commerce-registration-sandbox/v1' | null
  versionId: string | null
}>

export async function probeRegistrationSandbox(
  binding: Fetcher,
  lane: string,
  candidateSha: string,
  candidateDigest: string,
): Promise<RegistrationSandboxReadiness> {
  let response: Response
  try {
    response = await binding.fetch(new Request('https://sandbox.internal/readyz', {
      method: 'GET',
      signal: AbortSignal.timeout(12_000),
    }))
  } catch {
    return Object.freeze({ ok: false, status: 503, contract: null, versionId: null })
  }
  const payload = await readJsonResponse(response, MAXIMUM_RESPONSE_BYTES)
  const version = isRecord(payload) && isRecord(payload.version) ? payload.version : null
  const containerProbe = isRecord(payload) && isRecord(payload.containerProbe) ? payload.containerProbe : null
  const hostProbe = isRecord(payload) && isRecord(payload.hostProbe) ? payload.hostProbe : null
  const deviceLane = lane === 'Production' || lane === 'Staging'
  const runtimeValid = deviceLane ? hostProbe !== null
    && exactKeys(hostProbe, ['ok', 'contract', 'availability', 'bundleSha256', 'imageId'])
    && hostProbe.ok === true && hostProbe.contract === DEVICE_HOST_CONTRACT
    && hostProbe.availability === 'device-session'
    && typeof hostProbe.bundleSha256 === 'string' && /^[a-f0-9]{64}$/u.test(hostProbe.bundleSha256)
    && typeof hostProbe.imageId === 'string' && /^[a-f0-9]{64}$/u.test(hostProbe.imageId)
    : containerProbe !== null && exactKeys(containerProbe, ['ok', 'runtime', 'version'])
      && containerProbe.ok === true && containerProbe.runtime === 'node' && containerProbe.version === 'v22.22.3'
  const valid = response.status === 200
    && isRecord(payload)
    && exactKeys(payload, [
      deviceLane ? 'hostProbe' : 'containerProbe', 'ok', 'contract', 'lane', 'releaseCandidateDigest', 'releaseCandidateSha', 'version',
    ])
    && payload.ok === true
    && payload.contract === 'agentic-commerce-registration-sandbox/v1'
    && payload.lane === lane
    && payload.releaseCandidateSha === candidateSha
    && payload.releaseCandidateDigest === candidateDigest
    && version !== null
    && exactKeys(version, ['id', 'tag', 'timestamp'])
    && typeof version.id === 'string'
    && version.id.length > 0
    && version.tag === candidateSha
    && typeof version.timestamp === 'string'
    && Number.isFinite(Date.parse(version.timestamp))
    && runtimeValid
  return Object.freeze({
    ok: valid,
    status: response.status,
    contract: valid ? 'agentic-commerce-registration-sandbox/v1' : null,
    versionId: valid ? version?.id as string : null,
  })
}

export async function runRegistrationDryRun(
  env: CoreEnv,
  agentDefinition: unknown,
  toolAllowlistEntry: unknown,
): Promise<RegistrationDryRunResult> {
  const request = await buildRegistrationDryRunRequest(agentDefinition, toolAllowlistEntry)
  if (!request) return rejected('registration_dry_run_invalid', 'registration_or_allowlist_invalid')
  if (!env.COMMERCE_SANDBOX) return rejected('sandbox_blocked', 'sandbox_binding_unavailable')

  let response: Response
  try {
    response = await env.COMMERCE_SANDBOX.fetch(new Request('https://sandbox.internal/v1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REGISTRATION_SANDBOX_TIMEOUT_MS),
    }))
  } catch {
    return rejected('sandbox_blocked', 'sandbox_request_failed')
  }

  let payload: unknown
  try {
    payload = await readJsonResponse(response, MAXIMUM_RESPONSE_BYTES)
  } catch {
    return rejected('sandbox_blocked', 'sandbox_response_invalid')
  }
  if (!response.ok) {
    if (isRecord(payload) && payload.code === 'sandbox_call_not_allowlisted') {
      return rejected('registration_dry_run_rejected', 'sandbox_call_not_allowlisted')
    }
    return rejected('sandbox_blocked', readBlockedReason(payload))
  }
  const record = readCompletedRecord(payload, request.payload.toolCalls.map(({ toolId }) => toolId))
  return record ? Object.freeze({ ok: true, record }) : rejected('sandbox_blocked', 'sandbox_response_invalid')
}

export function isRegistrationDryRunRecord(value: unknown): value is RegistrationDryRunRecord {
  return readCompletedRecord({ ok: true, record: value }, null) !== null
}

async function buildRegistrationDryRunRequest(agentDefinition: unknown, toolAllowlistEntry: unknown) {
  if (!isRecord(agentDefinition) || !isRecord(toolAllowlistEntry)) return null
  const toolNames = readDefinitionToolNames(agentDefinition.tools)
  const allowlist = readAllowlist(toolAllowlistEntry.tool_names)
  if (!toolNames || !allowlist) return null
  const digest = await sha256Hex(canonicalJson({ agentDefinition, allowlist, toolNames }))
  return Object.freeze({
    instanceId: `registration-${digest.slice(0, 32)}`,
    purpose: 'registration-dry-run' as const,
    limits: Object.freeze({ wallClockSeconds: REGISTRATION_DRY_RUN_WALL_CLOCK_SECONDS, memoryMegabytes: 256 }),
    payload: Object.freeze({
      registration: agentDefinition,
      toolCalls: Object.freeze(toolNames.map((toolId) => Object.freeze({ toolId, input: Object.freeze({}) }))),
      executableTarget: agentDefinition.executableTarget,
    }),
    declaredAllowlist: allowlist,
  })
}

function readDefinitionToolNames(value: unknown): readonly string[] | null {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 500) return null
  const names: string[] = []
  for (const tool of value) {
    if (!isRecord(tool)
      || Object.keys(tool).some((key) => key !== 'name' && key !== 'loading')
      || typeof tool.name !== 'string'
      || !TOOL_PATTERN.test(tool.name)
      || (tool.loading !== undefined && tool.loading !== 'direct' && tool.loading !== 'deferred')) return null
    names.push(tool.name)
  }
  return new Set(names).size === names.length ? Object.freeze(names) : null
}

function readAllowlist(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 500) return null
  const names = value.filter((entry): entry is string => typeof entry === 'string' && TOOL_PATTERN.test(entry))
  return names.length === value.length && new Set(names).size === names.length ? Object.freeze(names) : null
}

function readCompletedRecord(
  payload: unknown,
  expectedTools: readonly string[] | null,
): RegistrationDryRunRecord | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.record)) return null
  const record = payload.record
  if (typeof record.instanceId !== 'string'
    || record.purpose !== 'registration-dry-run'
    || typeof record.startedAt !== 'string'
    || typeof record.endedAt !== 'string'
    || !Number.isFinite(Date.parse(record.startedAt))
    || !Number.isFinite(Date.parse(record.endedAt))
    || Date.parse(record.endedAt) < Date.parse(record.startedAt)
    || record.outcome !== 'completed'
    || record.exceededLimit !== null
    || record.configuredValue !== null
    || !Array.isArray(record.attemptedCalls)) return null
  const attemptedCalls: RegistrationDryRunAttempt[] = []
  for (const attempt of record.attemptedCalls) {
    if (!isRecord(attempt)
      || typeof attempt.toolId !== 'string'
      || !TOOL_PATTERN.test(attempt.toolId)
      || attempt.allowlisted !== true
      || attempt.outcome !== 'executed') return null
    attemptedCalls.push(Object.freeze({ toolId: attempt.toolId, allowlisted: true, outcome: 'executed' }))
  }
  if (expectedTools && canonicalJson(attemptedCalls.map(({ toolId }) => toolId)) !== canonicalJson(expectedTools)) return null
  return Object.freeze({
    instanceId: record.instanceId,
    purpose: 'registration-dry-run',
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    outcome: 'completed',
    exceededLimit: null,
    configuredValue: null,
    attemptedCalls: Object.freeze(attemptedCalls),
  })
}

function readBlockedReason(payload: unknown): string {
  return isRecord(payload) && payload.code === 'sandbox_blocked' && typeof payload.reason === 'string'
    ? payload.reason
    : 'sandbox_execution_failed'
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function rejected(
  code: Exclude<RegistrationDryRunResult, { ok: true }>['code'],
  reason: string,
): Exclude<RegistrationDryRunResult, { ok: true }> {
  return Object.freeze({ ok: false, code, reason })
}
