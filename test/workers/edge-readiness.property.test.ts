import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  attachRouteReadinessHeaders,
  observeProductionRouteReadiness,
  ROUTE_LIVE_READINESS_CONTRACT,
  type CoreReadinessFetcher,
  type CoreReadinessProbe,
  type EdgeReleaseIdentity,
} from '../../src/edge/readiness.ts'

const CANDIDATE = 'a'.repeat(40)
const OTHER_CANDIDATE = 'b'.repeat(40)
const EDGE_VERSION = Object.freeze({
  id: 'edge-version-1',
  tag: CANDIDATE,
  timestamp: '2026-08-30T00:00:00.000Z',
})
const CORE_VERSION = Object.freeze({
  id: 'core-version-1',
  tag: CANDIDATE,
  timestamp: '2026-08-30T00:00:00.000Z',
})
const EDGE_IDENTITY: EdgeReleaseIdentity = Object.freeze({
  lane: 'Production',
  releaseCandidateSha: CANDIDATE,
  version: EDGE_VERSION,
  configurationOk: true,
})

describe('Production delivery-route readiness projection', () => {
  it('accepts a source-ready core 503 only when route-live is the sole unknown field', async () => {
    const calls: string[] = []
    const readiness = await observeProductionRouteReadiness(
      exactRequest(),
      EDGE_IDENTITY,
      coreFetcher(coreReadiness(), coreLive(), (path) => calls.push(path)),
    )

    expect(calls.sort()).toEqual(['/internal/livez', '/internal/readyz'])
    expect(readiness).toEqual({
      ok: true,
      contract: ROUTE_LIVE_READINESS_CONTRACT,
      reason: null,
      servingCandidateSha: CANDIDATE,
      edgeVersion: EDGE_VERSION,
      coreVersion: CORE_VERSION,
    })
    const response = attachRouteReadinessHeaders(new Response('closed'), readiness)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-commerce-live-readiness')).toBe('ready')
    expect(response.headers.get('x-commerce-release-candidate')).toBe(CANDIDATE)
    expect(response.headers.get('x-commerce-edge-version-id')).toBe(EDGE_VERSION.id)
    expect(response.headers.get('x-commerce-core-version-id')).toBe(CORE_VERSION.id)
  })

  it('rejects every non-exact host, path, protocol, query, or method before probing core', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(
      new Request('https://edge.test/agentic-commerce-os'),
      new Request('https://airvio.co/agentic-commerce-os/'),
      new Request('http://airvio.co/agentic-commerce-os'),
      new Request('https://airvio.co/agentic-commerce-os?probe=1'),
      new Request('https://airvio.co/agentic-commerce-os', { method: 'POST' }),
    ), async (request) => {
      let calls = 0
      const readiness = await observeProductionRouteReadiness(request, EDGE_IDENTITY, async () => {
        calls += 1
        throw new Error('unexpected_core_probe')
      })

      expect(calls).toBe(0)
      expect(readiness).toMatchObject({ ok: false, reason: 'delivery_route_request_mismatch' })
    }), { numRuns: 100, seed: 20_260_830 })
  })

  it('does not turn an exact route observation into readiness when core source checks fail', async () => {
    const readiness = await observeProductionRouteReadiness(
      exactRequest(),
      EDGE_IDENTITY,
      coreFetcher(coreReadiness({ sourceOk: false }), coreLive()),
    )

    expect(readiness).toMatchObject({ ok: false, reason: 'core_source_not_ready' })
  })

  it('rejects candidate and version mismatches on either Worker', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(
      'edge-tag',
      'core-ready-candidate',
      'core-live-candidate',
      'core-ready-tag',
      'core-version-identity',
    ), async (mismatch) => {
      const edge = mismatch === 'edge-tag'
        ? Object.freeze({ ...EDGE_IDENTITY, version: { ...EDGE_VERSION, tag: OTHER_CANDIDATE } })
        : EDGE_IDENTITY
      const ready = coreReadiness({
        candidate: mismatch === 'core-ready-candidate' ? OTHER_CANDIDATE : CANDIDATE,
        version: mismatch === 'core-ready-tag' ? { ...CORE_VERSION, tag: OTHER_CANDIDATE } : CORE_VERSION,
      })
      const live = coreLive({
        candidate: mismatch === 'core-live-candidate' ? OTHER_CANDIDATE : CANDIDATE,
        version: mismatch === 'core-version-identity' ? { ...CORE_VERSION, id: 'core-version-2' } : CORE_VERSION,
      })

      const readiness = await observeProductionRouteReadiness(exactRequest(), edge, coreFetcher(ready, live))

      expect(readiness.ok).toBe(false)
      expect(readiness.reason).toMatch(/^(?:edge|core)_release_metadata_mismatch$/u)
    }), { numRuns: 100, seed: 20_260_831 })
  })

  it('keeps Dev route-live unauthorized and performs zero core probes', async () => {
    let calls = 0
    const readiness = await observeProductionRouteReadiness(
      exactRequest(),
      Object.freeze({ ...EDGE_IDENTITY, lane: 'Dev' }),
      async () => {
        calls += 1
        throw new Error('unexpected_core_probe')
      },
    )

    expect(calls).toBe(0)
    expect(readiness).toMatchObject({ ok: false, reason: 'delivery_route_unauthorized_in_dev' })
  })
})

function exactRequest(): Request {
  return new Request('https://airvio.co/agentic-commerce-os')
}

function coreReadiness(options: Readonly<{
  sourceOk?: boolean
  candidate?: string
  version?: WorkerVersionMetadata
}> = {}): CoreReadinessProbe {
  const sourceOk = options.sourceOk ?? true
  return Object.freeze({
    status: 503,
    payload: Object.freeze({
      ok: false,
      contract: 'commerce.core-readiness/v2',
      lane: 'Production',
      releaseCandidateSha: options.candidate ?? CANDIDATE,
      version: options.version ?? CORE_VERSION,
      sourceReadiness: Object.freeze({ ok: sourceOk, checks: Object.freeze([]) }),
      liveReleaseReadiness: Object.freeze({
        ok: false,
        reason: 'delivery_route_live_unknown',
        servingCandidateSha: null,
      }),
      convergence: Object.freeze([]),
    }),
  })
}

function coreLive(options: Readonly<{
  candidate?: string
  version?: WorkerVersionMetadata
}> = {}): CoreReadinessProbe {
  return Object.freeze({
    status: 200,
    payload: Object.freeze({
      ok: true,
      contract: 'commerce.core-live/v1',
      lane: 'Production',
      releaseCandidateSha: options.candidate ?? CANDIDATE,
      version: options.version ?? CORE_VERSION,
    }),
  })
}

function coreFetcher(
  ready: CoreReadinessProbe,
  live: CoreReadinessProbe,
  onCall: (path: string) => void = () => {},
): CoreReadinessFetcher {
  return async (path) => {
    onCall(path)
    return path === '/internal/readyz' ? ready : live
  }
}
