import type { ClaimMutationPermit, MutationClaimBinding } from '../domain/authoring-claim-policy.js'
import {
  authoringMutationHeaders,
  readAuthoringMutationHeaders,
} from '../core/authoring-mutation-headers.ts'

const FENCES = new Map<string, Pick<
  ClaimMutationPermit,
  'claimId' | 'leaseEpoch' | 'leaseExpiresAtMs' | 'fenceRevision'
    | 'mutationId' | 'mutationSequence' | 'requestDigest'
>>()

export type DevMutationFenceResult =
  | Readonly<{ ok: true; permit: ClaimMutationPermit }>
  | Readonly<{
      ok: false
      code: 'authoring_mutation_permit_invalid' | 'authoring_mutation_lease_expired' | 'authoring_mutation_fence_stale'
      permit: ClaimMutationPermit | null
    }>

export function admitDevAuthoringMutation(
  request: Request,
  expected: MutationClaimBinding,
  nowMs = Date.now(),
): DevMutationFenceResult {
  const permit = readAuthoringMutationHeaders(request)
  if (!permit
    || permit.semanticScope !== expected.semanticScope
    || permit.requiredWriteTarget !== expected.writeTarget) {
    return Object.freeze({ ok: false, code: 'authoring_mutation_permit_invalid', permit })
  }
  if (permit.leaseExpiresAtMs <= nowMs) {
    return Object.freeze({ ok: false, code: 'authoring_mutation_lease_expired', permit })
  }
  const prior = FENCES.get(permit.semanticScope)
  const exactReplay = prior
    && permit.mutationId === prior.mutationId
    && permit.mutationSequence === prior.mutationSequence
    && permit.requestDigest === prior.requestDigest
    && permit.claimId === prior.claimId
    && permit.leaseEpoch === prior.leaseEpoch
    && permit.fenceRevision === prior.fenceRevision
    && permit.leaseExpiresAtMs === prior.leaseExpiresAtMs
  if (prior && !exactReplay && (permit.leaseEpoch < prior.leaseEpoch
    || (permit.leaseEpoch === prior.leaseEpoch && (
      permit.claimId !== prior.claimId
      || permit.fenceRevision !== prior.fenceRevision
      || permit.leaseExpiresAtMs !== prior.leaseExpiresAtMs
      || permit.mutationSequence <= prior.mutationSequence
    )))) {
    return Object.freeze({ ok: false, code: 'authoring_mutation_fence_stale', permit })
  }
  FENCES.set(permit.semanticScope, Object.freeze({
    claimId: permit.claimId,
    leaseEpoch: permit.leaseEpoch,
    leaseExpiresAtMs: permit.leaseExpiresAtMs,
    fenceRevision: permit.fenceRevision,
    mutationId: permit.mutationId,
    mutationSequence: permit.mutationSequence,
    requestDigest: permit.requestDigest,
  }))
  return Object.freeze({ ok: true, permit })
}

export function devAuthoringHeaders(permit: ClaimMutationPermit | null): Readonly<Record<string, string>> {
  return permit ? authoringMutationHeaders(permit) : {}
}
