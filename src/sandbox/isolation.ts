import { isRecord } from '../shared/http.js'
import { executableTargetDigestMatches, readExecutableTarget } from './registration-target.js'
import type { SandboxHarnessFailureReason, ThemeBuildResult } from './theme-build.js'
import {
  validWebMcpSandboxInput,
  type WebMcpSandboxResult,
} from './webmcp-target.js'

export type SandboxPurpose = 'theme-build' | 'registration-dry-run' | 'unshipped-surface-build'
export type SandboxLimits = Readonly<{ wallClockSeconds: number; memoryMegabytes: number }>
export type AttemptedCall = Readonly<{
  toolId: string
  allowlisted: boolean
  outcome: 'executed' | 'refused' | 'failed'
}>
export type InstanceRecord = Readonly<{
  instanceId: string
  purpose: SandboxPurpose
  startedAt: string
  endedAt: string
  outcome: 'completed' | 'refused' | 'limit-exceeded' | 'failed'
  exceededLimit: 'wall-clock' | 'memory' | null
  configuredValue: number | null
  attemptedCalls: readonly AttemptedCall[]
}>
export type SandboxRequest = Readonly<{
  instanceId: string
  purpose: SandboxPurpose
  limits: SandboxLimits
  payload: unknown
  declaredAllowlist?: readonly string[]
}>
export type SandboxExecutionInput = Readonly<{
  purpose: SandboxPurpose
  payload: unknown
  declaredAllowlist: readonly string[]
}>
export type SandboxExecution = Readonly<{
  ok: boolean
  exceededLimit: 'wall-clock' | 'memory' | null
  attemptedCalls: readonly AttemptedCall[]
  buildResult?: ThemeBuildResult | null
  surfaceResult?: WebMcpSandboxResult | null
  failureReason?: SandboxHarnessFailureReason | null
}>
export type SandboxResult =
  | Readonly<{
    ok: true
    record: InstanceRecord
    buildResult?: Extract<ThemeBuildResult, { status: 'completed' }>
    surfaceResult?: WebMcpSandboxResult
  }>
  | Readonly<{
    ok: false
    code: 'sandbox_build_failed'
    buildResult: Extract<ThemeBuildResult, { status: 'failed' }>
    record: InstanceRecord
  }>
  | Readonly<{
    ok: false
    code: 'sandbox_call_not_allowlisted'
    toolId: string
    record: InstanceRecord
  }>
  | Readonly<{
    ok: false
    code: 'sandbox_blocked'
    reason: string
    rung: 'dev-proven'
    record: InstanceRecord
  }>
export type IsolatedExecutor = Readonly<{
  execute(input: SandboxExecutionInput, timeoutMs: number): Promise<SandboxExecution>
  terminate(): Promise<void>
}>
export type RunIsolatedOptions = Readonly<{ executor?: IsolatedExecutor; now?: () => number }>

// Wrangler 4.127.1 defines the configured `lite` container as 256 MiB.
export const SANDBOX_CONTAINER_MEMORY_MEGABYTES = 256
const MAXIMUM_WALL_CLOCK_SECONDS = 300
const MAXIMUM_PAYLOAD_BYTES = 512_000
const TERMINATION_LIMIT_MS = 5_000
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u
const TOOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const PROHIBITED_FIELDS = new Set([
  'authorization', 'cardidentifier', 'cardnumber', 'cardtoken', 'credential', 'cvv',
  'operatorauthority', 'password', 'paymentcredential', 'privatekey', 'secret',
  'settlementbinding', 'token',
])

export async function runIsolated(
  request: SandboxRequest,
  options: RunIsolatedOptions = {},
): Promise<SandboxResult> {
  validateRequest(request)
  const now = options.now ?? Date.now
  const startedAtMs = now()
  if (request.purpose === 'registration-dry-run') {
    const target = readExecutableTarget(request.payload)
    if (!target) {
      return blocked(request, startedAtMs, now(), 'sandbox_executable_target_required', [])
    }
    if (!await executableTargetDigestMatches(target)) {
      return blocked(request, startedAtMs, now(), 'sandbox_executable_target_digest_mismatch', [])
    }
  }
  if (!options.executor) return blocked(request, startedAtMs, now(), 'sandbox_executor_unavailable', [])

  try {
    const execution = await options.executor.execute(Object.freeze({
      purpose: request.purpose,
      payload: request.payload,
      declaredAllowlist: Object.freeze([...(request.declaredAllowlist ?? [])]),
    }), request.limits.wallClockSeconds * 1_000)
    const endedAtMs = now()
    const attempts = Object.freeze(execution.attemptedCalls.map((attempt) => Object.freeze({ ...attempt })))
    if (!executionTraceMatches(request, attempts, execution.ok)) {
      await terminateWithinBound(options.executor)
      return blocked(request, startedAtMs, endedAtMs, 'sandbox_execution_trace_invalid', attempts)
    }
    if (request.purpose === 'theme-build' && attempts.length > 0) {
      await terminateWithinBound(options.executor)
      return blocked(request, startedAtMs, endedAtMs, 'theme_build_tool_attempt_invalid', attempts)
    }
    const refused = attempts.find((attempt) => !attempt.allowlisted || attempt.outcome === 'refused')
    if (refused) {
      await terminateWithinBound(options.executor)
      return Object.freeze({
        ok: false,
        code: 'sandbox_call_not_allowlisted',
        toolId: refused.toolId,
        record: instanceRecord(request, startedAtMs, endedAtMs, 'refused', null, null, attempts),
      })
    }
    if (execution.exceededLimit) {
      await terminateWithinBound(options.executor)
      const configuredValue = execution.exceededLimit === 'wall-clock'
        ? request.limits.wallClockSeconds
        : Math.min(request.limits.memoryMegabytes, SANDBOX_CONTAINER_MEMORY_MEGABYTES)
      return blocked(
        request,
        startedAtMs,
        endedAtMs,
        `sandbox_${execution.exceededLimit}_limit_exceeded`,
        attempts,
        instanceRecord(
          request,
          startedAtMs,
          endedAtMs,
          'limit-exceeded',
          execution.exceededLimit,
          configuredValue,
          attempts,
        ),
      )
    }
    if (request.purpose === 'theme-build') {
      if (execution.surfaceResult !== undefined && execution.surfaceResult !== null) {
        await terminateWithinBound(options.executor)
        return blocked(request, startedAtMs, endedAtMs, 'unexpected_surface_result', attempts)
      }
      if (!execution.buildResult) {
        await terminateWithinBound(options.executor)
        return blocked(request, startedAtMs, endedAtMs, 'theme_build_result_missing', attempts)
      }
      if (execution.buildResult.status === 'failed') {
        await terminateWithinBound(options.executor)
        return Object.freeze({
          ok: false,
          code: 'sandbox_build_failed',
          buildResult: execution.buildResult,
          record: instanceRecord(request, startedAtMs, endedAtMs, 'failed', null, null, attempts),
        })
      }
      if (!execution.ok) {
        await terminateWithinBound(options.executor)
        return blocked(request, startedAtMs, endedAtMs, 'theme_build_execution_inconsistent', attempts)
      }
      await terminateWithinBound(options.executor)
      return Object.freeze({
        ok: true,
        buildResult: execution.buildResult,
        record: instanceRecord(request, startedAtMs, endedAtMs, 'completed', null, null, attempts),
      })
    }
    if (request.purpose === 'unshipped-surface-build') {
      if (execution.buildResult !== undefined && execution.buildResult !== null) {
        await terminateWithinBound(options.executor)
        return blocked(request, startedAtMs, endedAtMs, 'unexpected_build_result', attempts)
      }
      if (!execution.surfaceResult) {
        await terminateWithinBound(options.executor)
        return blocked(request, startedAtMs, endedAtMs, 'webmcp_surface_result_missing', attempts)
      }
      if (!execution.ok) {
        await terminateWithinBound(options.executor)
        return blocked(
          request,
          startedAtMs,
          endedAtMs,
          execution.failureReason ?? 'sandbox_webmcp_execution_failed',
          attempts,
        )
      }
      await terminateWithinBound(options.executor)
      return Object.freeze({
        ok: true,
        surfaceResult: execution.surfaceResult,
        record: instanceRecord(request, startedAtMs, endedAtMs, 'completed', null, null, attempts),
      })
    }
    if (execution.buildResult !== undefined && execution.buildResult !== null) {
      await terminateWithinBound(options.executor)
      return blocked(request, startedAtMs, endedAtMs, 'unexpected_build_result', attempts)
    }
    if (execution.surfaceResult !== undefined && execution.surfaceResult !== null) {
      await terminateWithinBound(options.executor)
      return blocked(request, startedAtMs, endedAtMs, 'unexpected_surface_result', attempts)
    }
    if (!execution.ok) {
      await terminateWithinBound(options.executor)
      return blocked(
        request,
        startedAtMs,
        endedAtMs,
        execution.failureReason ?? (attempts.at(-1)?.outcome === 'failed'
          ? 'sandbox_tool_execution_failed'
          : 'sandbox_execution_failed'),
        attempts,
      )
    }
    await terminateWithinBound(options.executor)
    return Object.freeze({
      ok: true,
      record: instanceRecord(request, startedAtMs, endedAtMs, 'completed', null, null, attempts),
    })
  } catch (error) {
    await terminateWithinBound(options.executor).catch(() => undefined)
    return blocked(
      request,
      startedAtMs,
      now(),
      error instanceof Error ? error.name : 'sandbox_execution_failed',
      [],
    )
  }
}

export function parseSandboxRequest(value: unknown): SandboxRequest | null {
  if (!isRecord(value)
    || Object.keys(value).some((field) => ![
      'instanceId', 'purpose', 'limits', 'payload', 'declaredAllowlist',
    ].includes(field))
    || typeof value.instanceId !== 'string'
    || !INSTANCE_PATTERN.test(value.instanceId)
    || (value.purpose !== 'theme-build'
      && value.purpose !== 'registration-dry-run'
      && value.purpose !== 'unshipped-surface-build')
    || !isRecord(value.limits)
    || !Number.isInteger(value.limits.wallClockSeconds)
    || !Number.isInteger(value.limits.memoryMegabytes)
    || (value.declaredAllowlist !== undefined && !validToolArray(value.declaredAllowlist))) return null
  const result: SandboxRequest = Object.freeze({
    instanceId: value.instanceId,
    purpose: value.purpose,
    limits: Object.freeze({
      wallClockSeconds: Number(value.limits.wallClockSeconds),
      memoryMegabytes: Number(value.limits.memoryMegabytes),
    }),
    payload: value.payload,
    ...(Array.isArray(value.declaredAllowlist)
      ? { declaredAllowlist: Object.freeze(value.declaredAllowlist as string[]) }
      : {}),
  })
  try {
    validateRequest(result)
    return result
  } catch {
    return null
  }
}

export function classifyExecutionLimit(
  text: string,
  durationMs: number,
  timeoutMs: number,
): 'wall-clock' | 'memory' | null {
  const normalized = text.toLowerCase()
  if (normalized.includes('out of memory') || normalized.includes('oom')) return 'memory'
  if (durationMs >= timeoutMs || normalized.includes('timeout') || normalized.includes('timed out')) return 'wall-clock'
  return null
}

function validateRequest(request: SandboxRequest): void {
  if (!INSTANCE_PATTERN.test(request.instanceId)
    || (request.purpose !== 'theme-build'
      && request.purpose !== 'registration-dry-run'
      && request.purpose !== 'unshipped-surface-build')
    || !Number.isInteger(request.limits.wallClockSeconds)
    || request.limits.wallClockSeconds < 1
    || request.limits.wallClockSeconds > MAXIMUM_WALL_CLOCK_SECONDS
    || !Number.isInteger(request.limits.memoryMegabytes)
    || request.limits.memoryMegabytes !== SANDBOX_CONTAINER_MEMORY_MEGABYTES
    || payloadTooLarge(request.payload)
    || containsProhibitedMaterial(request.payload)) throw new Error('sandbox_request_invalid')
  if (request.purpose === 'registration-dry-run'
    && (!request.declaredAllowlist || !validDryRunPayload(request.payload))) {
    throw new Error('sandbox_allowlist_required')
  }
  if (request.purpose === 'theme-build'
    && (request.declaredAllowlist !== undefined || !validThemeBuildPayload(request.payload))) {
    throw new Error('sandbox_theme_build_invalid')
  }
  if (request.purpose === 'unshipped-surface-build'
    && (request.declaredAllowlist !== undefined || !validWebMcpSandboxInput(request.payload))) {
    throw new Error('sandbox_webmcp_input_invalid')
  }
}

function instanceRecord(
  request: SandboxRequest,
  startedAtMs: number,
  endedAtMs: number,
  outcome: InstanceRecord['outcome'],
  exceededLimit: InstanceRecord['exceededLimit'],
  configuredValue: number | null,
  attemptedCalls: readonly AttemptedCall[],
): InstanceRecord {
  return Object.freeze({
    instanceId: request.instanceId,
    purpose: request.purpose,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(Math.max(startedAtMs, endedAtMs)).toISOString(),
    outcome,
    exceededLimit,
    configuredValue,
    attemptedCalls,
  })
}

function blocked(
  request: SandboxRequest,
  startedAtMs: number,
  endedAtMs: number,
  reason: string,
  attempts: readonly AttemptedCall[],
  record = instanceRecord(request, startedAtMs, endedAtMs, 'failed', null, null, attempts),
): SandboxResult {
  return Object.freeze({ ok: false, code: 'sandbox_blocked', reason, rung: 'dev-proven', record })
}

function validToolArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 500
    && value.every((entry) => typeof entry === 'string' && TOOL_PATTERN.test(entry))
    && new Set(value).size === value.length
}

function containsProhibitedMaterial(value: unknown, depth = 0): boolean {
  if (depth > 20) return true
  if (Array.isArray(value)) return value.some((entry) => containsProhibitedMaterial(entry, depth + 1))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, entry]) => (
    PROHIBITED_FIELDS.has(key.replace(/[^a-z]/giu, '').toLowerCase())
    || containsProhibitedMaterial(entry, depth + 1)
  ))
}

function validDryRunPayload(value: unknown): boolean {
  if (!isRecord(value)
    || Object.keys(value).some((field) => !['executableTarget', 'registration', 'toolCalls'].includes(field))
    || !isRecord(value.registration)
    || !Array.isArray(value.toolCalls)
    || value.toolCalls.length > 500) return false
  const declaredTools = readDefinitionToolIds(value.registration.tools)
  if (!declaredTools || declaredTools.length !== value.toolCalls.length) return false
  return value.toolCalls.every((call, index) => (
    isRecord(call)
    && Object.keys(call).sort().join(',') === 'input,toolId'
    && typeof call.toolId === 'string'
    && TOOL_PATTERN.test(call.toolId)
    && call.toolId === declaredTools[index]
  ))
}

function readDefinitionToolIds(value: unknown): readonly string[] | null {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 500) return null
  const toolIds: string[] = []
  for (const tool of value) {
    if (!isRecord(tool)
      || Object.keys(tool).some((field) => field !== 'name' && field !== 'loading')
      || typeof tool.name !== 'string'
      || !TOOL_PATTERN.test(tool.name)
      || (tool.loading !== undefined && tool.loading !== 'direct' && tool.loading !== 'deferred')) return null
    toolIds.push(tool.name)
  }
  return new Set(toolIds).size === toolIds.length ? Object.freeze(toolIds) : null
}

function validThemeBuildPayload(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, 'manifest')
}

function payloadTooLarge(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength > MAXIMUM_PAYLOAD_BYTES
  } catch {
    return true
  }
}

async function terminateWithinBound(executor: IsolatedExecutor): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      executor.terminate(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('sandbox_termination_timeout')),
          TERMINATION_LIMIT_MS,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function executionTraceMatches(
  request: SandboxRequest,
  attempts: readonly AttemptedCall[],
  executionOk: boolean,
): boolean {
  if (request.purpose === 'theme-build') return attempts.length === 0
  if (!isRecord(request.payload) || !Array.isArray(request.payload.toolCalls)) return attempts.length === 0
  const calls = request.payload.toolCalls
  if (attempts.length > calls.length) return false
  for (const [index, attempt] of attempts.entries()) {
    const call = calls[index]
    if (!isRecord(call) || call.toolId !== attempt.toolId) return false
  }
  return !executionOk || (attempts.length === calls.length
    && attempts.every(({ outcome }) => outcome === 'executed'))
}
