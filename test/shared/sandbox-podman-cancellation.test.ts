import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { createPodmanSandboxExecutor } from '../../scripts/sandbox-podman-executor.ts'

test('cancellation during digest validation remains cancellation and never provisions a container', async () => {
  const executor = createPodmanSandboxExecutor({ podmanExecutable: '/must-not-be-called', imageId: 'a'.repeat(64) })
  await executor.terminate()
  await assert.rejects(executor.execute({ purpose: 'registration-dry-run', payload: {}, declaredAllowlist: [] }, 1000),
    /^Error: isolated_process_aborted$/u)
  await executor.terminate()
})
