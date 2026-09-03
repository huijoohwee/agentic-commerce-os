import {
  readClaimMutationPermit,
  type ClaimMutationPermit,
  type MutationClaimBinding,
} from '../domain/authoring-claim-policy.js'
import { canonicalJson } from '../shared/digest.js'

type StoredFence = Readonly<{
  claim_id: string
  lease_epoch: number
  fence_revision: string
  mutation_id: string
  mutation_sequence: number
  request_digest: string
  lease_expires_at_ms: number
}>

type StoredOutcome = Readonly<{
  permit_json: string
  request_digest: string
  outcome_json: string
}>

export type FencedMutationRefusal = Readonly<{
  ok: false
  code: 'claim_malformed' | 'mutation_out_of_write_set' | 'mutation_request_mismatch'
    | 'lease_expired' | 'fence_stale'
  holdingClaimId: string | null
  holdingLeaseEpoch: number | null
  holdingFenceRevision: string | null
}>

export type FencedMutationResult<T> = Readonly<{ ok: true; value: T }> | FencedMutationRefusal

export function runAuthoringFencedMutation<T>(
  storage: DurableObjectStorage,
  sql: SqlStorage,
  value: unknown,
  expected: MutationClaimBinding,
  actualRequestDigest: string,
  mutation: () => T,
  nowMs = Date.now(),
): FencedMutationResult<T> {
  const permit = readClaimMutationPermit(value)
  if (!permit) return refusal('claim_malformed', null)
  if (permit.semanticScope !== expected.semanticScope
    || permit.requiredWriteTarget !== expected.writeTarget) {
    return refusal('mutation_out_of_write_set', permit)
  }
  if (permit.requestDigest !== actualRequestDigest) return refusal('mutation_request_mismatch', permit)
  const permitJson = canonicalJson(permit)
  let outcome: FencedMutationResult<T> | null = null
  storage.transactionSync(() => {
    const priorOutcome = readOutcome(sql, permit.mutationId)
    if (priorOutcome) {
      if (priorOutcome.permit_json !== permitJson || priorOutcome.request_digest !== actualRequestDigest) {
        outcome = refusal('mutation_request_mismatch', permit)
      } else {
        outcome = Object.freeze({ ok: true, value: JSON.parse(priorOutcome.outcome_json) as T })
      }
      return
    }
    const prior = readFence(sql, permit.semanticScope)
    if (!Number.isSafeInteger(nowMs) || permit.leaseExpiresAtMs <= nowMs) {
      outcome = refusal('lease_expired', permit)
      return
    }
    if (prior && isStale(permit, prior)) {
      outcome = refusal('fence_stale', prior)
      return
    }
    const value = mutation()
    const outcomeJson = canonicalJson(value)
    sql.exec(
      `INSERT INTO authoring_mutation_fence (
        semantic_scope, claim_id, lease_epoch, fence_revision, mutation_id,
        mutation_sequence, request_digest, lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(semantic_scope) DO UPDATE SET
        claim_id = excluded.claim_id,
        lease_epoch = excluded.lease_epoch,
        fence_revision = excluded.fence_revision,
        mutation_id = excluded.mutation_id,
        mutation_sequence = excluded.mutation_sequence,
        request_digest = excluded.request_digest,
        lease_expires_at_ms = excluded.lease_expires_at_ms`,
      permit.semanticScope,
      permit.claimId,
      permit.leaseEpoch,
      permit.fenceRevision,
      permit.mutationId,
      permit.mutationSequence,
      permit.requestDigest,
      permit.leaseExpiresAtMs,
    )
    sql.exec(
      `INSERT INTO authoring_mutation_outcome (
        mutation_id, semantic_scope, mutation_sequence, permit_json, request_digest, outcome_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      permit.mutationId,
      permit.semanticScope,
      permit.mutationSequence,
      permitJson,
      permit.requestDigest,
      outcomeJson,
    )
    outcome = Object.freeze({ ok: true, value })
  })
  return outcome ?? refusal('claim_malformed', null)
}

function readFence(sql: SqlStorage, scope: string): StoredFence | null {
  return sql.exec<StoredFence>(
    `SELECT claim_id, lease_epoch, fence_revision, mutation_id,
       mutation_sequence, request_digest, lease_expires_at_ms
     FROM authoring_mutation_fence WHERE semantic_scope = ?`,
    scope,
  ).toArray()[0] ?? null
}

function readOutcome(sql: SqlStorage, mutationId: string): StoredOutcome | null {
  return sql.exec<StoredOutcome>(
    `SELECT permit_json, request_digest, outcome_json
     FROM authoring_mutation_outcome WHERE mutation_id = ?`,
    mutationId,
  ).toArray()[0] ?? null
}

function isStale(permit: ClaimMutationPermit, prior: StoredFence): boolean {
  return permit.leaseEpoch < prior.lease_epoch
    || (permit.leaseEpoch === prior.lease_epoch && (
      permit.claimId !== prior.claim_id
      || permit.fenceRevision !== prior.fence_revision
      || permit.leaseExpiresAtMs !== prior.lease_expires_at_ms
      || permit.mutationSequence <= prior.mutation_sequence
    ))
}

function refusal(
  code: FencedMutationRefusal['code'],
  holding: Pick<ClaimMutationPermit, 'claimId' | 'leaseEpoch' | 'fenceRevision'> | StoredFence | null,
): FencedMutationRefusal {
  const claimId = holding && 'claimId' in holding ? holding.claimId : holding?.claim_id ?? null
  const leaseEpoch = holding && 'leaseEpoch' in holding ? holding.leaseEpoch : holding?.lease_epoch ?? null
  const fenceRevision = holding && 'fenceRevision' in holding
    ? holding.fenceRevision
    : holding?.fence_revision ?? null
  return Object.freeze({
    ok: false,
    code,
    holdingClaimId: claimId,
    holdingLeaseEpoch: leaseEpoch,
    holdingFenceRevision: fenceRevision,
  })
}
