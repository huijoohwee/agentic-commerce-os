import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { parseSandboxRequest, runIsolated, type IsolatedExecutor } from '../../src/sandbox/isolation'
import {
  SANDBOX_HARNESS_SOURCE,
  THEME_BUILD_ARTIFACT_CONTRACT,
  readHarnessOutput,
  type ThemeBuildResult,
} from '../../src/sandbox/theme-build'
import { validateThemeManifest } from '../../src/shared/theme-manifest'

describe('standalone isolated theme build', () => {
  it('resolves, validates, and materializes a canonical theme artifact in the harness', async () => {
    const manifest = Object.freeze({ merchantId: 'merchant-1', catalogScope: Object.freeze(['agent-1']) })
    const execution = executeThemeHarness(manifest)
    const observed = readHarnessOutput(execution.stdout)
    expect(execution.status).toBe(0)
    expect(observed).toMatchObject({
      ok: true,
      attemptedCalls: [],
      buildResult: {
        status: 'completed',
        resolvedCatalogScope: ['agent-1'],
        manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    })
    const verdict = await validateThemeManifest(manifest)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok || observed?.buildResult?.status !== 'completed') {
      throw new Error('theme_build_fixture_invalid')
    }
    expect(observed.buildResult.manifestDigest).toBe(verdict.digest)
    const artifact: unknown = JSON.parse(execution.artifact)
    expect(artifact).toMatchObject({
      contract: THEME_BUILD_ARTIFACT_CONTRACT,
      manifest: { merchantId: 'merchant-1', catalogScope: ['agent-1'] },
    })

    const result = await runIsolated(themeRequest(manifest), {
      executor: executorFixture(observed.buildResult),
      now: monotonicClock(),
    })
    expect(result).toMatchObject({
      ok: true,
      buildResult: { status: 'completed', manifestDigest: verdict.digest },
      record: {
        instanceId: 'theme-build-proof',
        purpose: 'theme-build',
        outcome: 'completed',
        exceededLimit: null,
        configuredValue: null,
        attemptedCalls: [],
      },
    })
  })

  it('returns a typed failed build and lifecycle record for an invalid manifest', async () => {
    const manifest = {
      merchantId: 'merchant-1',
      catalogScope: ['agent-1'],
      copy: { headline: 'x'.repeat(281) },
    }
    const execution = executeThemeHarness(manifest)
    const observed = readHarnessOutput(execution.stdout)
    expect(execution.status).toBe(0)
    expect(execution.artifact).toBe('')
    expect(observed).toMatchObject({
      ok: false,
      attemptedCalls: [],
      buildResult: {
        status: 'failed',
        code: 'theme_manifest_invalid',
        violations: [{ field: 'copy.headline' }],
      },
    })
    if (observed?.buildResult?.status !== 'failed') throw new Error('failed_build_evidence_missing')
    const result = await runIsolated(themeRequest(manifest), {
      executor: executorFixture(observed.buildResult),
      now: monotonicClock(),
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'sandbox_build_failed',
      buildResult: { status: 'failed', code: 'theme_manifest_invalid' },
      record: { purpose: 'theme-build', outcome: 'failed', attemptedCalls: [] },
    })
  })

  it('rejects caller-granted tools and malformed theme envelopes before provisioning', () => {
    expect(parseSandboxRequest({
      ...themeRequest({ merchantId: 'merchant-1', catalogScope: ['agent-1'] }),
      declaredAllowlist: [],
    })).toBeNull()
    expect(parseSandboxRequest({
      ...themeRequest({ merchantId: 'merchant-1', catalogScope: ['agent-1'] }),
      payload: { manifest: {}, extra: true },
    })).toBeNull()
  })

})

function executeThemeHarness(manifest: unknown): Readonly<{
  status: number | null
  stdout: string
  artifact: string
}> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'agentic-theme-build-'))
  const artifactPath = join(temporaryDirectory, 'artifact.json')
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', SANDBOX_HARNESS_SOURCE], {
      encoding: 'utf8',
      env: { ...process.env, AG_SANDBOX_ARTIFACT_PATH: artifactPath },
      input: JSON.stringify({ purpose: 'theme-build', payload: { manifest }, declaredAllowlist: [] }),
      maxBuffer: 1_000_000,
    })
    return Object.freeze({
      status: child.status,
      stdout: child.stdout,
      artifact: child.status === 0 && child.stdout.includes('"status":"completed"')
        ? readFileSync(artifactPath, 'utf8')
        : '',
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function themeRequest(manifest: unknown) {
  return Object.freeze({
    instanceId: 'theme-build-proof',
    purpose: 'theme-build' as const,
    limits: Object.freeze({ wallClockSeconds: 30, memoryMegabytes: 256 }),
    payload: Object.freeze({ manifest }),
  })
}

function executorFixture(buildResult: ThemeBuildResult): IsolatedExecutor & {
  terminate: ReturnType<typeof vi.fn>
} {
  return Object.freeze({
    async execute() {
      return Object.freeze({
        ok: buildResult.status === 'completed',
        exceededLimit: null,
        attemptedCalls: Object.freeze([]),
        buildResult,
      })
    },
    terminate: vi.fn(async () => undefined),
  })
}

function monotonicClock(): () => number {
  let current = Date.UTC(2026, 7, 30)
  return () => current++
}
