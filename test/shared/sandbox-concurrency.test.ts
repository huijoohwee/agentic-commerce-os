import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { IsolatedExecutor, SandboxRequest } from '../../src/sandbox/isolation'
import { EXECUTABLE_TARGET_CONTRACT } from '../../src/sandbox/registration-target'
import { runServerIsolated } from '../../src/sandbox/server-run'

const TARGET_SOURCE = 'export async function executeTool(toolId, input) { return { input, toolId } }'
const EXECUTABLE_TARGET = Object.freeze({
  contract: EXECUTABLE_TARGET_CONTRACT,
  kind: 'javascript-module',
  source: TARGET_SOURCE,
  sourceDigest: createHash('sha256').update(TARGET_SOURCE, 'utf8').digest('hex'),
})

describe('sandbox server execution identity', () => {
  it('isolates concurrent runs that reuse a caller instance identifier', async () => {
    const runtimeIds: string[] = []
    const executors: DeferredExecutor[] = []
    let sequence = 0
    const run = () => runServerIsolated(
      request('shared-caller-id'),
      (runtimeId) => {
        runtimeIds.push(runtimeId)
        const executor = deferredExecutor()
        executors.push(executor)
        return executor
      },
      () => `run-concurrency-${sequence += 1}`,
    )
    const first = run()
    const second = run()
    await vi.waitFor(() => expect(executors).toHaveLength(2))
    await vi.waitFor(() => expect(executors.every(({ execute }) => execute.mock.calls.length === 1)).toBe(true))
    expect(runtimeIds).toEqual(['run-concurrency-1', 'run-concurrency-2'])

    executors[0]?.complete()
    await expect(first).resolves.toMatchObject({
      ok: true,
      record: { instanceId: 'run-concurrency-1' },
    })
    expect(executors[0]?.terminate).toHaveBeenCalledOnce()
    expect(executors[1]?.terminate).not.toHaveBeenCalled()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    executors[1]?.complete()
    await expect(second).resolves.toMatchObject({
      ok: true,
      record: { instanceId: 'run-concurrency-2' },
    })
    expect(executors[1]?.terminate).toHaveBeenCalledOnce()
  })
})

type DeferredExecutor = IsolatedExecutor & {
  complete: () => void
  execute: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
}

function deferredExecutor(): DeferredExecutor {
  let resolveExecution: ((value: Awaited<ReturnType<IsolatedExecutor['execute']>>) => void) | undefined
  const execute = vi.fn(async (
    _input: Parameters<IsolatedExecutor['execute']>[0],
    _timeoutMs: number,
  ): Promise<Awaited<ReturnType<IsolatedExecutor['execute']>>> => await new Promise((resolve) => {
    resolveExecution = resolve
  }))
  return {
    execute,
    terminate: vi.fn(async () => undefined),
    complete() {
      resolveExecution?.({
        ok: true,
        exceededLimit: null,
        attemptedCalls: [{
          toolId: 'commerce.catalog.search',
          allowlisted: true,
          outcome: 'executed',
        }],
      })
    },
  }
}

function request(instanceId: string): SandboxRequest {
  return Object.freeze({
    instanceId,
    purpose: 'registration-dry-run',
    limits: Object.freeze({ wallClockSeconds: 30, memoryMegabytes: 256 }),
    payload: Object.freeze({
      registration: Object.freeze({
        tools: Object.freeze([{ name: 'commerce.catalog.search', loading: 'direct' }]),
      }),
      toolCalls: Object.freeze([{ toolId: 'commerce.catalog.search', input: Object.freeze({}) }]),
      executableTarget: EXECUTABLE_TARGET,
    }),
    declaredAllowlist: Object.freeze(['commerce.catalog.search']),
  })
}
