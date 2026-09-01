import { DurableObject } from 'cloudflare:workers'

import { canonicalJson } from '../shared/digest.js'
import {
  claimAccepted,
  claimMutationPermit,
  claimRefusal,
  authoringMutationOperationId,
  readClaimMutationPermit,
  sameClaim,
  readClaimMutationRequest,
  validClaim,
  writeSetsOverlap,
  type Claim,
  type ClaimAdmission,
  type ClaimMutationPermit,
  type ClaimMutationRequest,
  type ClaimMutationReservation,
} from '../domain/authoring-claim-policy.js'

export {
  claimWouldBeAdmitted,
  writeSetsOverlap,
  type Claim,
  type ClaimAdmission,
  type ClaimMutationPermit,
  type ClaimMutationRequest,
  type ClaimMutationReservation,
} from '../domain/authoring-claim-policy.js'

export class AuthoringClaim extends DurableObject<CoreEnv> {
  readonly #storage: DurableObjectStorage
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#storage = state.storage
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_claim (
        semantic_scope TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL UNIQUE,
        claim_json TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        fence_revision TEXT NOT NULL,
        released_at_ms INTEGER
      )`)
      this.#sql.exec(`CREATE INDEX IF NOT EXISTS authoring_claim_active_lease
        ON authoring_claim(lease_expires_at_ms, released_at_ms)`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_reservation (
        semantic_scope TEXT PRIMARY KEY,
        mutation_id TEXT NOT NULL UNIQUE,
        permit_json TEXT NOT NULL
      )`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_sequence (
        semantic_scope TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
      )`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_completion (
        semantic_scope TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        permit_json TEXT NOT NULL,
        completed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (semantic_scope, claim_id, lease_epoch, operation_id)
      )`)
    })
  }

  async acquire(claim: Claim, nowMs = Date.now()): Promise<ClaimAdmission> {
    if (!validClaim(claim, nowMs)) return claimRefusal('claim_malformed', null)
    const reserved = this.#reservedClaims()
    const reservedScope = reserved.find((held) => held.semanticScope === claim.semanticScope)
    if (reservedScope && !sameClaim(reservedScope, claim)) {
      return claimRefusal('scope_held', reservedScope)
    }
    const reservedOverlap = reserved.find((held) => (
      held.claimId !== claim.claimId && writeSetsOverlap(held.declaredWriteSet, claim.declaredWriteSet)
    ))
    if (reservedOverlap) return claimRefusal('write_set_overlap', reservedOverlap)
    const active = this.#active(nowMs)
    const sameScope = active.find((held) => held.semanticScope === claim.semanticScope)
    if (sameScope) {
      if (sameClaim(sameScope, claim)) return claimAccepted(claim)
      return claimRefusal('scope_held', sameScope)
    }
    const overlap = active.find((held) => writeSetsOverlap(held.declaredWriteSet, claim.declaredWriteSet))
    if (overlap) return claimRefusal('write_set_overlap', overlap)
    const prior = this.#readScope(claim.semanticScope)
    if (prior && claim.leaseEpoch <= prior.leaseEpoch) return claimRefusal('fence_stale', prior)
    this.#sql.exec(
      `INSERT INTO authoring_claim (
        semantic_scope, claim_id, claim_json, lease_epoch, lease_expires_at_ms,
        fence_revision, released_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(semantic_scope) DO UPDATE SET
        claim_id = excluded.claim_id,
        claim_json = excluded.claim_json,
        lease_epoch = excluded.lease_epoch,
        lease_expires_at_ms = excluded.lease_expires_at_ms,
        fence_revision = excluded.fence_revision,
        released_at_ms = NULL`,
      claim.semanticScope,
      claim.claimId,
      canonicalJson(claim),
      claim.leaseEpoch,
      claim.leaseExpiresAtMs,
      claim.fenceRevision,
    )
    return claimAccepted(claim)
  }

  async admitMutation(request: ClaimMutationRequest, nowMs = Date.now()): Promise<ClaimAdmission> {
    return this.#mutationAdmission(request, nowMs)
  }

  #mutationAdmission(request: ClaimMutationRequest, nowMs: number): ClaimAdmission {
    const exactRequest = readClaimMutationRequest(request)
    if (!exactRequest || !Number.isSafeInteger(nowMs)) return claimRefusal('claim_malformed', null)
    const claim = this.#readScope(exactRequest.semanticScope)
    if (!claim || claim.claimId !== exactRequest.claimId) return claimRefusal('scope_held', claim)
    if (claim.leaseExpiresAtMs <= nowMs) return claimRefusal('lease_expired', claim)
    if (claim.leaseEpoch !== exactRequest.leaseEpoch
      || claim.fenceRevision !== exactRequest.fenceRevision) return claimRefusal('fence_stale', claim)
    if (!claim.declaredWriteSet.includes(exactRequest.requiredWriteTarget)) {
      return claimRefusal('mutation_out_of_write_set', claim)
    }
    const overlap = this.#active(nowMs).find((candidate) => (
      candidate.claimId !== claim.claimId
      && writeSetsOverlap(candidate.declaredWriteSet, claim.declaredWriteSet)
    ))
    if (overlap) return claimRefusal('write_set_overlap', overlap)
    return claimAccepted(claim)
  }

  async beginMutation(
    request: ClaimMutationRequest,
    operationId: string,
    requestDigest: string,
    nowMs = Date.now(),
  ): Promise<ClaimMutationReservation> {
    const exactRequest = readClaimMutationRequest(request)
    if (!exactRequest
      || !Number.isSafeInteger(nowMs)
      || authoringMutationOperationId(requestDigest) !== operationId) {
      return claimRefusal('claim_malformed', null)
    }
    const existing = this.#readReservation(exactRequest.semanticScope)
    if (!existing && this.#hasReservation(exactRequest.semanticScope)) {
      return claimRefusal('mutation_reconciliation_required', this.#readScope(exactRequest.semanticScope))
    }
    if (existing) {
      return existing.operationId === operationId
        && existing.requestDigest === requestDigest
        && existing.claimId === exactRequest.claimId
        && existing.leaseEpoch === exactRequest.leaseEpoch
        && existing.fenceRevision === exactRequest.fenceRevision
        && existing.requiredWriteTarget === exactRequest.requiredWriteTarget
        ? Object.freeze({ ok: true, permit: existing })
        : claimRefusal('mutation_reconciliation_required', this.#readScope(exactRequest.semanticScope))
    }
    const completed = this.#readCompletion(exactRequest, operationId)
    if (completed) {
      return completed.requestDigest === requestDigest
        && completed.fenceRevision === exactRequest.fenceRevision
        && completed.requiredWriteTarget === exactRequest.requiredWriteTarget
        ? Object.freeze({ ok: true, permit: completed })
        : claimRefusal('claim_malformed', this.#readScope(exactRequest.semanticScope))
    }
    const admission = this.#mutationAdmission(exactRequest, nowMs)
    if (!admission.ok) return admission
    const claim = this.#readScope(exactRequest.semanticScope)
    if (!claim) return claimRefusal('scope_held', null)
    let permit: ClaimMutationPermit | null = null
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        `INSERT INTO authoring_mutation_sequence (semantic_scope, last_sequence)
         VALUES (?, 0) ON CONFLICT(semantic_scope) DO NOTHING`,
        exactRequest.semanticScope,
      )
      const sequence = this.#sql.exec<{ last_sequence: number }>(
        `UPDATE authoring_mutation_sequence SET last_sequence = last_sequence + 1
         WHERE semantic_scope = ? RETURNING last_sequence`,
        exactRequest.semanticScope,
      ).one().last_sequence
      permit = claimMutationPermit(claim, exactRequest, operationId, requestDigest, sequence, nowMs)
      if (!permit) return
      this.#sql.exec(
        `INSERT INTO authoring_mutation_reservation (semantic_scope, mutation_id, permit_json)
         VALUES (?, ?, ?)`,
        permit.semanticScope,
        permit.mutationId,
        canonicalJson(permit),
      )
    })
    return permit
      ? Object.freeze({ ok: true, permit })
      : claimRefusal('claim_malformed', claim)
  }

  async completeMutation(
    value: ClaimMutationPermit,
    nowMs = Date.now(),
  ): Promise<Readonly<{ ok: boolean }>> {
    const permit = readClaimMutationPermit(value)
    if (!permit || !Number.isSafeInteger(nowMs) || nowMs < 0) return Object.freeze({ ok: false })
    const permitJson = canonicalJson(permit)
    let completed = false
    this.#storage.transactionSync(() => {
      const existing = this.#readReservation(permit.semanticScope)
      if (!existing) {
        const prior = this.#readCompletionPermit(permit)
        completed = prior !== null && canonicalJson(prior) === permitJson
        return
      }
      if (canonicalJson(existing) !== permitJson) return
      this.#sql.exec(
        `INSERT INTO authoring_mutation_completion (
          semantic_scope, claim_id, lease_epoch, operation_id, permit_json, completed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(semantic_scope, claim_id, lease_epoch, operation_id) DO NOTHING`,
        permit.semanticScope,
        permit.claimId,
        permit.leaseEpoch,
        permit.operationId,
        permitJson,
        nowMs,
      )
      const storedCompletion = this.#readCompletionPermit(permit)
      if (!storedCompletion || canonicalJson(storedCompletion) !== permitJson) return
      const deleted = this.#sql.exec(
        `DELETE FROM authoring_mutation_reservation
         WHERE semantic_scope = ? AND mutation_id = ? AND permit_json = ?`,
        permit.semanticScope,
        permit.mutationId,
        permitJson,
      )
      completed = deleted.rowsWritten === 1
    })
    return Object.freeze({ ok: completed })
  }

  async mutationStatus(scope: string): Promise<Readonly<Record<string, unknown>>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(scope)) {
      return Object.freeze({ ok: false, code: 'claim_malformed' })
    }
    const permit = this.#readReservation(scope)
    return permit
      ? Object.freeze({
          ok: true,
          status: 'reconciliation_required',
          mutationId: permit.mutationId,
          operationId: permit.operationId,
          requestDigest: permit.requestDigest,
          mutationSequence: permit.mutationSequence,
          claimId: permit.claimId,
          leaseEpoch: permit.leaseEpoch,
          fenceRevision: permit.fenceRevision,
          leaseExpiresAtMs: permit.leaseExpiresAtMs,
        })
      : this.#hasReservation(scope)
        ? Object.freeze({ ok: true, status: 'reconciliation_required', code: 'reservation_unreadable' })
      : Object.freeze({ ok: true, status: 'none' })
  }

  async release(
    scope: string,
    claimId: string,
    leaseEpoch: number,
    fenceRevision: string,
    nowMs = Date.now(),
  ): Promise<Readonly<{ ok: boolean }>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(scope)
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(claimId)
      || !Number.isSafeInteger(leaseEpoch)
      || leaseEpoch < 1
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(fenceRevision)) {
      return Object.freeze({ ok: false })
    }
    if (this.#hasReservation(scope)) return Object.freeze({ ok: false })
    const update = this.#sql.exec(
      `UPDATE authoring_claim SET released_at_ms = ?
       WHERE semantic_scope = ? AND claim_id = ? AND lease_epoch = ?
         AND fence_revision = ? AND lease_expires_at_ms > ? AND released_at_ms IS NULL`,
      nowMs,
      scope,
      claimId,
      leaseEpoch,
      fenceRevision,
      nowMs,
    )
    return Object.freeze({ ok: update.rowsWritten === 1 })
  }

  async current(nowMs = Date.now()): Promise<Readonly<{ ok: true; claims: readonly Claim[] }>> {
    return Object.freeze({ ok: true, claims: Object.freeze(this.#active(nowMs)) })
  }

  #active(nowMs: number): Claim[] {
    return this.#sql.exec<{ claim_json: string }>(
      `SELECT claim_json FROM authoring_claim
       WHERE released_at_ms IS NULL AND lease_expires_at_ms > ? ORDER BY semantic_scope`,
      nowMs,
    ).toArray().map(({ claim_json }) => JSON.parse(claim_json) as Claim)
  }

  #readScope(scope: string): Claim | null {
    const row = this.#sql.exec<{ claim_json: string }>(
      'SELECT claim_json FROM authoring_claim WHERE semantic_scope = ?',
      scope,
    ).toArray()[0]
    return row ? JSON.parse(row.claim_json) as Claim : null
  }

  #readReservation(scope: string): ClaimMutationPermit | null {
    const row = this.#sql.exec<{ permit_json: string }>(
      'SELECT permit_json FROM authoring_mutation_reservation WHERE semantic_scope = ?',
      scope,
    ).toArray()[0]
    if (!row) return null
    try {
      return readClaimMutationPermit(JSON.parse(row.permit_json))
    } catch {
      return null
    }
  }

  #hasReservation(scope: string): boolean {
    return this.#sql.exec<{ present: number }>(
      'SELECT 1 AS present FROM authoring_mutation_reservation WHERE semantic_scope = ?',
      scope,
    ).toArray().length === 1
  }

  #readCompletion(request: ClaimMutationRequest, operationId: string): ClaimMutationPermit | null {
    const row = this.#sql.exec<{ permit_json: string }>(
      `SELECT permit_json FROM authoring_mutation_completion
       WHERE semantic_scope = ? AND claim_id = ? AND lease_epoch = ? AND operation_id = ?`,
      request.semanticScope,
      request.claimId,
      request.leaseEpoch,
      operationId,
    ).toArray()[0]
    return row ? readClaimMutationPermit(JSON.parse(row.permit_json)) : null
  }

  #readCompletionPermit(permit: ClaimMutationPermit): ClaimMutationPermit | null {
    return this.#readCompletion(permit, permit.operationId)
  }

  #reservedClaims(): Claim[] {
    return this.#sql.exec<{ semantic_scope: string }>(
      'SELECT semantic_scope FROM authoring_mutation_reservation ORDER BY semantic_scope',
    ).toArray().flatMap(({ semantic_scope }) => {
      const claim = this.#readScope(semantic_scope)
      return claim ? [claim] : []
    })
  }
}
