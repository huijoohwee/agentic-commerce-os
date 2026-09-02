import { env, runInDurableObject } from 'cloudflare:test'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AuthoringClaim } from '../../src/core/authoring-claim.ts'
import type { Claim } from '../../src/domain/authoring-claim-policy.ts'

const ACQUISITION_NOW_MS = 1_000_000
const MUTATION_NOW_MS = 2_000_000

const claimPairArbitrary = fc.record({
  heldWriteSet: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u), {
    minLength: 1,
    maxLength: 8,
  }),
  incomingOnly: fc.uniqueArray(fc.stringMatching(/^incoming-[a-z][a-z0-9-]{0,20}$/u), {
    minLength: 1,
    maxLength: 8,
  }),
  sameScope: fc.boolean(),
  overlaps: fc.boolean(),
  expiryOffsetMs: fc.integer({ min: -1, max: 1 }),
})

describe('AuthoringClaim Durable Object property evidence', () => {
  it('Feature: agentic-graph-commerce-platform, Property 19: CP-19 — Claim admission and byte preservation', { timeout: 30_000 }, async () => {
    await fc.assert(fc.asyncProperty(claimPairArbitrary, async (generated) => {
      const held = claim({
        claimId: 'held-claim',
        semanticScope: 'held-scope',
        declaredWriteSet: generated.heldWriteSet,
        leaseEpoch: 1,
        leaseExpiresAtMs: MUTATION_NOW_MS + generated.expiryOffsetMs,
        fenceRevision: 'held-fence-v1',
      })
      const incomingWriteSet = generated.overlaps
        ? Object.freeze([
            generated.heldWriteSet[0] ?? 'shared',
            ...generated.incomingOnly.map((entry) => `incoming-only-write-${entry}`),
          ])
        : Object.freeze(generated.incomingOnly.map((entry) => `incoming-only-write-${entry}`))
      const incoming = claim({
        claimId: 'incoming-claim',
        semanticScope: generated.sameScope ? held.semanticScope : 'incoming-scope',
        declaredWriteSet: incomingWriteSet,
        leaseEpoch: 2,
        leaseExpiresAtMs: MUTATION_NOW_MS + 10_000,
        fenceRevision: 'incoming-fence-v2',
      })
      const authoredBytes = JSON.stringify({ held, incoming })
      const stub = env.AUTHORING_CLAIM.get(env.AUTHORING_CLAIM.newUniqueId())

      const evidence = await runInDurableObject(stub, async (instance, state) => {
        const claims = instance as AuthoringClaim
        const acquired = await claims.acquire(held, ACQUISITION_NOW_MS)
        const beforeFenceRefusal = storedClaimBytes(state)
        const wrongFence = await claims.admitMutation(
          {
            semanticScope: held.semanticScope,
            claimId: held.claimId,
            leaseEpoch: held.leaseEpoch,
            fenceRevision: 'drifted-fence',
            requiredWriteTarget: held.declaredWriteSet[0] ?? 'missing',
          },
          ACQUISITION_NOW_MS + 1,
        )
        const afterFenceRefusal = storedClaimBytes(state)
        const admitted = await claims.admitMutation(
          {
            semanticScope: held.semanticScope,
            claimId: held.claimId,
            leaseEpoch: held.leaseEpoch,
            fenceRevision: held.fenceRevision,
            requiredWriteTarget: held.declaredWriteSet[0] ?? 'missing',
          },
          ACQUISITION_NOW_MS + 1,
        )
        const beforeOutsideWriteSetRefusal = storedClaimBytes(state)
        const outsideWriteSet = await claims.admitMutation(
          {
            semanticScope: held.semanticScope,
            claimId: held.claimId,
            leaseEpoch: held.leaseEpoch,
            fenceRevision: held.fenceRevision,
            requiredWriteTarget: 'outside-declared-write-set',
          },
          ACQUISITION_NOW_MS + 1,
        )
        const afterOutsideWriteSetRefusal = storedClaimBytes(state)
        const beforeIncoming = storedClaimBytes(state)
        const incomingResult = await claims.acquire(incoming, MUTATION_NOW_MS)
        const afterIncoming = storedClaimBytes(state)
        return Object.freeze({
          acquired,
          wrongFence,
          admitted,
          outsideWriteSet,
          beforeFenceRefusal,
          afterFenceRefusal,
          beforeOutsideWriteSetRefusal,
          afterOutsideWriteSetRefusal,
          incomingResult,
          beforeIncoming,
          afterIncoming,
        })
      })

      expect(evidence.acquired).toMatchObject({ ok: true, claimId: held.claimId })
      expect(evidence.wrongFence).toMatchObject({
        ok: false,
        code: 'fence_stale',
        holdingClaimId: held.claimId,
        holdingLeaseEpoch: held.leaseEpoch,
        holdingFenceRevision: held.fenceRevision,
      })
      expect(evidence.beforeFenceRefusal).toBe(evidence.afterFenceRefusal)
      expect(evidence.admitted).toMatchObject({ ok: true, claimId: held.claimId })
      expect(evidence.outsideWriteSet).toMatchObject({
        ok: false,
        code: 'mutation_out_of_write_set',
        holdingClaimId: held.claimId,
      })
      expect(evidence.beforeOutsideWriteSetRefusal).toBe(evidence.afterOutsideWriteSetRefusal)

      const holderIsLive = held.leaseExpiresAtMs > MUTATION_NOW_MS
      const shouldRefuse = holderIsLive && (generated.sameScope || generated.overlaps)
      if (shouldRefuse) {
        expect(evidence.incomingResult).toMatchObject({
          ok: false,
          code: generated.sameScope ? 'scope_held' : 'write_set_overlap',
          holdingClaimId: held.claimId,
          holdingLeaseEpoch: held.leaseEpoch,
          holdingFenceRevision: held.fenceRevision,
        })
        expect(evidence.afterIncoming).toBe(evidence.beforeIncoming)
      } else {
        expect(evidence.incomingResult).toMatchObject({ ok: true, claimId: incoming.claimId })
        expect(evidence.afterIncoming).not.toBe(evidence.beforeIncoming)
      }
      expect(JSON.stringify({ held, incoming })).toBe(authoredBytes)
    }), { numRuns: 300, seed: 19_019 })
  })

  it('rejects an old epoch after same-identity reacquisition without changing stored bytes', async () => {
    const stub = env.AUTHORING_CLAIM.get(env.AUTHORING_CLAIM.newUniqueId())
    const oldClaim = claim({
      claimId: 'aba-claim', semanticScope: 'aba-scope', declaredWriteSet: ['scripts/exact.ts'],
      leaseEpoch: 1, leaseExpiresAtMs: 2_000, fenceRevision: 'same-fence',
    })
    const currentClaim = Object.freeze({ ...oldClaim, leaseEpoch: 2, leaseExpiresAtMs: 4_000 })
    const evidence = await runInDurableObject(stub, async (instance, state) => {
      const claims = instance as AuthoringClaim
      const acquiredOld = await claims.acquire(oldClaim, 1_000)
      const acquiredCurrent = await claims.acquire(currentClaim, 2_000)
      const before = storedClaimBytes(state)
      const staleAdmission = await claims.admitMutation({
        semanticScope: oldClaim.semanticScope,
        claimId: oldClaim.claimId,
        leaseEpoch: oldClaim.leaseEpoch,
        fenceRevision: oldClaim.fenceRevision,
        requiredWriteTarget: oldClaim.declaredWriteSet[0] ?? '',
      }, 2_001)
      return { acquiredOld, acquiredCurrent, before, after: storedClaimBytes(state), staleAdmission }
    })
    expect(evidence.acquiredOld).toMatchObject({ ok: true, leaseEpoch: 1 })
    expect(evidence.acquiredCurrent).toMatchObject({ ok: true, leaseEpoch: 2 })
    expect(evidence.staleAdmission).toMatchObject({
      ok: false, code: 'fence_stale', holdingClaimId: 'aba-claim', holdingLeaseEpoch: 2,
    })
    expect(evidence.after).toBe(evidence.before)
  })

  it('rechecks after delayed preparation and invokes no stale mutation target', { timeout: 60_000 }, async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(
        { scope: 'operator-registry', target: 'registry' },
        { scope: 'merchant-theme:merchant-race', target: 'merchant-theme:merchant-race' },
        { scope: 'vendor:vendor-race', target: 'vendor:vendor-race' },
      ),
      fc.integer({ min: 2, max: 1_000_000 }),
      async (binding, nextEpoch) => {
        const stub = env.AUTHORING_CLAIM.get(env.AUTHORING_CLAIM.newUniqueId())
        const oldClaim = claim({
          claimId: 'delayed-author', semanticScope: binding.scope, declaredWriteSet: [binding.target],
          leaseEpoch: 1, leaseExpiresAtMs: 2_000, fenceRevision: 'delayed-fence-v1',
        })
        const currentClaim = Object.freeze({
          ...oldClaim,
          leaseEpoch: nextEpoch,
          leaseExpiresAtMs: 5_000,
          fenceRevision: `delayed-fence-v${nextEpoch}`,
        })
        const evidence = await runInDurableObject(stub, async (instance) => {
          const claims = instance as AuthoringClaim
          const acquiredOld = await claims.acquire(oldClaim, 1_000)
          const initialAdmission = await claims.admitMutation({
            semanticScope: binding.scope,
            claimId: oldClaim.claimId,
            leaseEpoch: oldClaim.leaseEpoch,
            fenceRevision: oldClaim.fenceRevision,
            requiredWriteTarget: binding.target,
          }, 1_001)

          // Models a delayed read-only sandbox/provider preparation before the final mutation boundary.
          const acquiredCurrent = await claims.acquire(currentClaim, 2_000)
          let targetCalls = 0
          const staleOperation = operation('a')
          const staleReservation = await claims.beginMutation({
            semanticScope: binding.scope,
            claimId: oldClaim.claimId,
            leaseEpoch: oldClaim.leaseEpoch,
            fenceRevision: oldClaim.fenceRevision,
            requiredWriteTarget: binding.target,
          }, staleOperation.id, staleOperation.digest, 2_001)
          if (staleReservation.ok) targetCalls += 1
          return { acquiredOld, initialAdmission, acquiredCurrent, staleReservation, targetCalls }
        })
        expect(evidence.acquiredOld.ok).toBe(true)
        expect(evidence.initialAdmission.ok).toBe(true)
        expect(evidence.acquiredCurrent).toMatchObject({ ok: true, leaseEpoch: nextEpoch })
        expect(evidence.staleReservation).toMatchObject({
          ok: false,
          code: 'fence_stale',
          holdingLeaseEpoch: nextEpoch,
        })
        expect(evidence.targetCalls).toBe(0)
      },
    ), { numRuns: 300, seed: 19_020 })
  })

  it('holds acquisition and release fail-closed while a mutation is reserved', async () => {
    const stub = env.AUTHORING_CLAIM.get(env.AUTHORING_CLAIM.newUniqueId())
    const held = claim({
      claimId: 'reserved-author', semanticScope: 'reserved-scope', declaredWriteSet: ['reserved-target'],
      leaseEpoch: 1, leaseExpiresAtMs: 2_000, fenceRevision: 'reserved-fence-v1',
    })
    const next = Object.freeze({ ...held, leaseEpoch: 2, leaseExpiresAtMs: 4_000, fenceRevision: 'reserved-fence-v2' })
    const evidence = await runInDurableObject(stub, async (instance) => {
      const claims = instance as AuthoringClaim
      await claims.acquire(held, 1_000)
      const reservedOperation = operation('b')
      const reserved = await claims.beginMutation({
        semanticScope: held.semanticScope,
        claimId: held.claimId,
        leaseEpoch: held.leaseEpoch,
        fenceRevision: held.fenceRevision,
        requiredWriteTarget: 'reserved-target',
      }, reservedOperation.id, reservedOperation.digest, 1_001)
      const blockedAcquisition = await claims.acquire(next, 2_000)
      const blockedRelease = await claims.release(
        held.semanticScope, held.claimId, held.leaseEpoch, held.fenceRevision, 1_002,
      )
      const completed = reserved.ok ? await claims.completeMutation(reserved.permit) : { ok: false }
      const acquiredNext = await claims.acquire(next, 2_001)
      return { reserved, blockedAcquisition, blockedRelease, completed, acquiredNext }
    })
    expect(evidence.reserved.ok).toBe(true)
    expect(evidence.blockedAcquisition).toMatchObject({ ok: false, code: 'scope_held' })
    expect(evidence.blockedRelease.ok).toBe(false)
    expect(evidence.completed.ok).toBe(true)
    expect(evidence.acquiredNext).toMatchObject({ ok: true, leaseEpoch: 2 })
  })

  it('resumes only the exact unresolved operation and never reopens it on lease expiry', async () => {
    const stub = env.AUTHORING_CLAIM.get(env.AUTHORING_CLAIM.newUniqueId())
    const held = claim({
      claimId: 'resume-author', semanticScope: 'resume-scope', declaredWriteSet: ['resume-target'],
      leaseEpoch: 1, leaseExpiresAtMs: 2_000, fenceRevision: 'resume-fence-v1',
    })
    const next = Object.freeze({ ...held, leaseEpoch: 2, leaseExpiresAtMs: 5_000, fenceRevision: 'resume-fence-v2' })
    const firstOperation = operation('c')
    const secondOperation = operation('d')
    const request = {
      semanticScope: held.semanticScope,
      claimId: held.claimId,
      leaseEpoch: held.leaseEpoch,
      fenceRevision: held.fenceRevision,
      requiredWriteTarget: 'resume-target',
    } as const
    const evidence = await runInDurableObject(stub, async (instance) => {
      const claims = instance as AuthoringClaim
      await claims.acquire(held, 1_000)
      const reserved = await claims.beginMutation(request, firstOperation.id, firstOperation.digest, 1_001)
      const exactAfterExpiry = await claims.beginMutation(request, firstOperation.id, firstOperation.digest, 2_500)
      const differentAfterExpiry = await claims.beginMutation(request, secondOperation.id, secondOperation.digest, 2_500)
      const statusAfterExpiry = await claims.mutationStatus(held.semanticScope)
      const blockedAcquisition = await claims.acquire(next, 2_500)
      const completed = reserved.ok ? await claims.completeMutation(reserved.permit, 2_501) : { ok: false }
      const completedAgain = reserved.ok ? await claims.completeMutation(reserved.permit, 2_502) : { ok: false }
      const completedResume = await claims.beginMutation(request, firstOperation.id, firstOperation.digest, 2_502)
      const acquiredNext = await claims.acquire(next, 2_503)
      const nextRequest = { ...request, leaseEpoch: 2, fenceRevision: next.fenceRevision }
      const nextReservation = await claims.beginMutation(
        nextRequest, secondOperation.id, secondOperation.digest, 2_504,
      )
      return {
        reserved, exactAfterExpiry, differentAfterExpiry, statusAfterExpiry,
        blockedAcquisition, completed, completedAgain, completedResume, acquiredNext, nextReservation,
      }
    })
    expect(evidence.reserved).toMatchObject({ ok: true, permit: { mutationSequence: 1 } })
    expect(evidence.exactAfterExpiry).toEqual(evidence.reserved)
    expect(evidence.differentAfterExpiry).toMatchObject({ ok: false, code: 'mutation_reconciliation_required' })
    expect(evidence.statusAfterExpiry).toMatchObject({
      ok: true, status: 'reconciliation_required', mutationSequence: 1,
    })
    expect(evidence.blockedAcquisition).toMatchObject({ ok: false, code: 'scope_held' })
    expect(evidence.completed.ok).toBe(true)
    expect(evidence.completedAgain.ok).toBe(true)
    expect(evidence.completedResume).toEqual(evidence.reserved)
    expect(evidence.acquiredNext).toMatchObject({ ok: true, leaseEpoch: 2 })
    expect(evidence.nextReservation).toMatchObject({ ok: true, permit: { mutationSequence: 2 } })
  })
})

function operation(hex: string): Readonly<{ id: string; digest: string }> {
  const digest = hex.repeat(64)
  return Object.freeze({ id: `operation:${digest}`, digest })
}

function claim(input: Readonly<{
  claimId: string
  semanticScope: string
  declaredWriteSet: readonly string[]
  leaseEpoch: number
  leaseExpiresAtMs: number
  fenceRevision: string
}>): Claim {
  return Object.freeze({
    claimId: input.claimId,
    actorId: `actor-${input.claimId}`,
    deviceId: `device-${input.claimId}`,
    sessionId: `session-${input.claimId}`,
    worktree: `/test/${input.claimId}`,
    branch: `agent/test/${input.claimId}`,
    semanticScope: input.semanticScope,
    declaredWriteSet: Object.freeze([...new Set(input.declaredWriteSet)]),
    leaseEpoch: input.leaseEpoch,
    leaseExpiresAtMs: input.leaseExpiresAtMs,
    fenceRevision: input.fenceRevision,
  })
}

function storedClaimBytes(state: DurableObjectState): string {
  return JSON.stringify(state.storage.sql.exec<{
    semantic_scope: string
    claim_id: string
    claim_json: string
    lease_epoch: number
    lease_expires_at_ms: number
    fence_revision: string
    released_at_ms: number | null
  }>(`SELECT semantic_scope, claim_id, claim_json, lease_epoch, lease_expires_at_ms,
      fence_revision, released_at_ms FROM authoring_claim ORDER BY semantic_scope`).toArray())
}
