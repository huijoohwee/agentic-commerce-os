import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { authorizeAndAdvance, sealCandidate } from '../../scripts/release-controller.ts'

const DAY_MS = 24 * 60 * 60 * 1_000
const shaArbitrary = fc.array(fc.constantFrom(...'0123456789abcdef'), {
  minLength: 40,
  maxLength: 40,
}).map(characters => characters.join(''))

describe('release authorization adapter', () => {
  it('refuses incomplete and expired authorization records', async () => {
    await fc.assert(fc.asyncProperty(
      shaArbitrary,
      fc.integer({ min: 1, max: 10_000 }),
      async (sha, extraAge) => {
        const nowMs = 100 * DAY_MS
        const verdict = await authorizeAndAdvance({
          candidate: { candidateSha: sha, frontierSha: sha, status: 'sealed', sealedAtMs: nowMs - DAY_MS },
          authorization: {
            candidateSha: sha,
            target: 'delivery-route',
            humanIdentity: 'authenticated-operator',
            authorizedAtMs: nowMs - DAY_MS - extraAge,
            rollbackDisposition: { priorCandidateSha: 'a'.repeat(40), restoreAction: 'restore sealed versions' },
          },
        }, nowMs)
        expect(verdict).toMatchObject({ ok: false, code: 'release_authorization_incomplete' })
      },
    ), { numRuns: 300, seed: 20_260_832 })
  })

  it('always refuses a retired candidate', async () => {
    await fc.assert(fc.asyncProperty(shaArbitrary, async sha => {
      const verdict = await authorizeAndAdvance({
        candidate: { candidateSha: sha, frontierSha: sha, status: 'retired', sealedAtMs: 1 },
        authorization: {
          candidateSha: sha,
          target: 'prod-mirror',
          humanIdentity: 'authenticated-operator',
          authorizedAtMs: 1_000,
          rollbackDisposition: { priorCandidateSha: 'b'.repeat(40), restoreAction: 'restore mirror' },
        },
      }, 1_001)
      expect(verdict).toMatchObject({ ok: false, code: 'release_candidate_retired' })
    }), { numRuns: 300, seed: 20_260_833 })
  })

  it('refuses exactly when rollback disposition is absent', async () => {
    await fc.assert(fc.asyncProperty(shaArbitrary, fc.boolean(), async (sha, includeRollback) => {
      const verdict = await authorizeAndAdvance({
        candidate: { candidateSha: sha, frontierSha: sha, status: 'sealed', sealedAtMs: 1 },
        authorization: {
          candidateSha: sha,
          target: 'delivery-route',
          humanIdentity: 'authenticated-operator',
          authorizedAtMs: 1_000,
          ...(includeRollback
            ? { rollbackDisposition: { priorCandidateSha: 'c'.repeat(40), restoreAction: 'restore versions' } }
            : {}),
        },
      }, 1_001)
      expect(verdict.ok).toBe(includeRollback)
      if (!includeRollback) expect(verdict).toMatchObject({ code: 'release_rollback_disposition_required' })
    }), { numRuns: 300, seed: 20_260_834 })
  })

  it('seals only the exact frontier', () => {
    fc.assert(fc.property(shaArbitrary, shaArbitrary, (candidate, frontier) => {
      expect(sealCandidate(candidate, frontier).ok).toBe(candidate === frontier)
    }), { numRuns: 300, seed: 20_260_835 })
  })
})
