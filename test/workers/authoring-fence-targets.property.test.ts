import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  ThemeDeployment,
  themeActivationMutationIntent,
  type ActivatedTheme,
} from '../../src/core/theme-deployment-store.ts'
import {
  authoringMutationRequestDigest,
  merchantThemeClaim,
  type ClaimMutationPermit,
} from '../../src/domain/authoring-claim-policy.ts'

describe('authoring mutation target fences', () => {
  it('atomically rejects an older theme epoch without replacing current bytes', async () => {
    const stub = env.THEME_DEPLOYMENT.get(env.THEME_DEPLOYMENT.newUniqueId())
    const merchantId = 'merchant-target-fence'
    const now = Date.now()
    const currentRecord = record(merchantId, '2'.repeat(64), now)
    const staleRecord = record(merchantId, '1'.repeat(64), now + 1)
    const evidence = await runInDurableObject(stub, async (instance) => {
      const store = instance as ThemeDeployment
      const current = await store.activate(currentRecord, await permit(currentRecord, 2, 1, now))
      const stale = await store.activate(staleRecord, await permit(staleRecord, 1, 1, now))
      const persisted = await store.current()
      return { current, stale, persisted }
    })
    expect(evidence.current).toMatchObject({ ok: true, idempotent: false })
    expect(evidence.stale).toMatchObject({
      ok: false,
      code: 'fence_stale',
      holdingLeaseEpoch: 2,
      holdingFenceRevision: 'fence-v2',
    })
    expect(evidence.persisted.record).toEqual(currentRecord)
  })

  it('caches the latest exact retry and rejects an A/B/A same-lease replay without replacing B', async () => {
    const stub = env.THEME_DEPLOYMENT.get(env.THEME_DEPLOYMENT.newUniqueId())
    const merchantId = 'merchant-same-lease'
    const now = Date.now()
    const recordA = record(merchantId, 'a'.repeat(64), now)
    const recordB = record(merchantId, 'b'.repeat(64), now + 1)
    const permitA = await permit(recordA, 7, 1, now)
    const permitB = await permit(recordB, 7, 2, now)
    const evidence = await runInDurableObject(stub, async (instance) => {
      const store = instance as ThemeDeployment
      const firstA = await store.activate(recordA, permitA)
      const exactA = await store.activate(recordA, permitA)
      const mismatchedA = await store.activate(recordB, permitA)
      const appliedB = await store.activate(recordB, permitB)
      const replayA = await store.activate(recordA, permitA)
      return { firstA, exactA, mismatchedA, appliedB, replayA, persisted: await store.current() }
    })
    expect(evidence.firstA).toMatchObject({ ok: true, idempotent: false })
    expect(evidence.exactA).toEqual(evidence.firstA)
    expect(evidence.mismatchedA).toMatchObject({ ok: false, code: 'mutation_request_mismatch' })
    expect(evidence.appliedB).toMatchObject({ ok: true, idempotent: false, record: recordB })
    expect(evidence.replayA).toMatchObject({ ok: false, code: 'fence_stale', holdingLeaseEpoch: 7 })
    expect(evidence.persisted.record).toEqual(recordB)
  })
})

async function permit(
  value: ActivatedTheme,
  epoch: number,
  mutationSequence: number,
  now: number,
): Promise<ClaimMutationPermit> {
  const binding = merchantThemeClaim(value.merchantId)
  const requestDigest = await authoringMutationRequestDigest(binding, themeActivationMutationIntent(value))
  return Object.freeze({
    schema: 'agentic-graph-authoring-mutation-permit/v2',
    mutationId: `mutation:${epoch}:${mutationSequence}:${requestDigest.slice(0, 32)}`,
    operationId: `operation:${requestDigest}`,
    requestDigest,
    mutationSequence,
    semanticScope: binding.semanticScope,
    claimId: `claim-v${epoch}`,
    leaseEpoch: epoch,
    leaseExpiresAtMs: now + 60_000,
    fenceRevision: `fence-v${epoch}`,
    requiredWriteTarget: binding.writeTarget,
    reservedAtMs: now,
  })
}

function record(merchantId: string, manifestDigest: string, deployedAtMs: number): ActivatedTheme {
  return Object.freeze({
    merchantId,
    manifestDigest,
    manifest: Object.freeze({
      merchantId,
      catalogScope: Object.freeze([]),
      logo: Object.freeze({ href: null, alt: merchantId }),
      palette: Object.freeze({
        ink: '#000000', muted: '#333333', line: '#666666', panel: '#eeeeee',
        accent: '#0000ff', background: '#ffffff',
      }),
      copy: Object.freeze({ brand: merchantId, headline: 'Headline', subhead: 'Subhead', footer: 'Footer' }),
      locale: 'en-US',
    }),
    resolvedCatalogScope: Object.freeze([]),
    defaultedFields: Object.freeze([]),
    deployedAtMs,
    deployedAt: new Date(deployedAtMs).toISOString(),
  }) as ActivatedTheme
}
