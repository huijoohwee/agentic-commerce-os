import { SANDBOX_HARNESS_SOURCE, readHarnessOutput } from '../src/sandbox/theme-build.ts'
import type { IsolatedExecutor, SandboxExecution } from '../src/sandbox/isolation.ts'
import { runIsolatedProcess } from './isolated-process.ts'

/** Uses the same harness as the cloud adapter, on an existing FOSS Podman host. */
export function createPodmanSandboxExecutor(config: Readonly<{
  podmanExecutable: string
  imageId: string
}>): IsolatedExecutor {
  const abort = new AbortController()
  let active: Promise<SandboxExecution> | null = null
  let used = false
  return Object.freeze({
    execute(input, timeoutMs) {
      if (used || abort.signal.aborted) return Promise.reject(new Error('podman_executor_already_used'))
      used = true
      active = (async () => {
        const result = await runIsolatedProcess({ ...config, timeoutMs, signal: abort.signal,
          entrypoint: 'harness.mjs',
          files: { 'harness.mjs': SANDBOX_HARNESS_SOURCE, 'input.json': JSON.stringify(input) },
          environment: {
            AG_SANDBOX_INPUT_PATH: '/tmp/input/input.json', AG_SANDBOX_ARTIFACT_PATH: '/tmp/artifact.json',
            AG_SANDBOX_PURPOSE: input.purpose, AG_SANDBOX_MEMORY_LIMIT_MB: '256',
            AG_SANDBOX_TIMEOUT_MS: String(timeoutMs), AG_EXECUTABLE_TARGET_PATH: '/tmp/target.mjs',
            AG_EXECUTABLE_RUNNER_PATH: '/tmp/runner.mjs',
          },
        })
        const observed = readHarnessOutput(result.stdout)
        return Object.freeze({
          ok: result.exitCode === 0 && !result.oomKilled && !result.timedOut && !result.outputTruncated && observed?.ok === true,
          exceededLimit: result.timedOut ? 'wall-clock' : result.oomKilled ? 'memory' : null,
          attemptedCalls: observed?.attemptedCalls ?? [],
          buildResult: observed?.buildResult ?? null,
          surfaceResult: observed?.surfaceResult ?? null,
          failureReason: observed?.failureReason ?? null,
        })
      })()
      return active
    },
    async terminate() { abort.abort(); await active?.catch(() => undefined) },
  })
}
