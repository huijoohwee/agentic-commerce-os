import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  parseSandboxRequest,
  runIsolated,
  type IsolatedExecutor,
} from '../../src/sandbox/isolation'
import { SANDBOX_HARNESS_SOURCE, readHarnessOutput } from '../../src/sandbox/theme-build'
import {
  WEBMCP_SANDBOX_TARGET_SOURCE,
  readWebMcpSandboxResult,
  webMcpSandboxInput,
} from '../../src/sandbox/webmcp-target'

describe('isolated WebMCP surface proof', () => {
  it('executes the exact shipped runtime and refuses drift before any action', () => {
    const execution = spawnSync(process.execPath, ['--input-type=module', '--eval', WEBMCP_SANDBOX_TARGET_SOURCE], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(execution.status, execution.stderr).toBe(0)
    const output = JSON.parse(execution.stdout) as Readonly<Record<string, unknown>>
    expect(output.ok).toBe(true)
    expect(readWebMcpSandboxResult(output.surfaceResult)).toMatchObject({
      status: 'completed',
      toolCount: 3,
      driftRefused: true,
      driftEventCount: 1,
      actionInvocationCount: 0,
    })
  })

  it('returns typed proof through the actual child-process harness and isolation boundary', async () => {
    const executor = childProcessExecutor()
    const request = parseSandboxRequest({
      instanceId: 'webmcp-isolation-proof',
      purpose: 'unshipped-surface-build',
      limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
      payload: webMcpSandboxInput(),
    })
    expect(request).not.toBeNull()
    if (!request) throw new Error('webmcp_sandbox_request_invalid')

    await expect(runIsolated(request, { executor })).resolves.toMatchObject({
      ok: true,
      surfaceResult: {
        status: 'completed',
        toolCount: 3,
        driftRefused: true,
        actionInvocationCount: 0,
      },
      record: { purpose: 'unshipped-surface-build', outcome: 'completed', attemptedCalls: [] },
    })
    expect(executor.terminate).toHaveBeenCalledOnce()
  })

  it('refuses drifted or caller-substituted runtime bytes before provisioning', () => {
    const valid = webMcpSandboxInput()
    for (const payload of [
      { ...valid, runtimeSource: `${valid.runtimeSource}\n` },
      { ...valid, runtimeDigest: '0'.repeat(64) },
      { ...valid, scenario: 'registration-success' },
      { ...valid, extra: true },
    ]) {
      expect(parseSandboxRequest({
        instanceId: 'webmcp-invalid-input',
        purpose: 'unshipped-surface-build',
        limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
        payload,
      })).toBeNull()
    }
  })
})

function childProcessExecutor(): IsolatedExecutor & { terminate: ReturnType<typeof vi.fn> } {
  const directory = mkdtempSync(join(tmpdir(), 'agentic-webmcp-sandbox-'))
  const inputPath = join(directory, 'input.json')
  const harnessPath = join(directory, 'harness.mjs')
  const targetPath = join(directory, 'target.mjs')
  const runnerPath = join(directory, 'runner.mjs')
  return {
    async execute(input, timeoutMs) {
      writeFileSync(inputPath, JSON.stringify(input), { encoding: 'utf8', mode: 0o600 })
      writeFileSync(harnessPath, SANDBOX_HARNESS_SOURCE, { encoding: 'utf8', mode: 0o600 })
      const startedAt = Date.now()
      const execution = spawnSync(process.execPath, [harnessPath], {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          ...process.env,
          AG_SANDBOX_INPUT_PATH: inputPath,
          AG_SANDBOX_TIMEOUT_MS: String(timeoutMs),
          AG_EXECUTABLE_TARGET_PATH: targetPath,
          AG_EXECUTABLE_RUNNER_PATH: runnerPath,
        },
      })
      const output = readHarnessOutput(execution.stdout)
      return Object.freeze({
        ok: execution.status === 0 && output?.ok === true,
        exceededLimit: Date.now() - startedAt >= timeoutMs ? 'wall-clock' as const : null,
        attemptedCalls: output?.attemptedCalls ?? Object.freeze([]),
        buildResult: output?.buildResult ?? null,
        surfaceResult: output?.surfaceResult ?? null,
        failureReason: output?.failureReason ?? null,
      })
    },
    terminate: vi.fn(async () => { rmSync(directory, { recursive: true, force: true }) }),
  }
}
