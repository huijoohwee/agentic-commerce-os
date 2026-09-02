import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import {
  SANDBOX_CONTAINER_MEMORY_MEGABYTES,
  parseSandboxRequest,
  runIsolated,
  type IsolatedExecutor,
} from '../../src/sandbox/isolation'
import { previewIdentity, resolvePreview } from '../../src/sandbox/preview'
import { EXECUTABLE_TARGET_CONTRACT } from '../../src/sandbox/registration-target'

const TARGET_SOURCE = 'export async function executeTool(toolId, input) { return { input, toolId } }'
const EXECUTABLE_TARGET = Object.freeze({
  contract: EXECUTABLE_TARGET_CONTRACT,
  kind: 'javascript-module' as const,
  source: TARGET_SOURCE,
  sourceDigest: createHash('sha256').update(TARGET_SOURCE, 'utf8').digest('hex'),
})

describe('sandbox isolation contracts', () => {
  // Feature: agentic-graph-commerce-platform, Property 22: Isolation and allowlist enforcement
  it('refuses every observed call outside the declaration and always terminates', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9._-]{0,30}$/u), { minLength: 2, maxLength: 20 }),
      async (toolIds) => {
        const refusedTool = toolIds.at(-1) ?? 'outside'
        const declaredAllowlist = toolIds.slice(0, -1)
        const attemptedCalls = toolIds.map((toolId) => Object.freeze({
          toolId,
          allowlisted: declaredAllowlist.includes(toolId),
          outcome: toolId === refusedTool ? 'refused' as const : 'executed' as const,
        }))
        const executor = executorFixture({ ok: false, exceededLimit: null, attemptedCalls })
        const result = await runIsolated({
          instanceId: 'allowlist-property',
          purpose: 'registration-dry-run',
          limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
          payload: {
            registration: { tools: toolIds.map((name) => ({ name, loading: 'direct' })) },
            toolCalls: toolIds.map((toolId) => ({ toolId, input: {} })),
            executableTarget: EXECUTABLE_TARGET,
          },
          declaredAllowlist,
        }, { executor })

        expect(result).toMatchObject({
          ok: false,
          code: 'sandbox_call_not_allowlisted',
          toolId: refusedTool,
          record: { outcome: 'refused', attemptedCalls },
        })
        expect(executor.terminate).toHaveBeenCalledOnce()
      },
    ), { numRuns: 400, seed: 20_260_922 })
  })

  // Feature: agentic-graph-commerce-platform, Property 23: Resource-limit termination
  it('records the configured exceeded limit and terminates for every bounded request', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('wall-clock' as const, 'memory' as const),
      fc.integer({ min: 1, max: 300 }),
      async (exceededLimit, wallClockSeconds) => {
        const executor = executorFixture({ ok: false, exceededLimit, attemptedCalls: Object.freeze([]) })
        const result = await runIsolated({
          instanceId: 'limits-property',
          purpose: 'theme-build',
          limits: { wallClockSeconds, memoryMegabytes: SANDBOX_CONTAINER_MEMORY_MEGABYTES },
          payload: { manifest: 'bounded' },
        }, { executor, now: monotonicClock() })

        expect(result).toMatchObject({
          ok: false,
          code: 'sandbox_blocked',
          record: {
            outcome: 'limit-exceeded',
            exceededLimit,
            configuredValue: exceededLimit === 'wall-clock'
              ? wallClockSeconds
              : SANDBOX_CONTAINER_MEMORY_MEGABYTES,
          },
        })
        expect(executor.terminate).toHaveBeenCalledOnce()
      },
    ), { numRuns: 200, seed: 20_260_923 })
  })

  it('refuses out-of-allowlist calls observed by the isolated executor', async () => {
    const executor = executorFixture({
      ok: false,
      exceededLimit: null,
      attemptedCalls: [
        { toolId: 'commerce.catalog.search', allowlisted: true, outcome: 'executed' },
        { toolId: 'commerce.checkout.confirm', allowlisted: false, outcome: 'refused' },
      ],
    })
    const result = await runIsolated({
      instanceId: 'dry-run-1',
      purpose: 'registration-dry-run',
      limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
      payload: {
        registration: {
          tools: [
            { name: 'commerce.catalog.search', loading: 'direct' },
            { name: 'commerce.checkout.confirm', loading: 'direct' },
          ],
        },
        toolCalls: [
          { toolId: 'commerce.catalog.search', input: {} },
          { toolId: 'commerce.checkout.confirm', input: {} },
        ],
        executableTarget: EXECUTABLE_TARGET,
      },
      declaredAllowlist: ['commerce.catalog.search'],
    }, { executor })
    expect(result).toMatchObject({
      ok: false,
      code: 'sandbox_call_not_allowlisted',
      toolId: 'commerce.checkout.confirm',
      record: { outcome: 'refused' },
    })
    expect(executor.execute).toHaveBeenCalledOnce()
    expect(executor.terminate).toHaveBeenCalledOnce()
  })

  it('rejects caller-asserted outcomes from the request schema', () => {
    expect(parseSandboxRequest({
      instanceId: 'dry-run-2',
      purpose: 'registration-dry-run',
      limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
      payload: { registration: { tools: [] }, toolCalls: [], executableTarget: EXECUTABLE_TARGET },
      declaredAllowlist: [],
      attemptedToolIds: ['commerce.catalog.search'],
    })).toBeNull()
  })

  it('blocks before provisioning when no executable target is supplied', async () => {
    const executor = executorFixture()
    const request = parseSandboxRequest({
      instanceId: 'dry-run-without-target',
      purpose: 'registration-dry-run',
      limits: { wallClockSeconds: 30, memoryMegabytes: 256 },
      payload: {
        registration: { tools: [{ name: 'commerce.catalog.search', loading: 'direct' }] },
        toolCalls: [{ toolId: 'commerce.catalog.search', input: {} }],
      },
      declaredAllowlist: ['commerce.catalog.search'],
    })
    expect(request).not.toBeNull()
    if (!request) throw new Error('dry_run_fixture_invalid')
    await expect(runIsolated(request, { executor, now: monotonicClock() })).resolves.toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'sandbox_executable_target_required',
      record: { outcome: 'failed', attemptedCalls: [] },
    })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(executor.terminate).not.toHaveBeenCalled()
  })

  it('reports provisioning-disabled execution as dev-proven and leaves no limit claim', async () => {
    const result = await runIsolated({
      instanceId: 'theme-build-provisioning-disabled',
      purpose: 'theme-build',
      limits: { wallClockSeconds: 30, memoryMegabytes: SANDBOX_CONTAINER_MEMORY_MEGABYTES },
      payload: { manifest: { merchantId: 'merchant-1', catalogScope: ['agent-1'] } },
    }, { now: monotonicClock() })

    expect(result).toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'sandbox_executor_unavailable',
      rung: 'dev-proven',
      record: {
        outcome: 'failed',
        exceededLimit: null,
        configuredValue: null,
        attemptedCalls: [],
      },
    })
  })

  it('records an executor failure as failed rather than limit-exceeded', async () => {
    const executor: IsolatedExecutor & { terminate: ReturnType<typeof vi.fn> } = {
      execute: vi.fn(async () => { throw new Error('container_transport_unavailable') }),
      terminate: vi.fn(async () => undefined),
    }
    const result = await runIsolated({
      instanceId: 'theme-build-execution-failure',
      purpose: 'theme-build',
      limits: { wallClockSeconds: 30, memoryMegabytes: SANDBOX_CONTAINER_MEMORY_MEGABYTES },
      payload: { manifest: { merchantId: 'merchant-1', catalogScope: ['agent-1'] } },
    }, { executor, now: monotonicClock() })

    expect(result).toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'Error',
      rung: 'dev-proven',
      record: {
        outcome: 'failed',
        exceededLimit: null,
        configuredValue: null,
        attemptedCalls: [],
      },
    })
    expect(executor.terminate).toHaveBeenCalledOnce()
  })

  it('records limits and terminates an exceeded instance', async () => {
    const executor = executorFixture({ ok: false, exceededLimit: 'wall-clock', attemptedCalls: Object.freeze([]) })
    const result = await runIsolated({
      instanceId: 'theme-build-1',
      purpose: 'theme-build',
      limits: { wallClockSeconds: 30, memoryMegabytes: SANDBOX_CONTAINER_MEMORY_MEGABYTES },
      payload: { manifest: 'bounded' },
    }, { executor, now: monotonicClock() })
    expect(result).toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      rung: 'dev-proven',
      record: { outcome: 'limit-exceeded', exceededLimit: 'wall-clock', configuredValue: 30 },
    })
    expect(executor.terminate).toHaveBeenCalledOnce()
  })

  it('rejects a caller memory ceiling that the configured container cannot enforce', () => {
    for (const memoryMegabytes of [128, 512]) {
      expect(parseSandboxRequest({
        instanceId: `memory-${memoryMegabytes}`,
        purpose: 'theme-build',
        limits: { wallClockSeconds: 30, memoryMegabytes },
        payload: { manifest: 'bounded' },
      })).toBeNull()
    }
  })

  it('revokes an engagement preview at its bounded lifetime', async () => {
    const now = Date.UTC(2026, 7, 29)
    const identity = await previewIdentity('merchant-engagement', 1, now)
    expect(resolvePreview(identity, now + 3_599_999)).toMatchObject({ ok: true })
    expect(resolvePreview(identity, now + 3_600_000)).toMatchObject({
      ok: false, code: 'preview_revoked', previewId: identity.previewId,
    })
  })
})

function executorFixture(
  result: Awaited<ReturnType<IsolatedExecutor['execute']>> = {
    ok: true, exceededLimit: null, attemptedCalls: Object.freeze([]),
  },
): IsolatedExecutor & { execute: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => result),
    terminate: vi.fn(async () => undefined),
  }
}

function monotonicClock(): () => number {
  let current = Date.UTC(2026, 7, 29)
  return () => current++
}
