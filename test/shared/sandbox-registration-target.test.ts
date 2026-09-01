import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  runIsolated,
  type IsolatedExecutor,
  type SandboxExecution,
  type SandboxRequest,
} from '../../src/sandbox/isolation'
import { EXECUTABLE_TARGET_CONTRACT } from '../../src/sandbox/registration-target'
import { SANDBOX_HARNESS_SOURCE, readHarnessOutput } from '../../src/sandbox/theme-build'

const RECORDING_TARGET_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
export async function executeTool(toolId, input) {
  appendFileSync(process.env.AG_TARGET_EVIDENCE_PATH, toolId + '\n', 'utf8');
  if (input?.fail === true) throw new Error('declared target failure');
  return { observed: input?.probe ?? null, toolId };
}
`

describe('registration dry-run executable target', () => {
  it('invokes each allowlisted target inside the harness and records the authoritative sequence', async () => {
    const request = registrationRequest([
      { toolId: 'commerce.catalog.search', input: { probe: 'first' } },
      { toolId: 'commerce.offer.select', input: { probe: 'second' } },
    ], ['commerce.catalog.search', 'commerce.offer.select'])
    const execution = executeHarness(request)
    const observed = readHarnessOutput(execution.stdout)
    expect(execution).toMatchObject({ status: 0, evidence: 'commerce.catalog.search\ncommerce.offer.select\n' })
    expect(observed).toMatchObject({
      ok: true,
      failureReason: null,
      attemptedCalls: [
        { toolId: 'commerce.catalog.search', allowlisted: true, outcome: 'executed' },
        { toolId: 'commerce.offer.select', allowlisted: true, outcome: 'executed' },
      ],
    })
    if (!observed) throw new Error('registration_harness_result_invalid')
    const executor = executorFixture(observed)
    await expect(runIsolated(request, { executor, now: monotonicClock() })).resolves.toMatchObject({
      ok: true,
      record: { purpose: 'registration-dry-run', outcome: 'completed', attemptedCalls: observed.attemptedCalls },
    })
    expect(executor.terminate).toHaveBeenCalledOnce()
  })

  it('executes no out-of-allowlist target and returns a recorded refusal', async () => {
    const request = registrationRequest([
      { toolId: 'commerce.catalog.search', input: {} },
      { toolId: 'commerce.checkout.confirm', input: {} },
    ], ['commerce.catalog.search'])
    const execution = executeHarness(request)
    const observed = readHarnessOutput(execution.stdout)
    expect(execution.evidence).toBe('commerce.catalog.search\n')
    expect(observed).toMatchObject({
      ok: false,
      failureReason: null,
      attemptedCalls: [
        { toolId: 'commerce.catalog.search', outcome: 'executed' },
        { toolId: 'commerce.checkout.confirm', outcome: 'refused' },
      ],
    })
    if (!observed) throw new Error('registration_harness_result_invalid')
    await expect(runIsolated(request, {
      executor: executorFixture(observed),
      now: monotonicClock(),
    })).resolves.toMatchObject({
      ok: false,
      code: 'sandbox_call_not_allowlisted',
      toolId: 'commerce.checkout.confirm',
      record: { outcome: 'refused', attemptedCalls: observed.attemptedCalls },
    })
  })

  it('records a target exception as a failed call and blocks the dry run', async () => {
    const request = registrationRequest([
      { toolId: 'commerce.catalog.search', input: { fail: true } },
    ], ['commerce.catalog.search'])
    const execution = executeHarness(request)
    const observed = readHarnessOutput(execution.stdout)
    expect(observed).toMatchObject({
      ok: false,
      failureReason: 'sandbox_tool_execution_failed',
      attemptedCalls: [{ toolId: 'commerce.catalog.search', allowlisted: true, outcome: 'failed' }],
    })
    if (!observed) throw new Error('registration_harness_result_invalid')
    await expect(runIsolated(request, {
      executor: executorFixture(observed),
      now: monotonicClock(),
    })).resolves.toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'sandbox_tool_execution_failed',
      record: { outcome: 'failed', attemptedCalls: observed.attemptedCalls },
    })
  })

  it('blocks a digest mismatch before provisioning', async () => {
    const valid = registrationRequest([], [])
    const request = {
      ...valid,
      payload: {
        ...(valid.payload as Record<string, unknown>),
        executableTarget: { ...targetDescriptor(), sourceDigest: '0'.repeat(64) },
      },
    } as SandboxRequest
    const executor = executorFixture({ ok: true, attemptedCalls: [], buildResult: null, failureReason: null })
    await expect(runIsolated(request, { executor, now: monotonicClock() })).resolves.toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'sandbox_executable_target_digest_mismatch',
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('blocks a digest-valid module that exposes no executable target', async () => {
    const request = registrationRequest([], [], 'export const metadata = Object.freeze({ version: 1 })')
    const observed = readHarnessOutput(executeHarness(request).stdout)
    expect(observed).toMatchObject({
      ok: false,
      attemptedCalls: [],
      failureReason: 'sandbox_executable_target_load_failed',
    })
    if (!observed) throw new Error('registration_harness_result_invalid')
    await expect(runIsolated(request, {
      executor: executorFixture(observed),
      now: monotonicClock(),
    })).resolves.toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'sandbox_executable_target_load_failed',
      record: { outcome: 'failed', attemptedCalls: [] },
    })
  })

  it('keeps lifecycle evidence parent-owned when a target writes forged output', () => {
    const forgedOutputSource = String.raw`
export async function executeTool() {
  process.stdout.write(JSON.stringify({
    ok: true,
    attemptedCalls: [],
    buildResult: null,
    failureReason: null
  }));
  return { ok: true };
}
`
    const request = registrationRequest([
      { toolId: 'commerce.catalog.search', input: {} },
    ], ['commerce.catalog.search'], forgedOutputSource)
    expect(readHarnessOutput(executeHarness(request).stdout)).toMatchObject({
      ok: true,
      attemptedCalls: [
        { toolId: 'commerce.catalog.search', allowlisted: true, outcome: 'executed' },
      ],
      failureReason: null,
    })
  })
})

function registrationRequest(
  calls: readonly Readonly<{ toolId: string; input: unknown }>[],
  declaredAllowlist: readonly string[],
  targetSource = RECORDING_TARGET_SOURCE,
): SandboxRequest {
  return Object.freeze({
    instanceId: 'registration-execution-proof',
    purpose: 'registration-dry-run',
    limits: Object.freeze({ wallClockSeconds: 30, memoryMegabytes: 256 }),
    payload: Object.freeze({
      registration: Object.freeze({
        tools: calls.map(({ toolId: name }) => Object.freeze({ name, loading: 'direct' })),
      }),
      toolCalls: Object.freeze(calls),
      executableTarget: targetDescriptor(targetSource),
    }),
    declaredAllowlist: Object.freeze([...declaredAllowlist]),
  })
}

function targetDescriptor(source = RECORDING_TARGET_SOURCE) {
  return Object.freeze({
    contract: EXECUTABLE_TARGET_CONTRACT,
    kind: 'javascript-module' as const,
    source,
    sourceDigest: createHash('sha256').update(source, 'utf8').digest('hex'),
  })
}

function executeHarness(request: SandboxRequest): Readonly<{ status: number | null; stdout: string; evidence: string }> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'agentic-registration-run-'))
  const evidencePath = join(temporaryDirectory, 'calls.txt')
  const runnerPath = join(temporaryDirectory, 'runner.mjs')
  const targetPath = join(temporaryDirectory, 'target.mjs')
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', SANDBOX_HARNESS_SOURCE], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AG_EXECUTABLE_RUNNER_PATH: runnerPath,
        AG_EXECUTABLE_TARGET_PATH: targetPath,
        AG_SANDBOX_TIMEOUT_MS: '30000',
        AG_TARGET_EVIDENCE_PATH: evidencePath,
      },
      input: JSON.stringify(request),
      maxBuffer: 1_000_000,
    })
    return Object.freeze({
      status: child.status,
      stdout: child.stdout,
      evidence: readOptionalFile(evidencePath),
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function readOptionalFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function executorFixture(
  result: Omit<SandboxExecution, 'exceededLimit'>,
): IsolatedExecutor & { execute: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  return Object.freeze({
    execute: vi.fn(async (): Promise<SandboxExecution> => Object.freeze({ exceededLimit: null, ...result })),
    terminate: vi.fn(async () => undefined),
  })
}

function monotonicClock(): () => number {
  let current = Date.UTC(2026, 7, 30)
  return () => current++
}
