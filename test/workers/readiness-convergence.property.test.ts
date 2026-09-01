import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { readiness } from '../../src/core/core-readiness.ts'
import { devProviderFetch } from '../../src/dev/provider.ts'

describe('core readiness convergence composition', () => {
  it('emits one explicit source/live verdict row per provider when probes time out or fail', async () => {
    const report = await readiness({
      ...env,
      DOCS_MCP: failingEvidenceBinding('timeout'),
      CHECKOUT_PROVIDER: failingEvidenceBinding('timeout'),
      MARKETPLACE_PROVIDER: failingEvidenceBinding('http'),
    } as CoreEnv)

    expect(report.convergence).toHaveLength(3)
    expect(report.convergence.map(({ provider }) => provider)).toEqual([
      'discovery-provider.internal',
      'checkout-provider.internal',
      'marketplace-provider.internal',
    ])
    for (const convergence of report.convergence) {
      expect(Object.keys(convergence).sort()).toEqual(['live', 'provider', 'source'])
      expect(convergence.source).toMatchObject({
        provider: convergence.provider,
        state: 'blocked',
        reason: 'provider_evidence_unavailable',
        advertisedContractRevision: null,
      })
      expect(convergence.source.requiredAbsentOrFailing.length).toBeGreaterThan(0)
      expect(convergence.live).toMatchObject({
        provider: convergence.provider,
        state: 'blocked',
        reason: 'delivery_route_live_unknown',
      })
    }
    expect(report.sourceReadiness.ok).toBe(false)
    expect(report.liveReleaseReadiness).toMatchObject({
      ok: false,
      reason: 'delivery_route_live_unknown',
      servingCandidateSha: null,
    })
  })

  it('keeps successful source verdicts distinct from absent live-release verdicts', async () => {
    const report = await readiness(env)

    expect(report.convergence).toHaveLength(3)
    expect(report.convergence.every(({ source }) => source.state === 'converged')).toBe(true)
    expect(report.convergence.every(({ live }) => live.state === 'blocked')).toBe(true)
    expect(report.liveReleaseReadiness.ok).toBe(false)
  })
})

function failingEvidenceBinding(mode: 'timeout' | 'http'): Fetcher {
  return Object.freeze({
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== '/v1/runtime-evidence') return devProviderFetch(request)
      if (mode === 'timeout') throw new DOMException('simulated provider timeout', 'TimeoutError')
      return Response.json({ ok: false, code: 'provider_unavailable' }, { status: 503 })
    },
  }) as unknown as Fetcher
}
