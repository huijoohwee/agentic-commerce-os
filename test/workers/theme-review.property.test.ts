import { env, runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { ThemeDeployment, themeActivationMutationIntent, type ActivatedTheme } from '../../src/core/theme-deployment-store'
import { authoringMutationRequestDigest, merchantThemeClaim, type ClaimMutationPermit } from '../../src/domain/authoring-claim-policy'
import { THEME_MANIFEST_DEFAULTS } from '../../src/shared/theme-manifest'

it('binds the reviewed version to the permit and atomically refuses stale concurrent proposals', async () => {
  const stub = env.THEME_DEPLOYMENT.get(env.THEME_DEPLOYMENT.newUniqueId())
  const evidence = await runInDurableObject(stub, async instance => {
    const store = instance as ThemeDeployment
    const now = Date.now(), merchantId = 'reviewed-store'
    const record = (letter: string): ActivatedTheme => ({
      merchantId, manifestDigest: letter.repeat(64), manifest: { ...THEME_MANIFEST_DEFAULTS, merchantId },
      resolvedCatalogScope: [], defaultedFields: [], deployedAtMs: now, deployedAt: new Date(now).toISOString(),
    })
    const a = record('a'), b = record('b'), c = record('c')
    const permit = async (value: ActivatedTheme, expected: string | null, sequence: number): Promise<ClaimMutationPermit> => {
      const binding = merchantThemeClaim(merchantId)
      const requestDigest = await authoringMutationRequestDigest(binding, themeActivationMutationIntent(value, expected))
      return { schema: 'agentic-graph-authoring-mutation-permit/v2',
        mutationId: `mutation:1:${sequence}:${requestDigest.slice(0, 32)}`, operationId: `operation:${requestDigest}`,
        requestDigest, mutationSequence: sequence, semanticScope: binding.semanticScope, claimId: 'claim-review',
        leaseEpoch: 1, leaseExpiresAtMs: now + 60000, fenceRevision: 'review-1', requiredWriteTarget: binding.writeTarget, reservedAtMs: now }
    }
    const create = await store.activate(a, await permit(a, null, 1), null)
    const boundPermit = await permit(b, a.manifestDigest, 2)
    const tampered = await store.activate(b, boundPermit, null)
    const update = await store.activate(b, boundPermit, a.manifestDigest)
    const stale = await store.activate(c, await permit(c, a.manifestDigest, 3), a.manifestDigest)
    const repeat = await store.activate(b, await permit(b, a.manifestDigest, 4), a.manifestDigest)
    return { create, tampered, update, stale, repeat, current: await store.current() }
  })
  expect(evidence.create).toMatchObject({ ok: true, idempotent: false })
  expect(evidence.tampered).toMatchObject({ ok: false, code: 'mutation_request_mismatch' })
  expect(evidence.update).toMatchObject({ ok: true, idempotent: false })
  expect(evidence.stale).toMatchObject({ ok: false, code: 'theme_review_stale' })
  expect(evidence.repeat).toMatchObject({ ok: true, idempotent: true })
  expect(evidence.current.record?.manifestDigest).toBe('b'.repeat(64))
})
