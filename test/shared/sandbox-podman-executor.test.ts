import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPodmanSandboxExecutor } from '../../scripts/sandbox-podman-executor.ts'
import { runIsolatedProcess } from '../../scripts/isolated-process.ts'

vi.mock('../../scripts/isolated-process.ts', () => ({ runIsolatedProcess: vi.fn() }))
afterEach(() => vi.resetAllMocks())
const config = { podmanExecutable: '/operator/podman', imageId: 'a'.repeat(64) }
const input = { purpose: 'registration-dry-run' as const, payload: {}, declaredAllowlist: [] }
const harness = JSON.stringify({ ok: true, attemptedCalls: [], buildResult: null, surfaceResult: null, failureReason: null })
function result(changed = {}) {
  return { stdout: harness, stderr: '', exitCode: 0, timedOut: false, outputTruncated: false,
    oomKilled: false, containerRemoved: true as const, imageId: config.imageId, ...changed }
}
describe('direct Podman sandbox', () => {
  it('maps a real harness result and prevents reuse of a destroyed execution instance', async () => {
    vi.mocked(runIsolatedProcess).mockResolvedValue(result())
    const executor = createPodmanSandboxExecutor(config)
    expect(await executor.execute(input, 1000)).toMatchObject({ ok: true, exceededLimit: null })
    await executor.terminate()
    await expect(executor.execute(input, 1000)).rejects.toThrow('podman_executor_already_used')
    expect(runIsolatedProcess).toHaveBeenCalledOnce()
  })
  it('never accepts truncated output or a failed container as harness success', async () => {
    for (const changed of [{ outputTruncated: true }, { exitCode: 1 }, { stdout: 'invalid' }]) {
      vi.mocked(runIsolatedProcess).mockResolvedValue(result(changed))
      expect(await createPodmanSandboxExecutor(config).execute(input, 1000)).toMatchObject({ ok: false })
    }
  })
  it('reports observed wall-clock and kernel OOM termination separately', async () => {
    for (const [changed, exceededLimit] of [[{ timedOut: true }, 'wall-clock'], [{ oomKilled: true, exitCode: 137 }, 'memory']] as const) {
      vi.mocked(runIsolatedProcess).mockResolvedValue(result(changed))
      expect(await createPodmanSandboxExecutor(config).execute(input, 1000)).toMatchObject({ ok: false, exceededLimit })
    }
  })
})
