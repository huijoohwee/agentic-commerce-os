import { canonicalJson, sha256Hex } from '../shared/digest.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const CLAIM_FIELDS = new Set([
  'claimId',
  'actorId',
  'deviceId',
  'sessionId',
  'worktree',
  'branch',
  'semanticScope',
  'declaredWriteSet',
  'leaseEpoch',
  'leaseExpiresAtMs',
  'fenceRevision',
])
const MUTATION_REQUEST_FIELDS = new Set([
  'semanticScope', 'claimId', 'leaseEpoch', 'fenceRevision', 'requiredWriteTarget',
])
const MUTATION_PERMIT_SCHEMA = 'agentic-graph-authoring-mutation-permit/v2' as const
const MUTATION_PERMIT_FIELDS = new Set([
  'schema', 'mutationId', 'operationId', 'requestDigest', 'mutationSequence',
  'semanticScope', 'claimId', 'leaseEpoch', 'leaseExpiresAtMs', 'fenceRevision',
  'requiredWriteTarget', 'reservedAtMs',
])
const MUTATION_OPERATION_SCHEMA = 'agentic-graph-authoring-operation/v1' as const

export type Claim = Readonly<{
  claimId: string
  actorId: string
  deviceId: string
  sessionId: string
  worktree: string
  branch: string
  semanticScope: string
  declaredWriteSet: readonly string[]
  leaseEpoch: number
  leaseExpiresAtMs: number
  fenceRevision: string
}>

export type ClaimMutationRequest = Readonly<{
  semanticScope: string
  claimId: string
  leaseEpoch: number
  fenceRevision: string
  requiredWriteTarget: string
}>

export type ClaimAdmission =
  | Readonly<{
      ok: true
      semanticScope: string
      claimId: string
      actorId: string
      deviceId: string
      sessionId: string
      worktree: string
      branch: string
      leaseEpoch: number
      leaseExpiresAtMs: number
      fenceRevision: string
      declaredWriteSet: readonly string[]
    }>
  | Readonly<{
      ok: false
      code: 'scope_held' | 'lease_expired' | 'write_set_overlap' | 'mutation_out_of_write_set'
        | 'fence_stale' | 'claim_malformed' | 'mutation_reconciliation_required'
      holdingClaimId: string | null
      holdingLeaseEpoch: number | null
      holdingFenceRevision: string | null
    }>

export type MutationClaimBinding = Readonly<{ semanticScope: string; writeTarget: string }>

export type ClaimMutationPermit = Readonly<{
  schema: typeof MUTATION_PERMIT_SCHEMA
  mutationId: string
  operationId: string
  requestDigest: string
  mutationSequence: number
  semanticScope: string
  claimId: string
  leaseEpoch: number
  leaseExpiresAtMs: number
  fenceRevision: string
  requiredWriteTarget: string
  reservedAtMs: number
}>

export type ClaimMutationReservation =
  | Readonly<{ ok: true; permit: ClaimMutationPermit }>
  | Exclude<ClaimAdmission, { ok: true }>

export const AGENT_REGISTRY_CLAIM = Object.freeze({
  semanticScope: 'operator-registry',
  writeTarget: 'registry',
}) satisfies MutationClaimBinding

export function merchantThemeClaim(merchantId: string): MutationClaimBinding {
  const target = `merchant-theme:${merchantId}`
  return Object.freeze({ semanticScope: target, writeTarget: target })
}

export function vendorTransitionClaim(vendorId: string): MutationClaimBinding {
  const target = `vendor:${vendorId}`
  return Object.freeze({ semanticScope: target, writeTarget: target })
}

export function writeSetsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right)
  return left.some((entry) => rightSet.has(entry))
}

export function claimWouldBeAdmitted(
  claim: Claim,
  active: readonly Claim[],
  nowMs: number,
): ClaimAdmission {
  if (!validClaim(claim, nowMs)) return claimRefusal('claim_malformed', null)
  const sameScope = active.find((held) => held.leaseExpiresAtMs > nowMs && held.semanticScope === claim.semanticScope)
  if (sameScope) return sameClaim(sameScope, claim) ? claimAccepted(claim) : claimRefusal('scope_held', sameScope)
  const overlap = active.find((held) => (
    held.leaseExpiresAtMs > nowMs && writeSetsOverlap(held.declaredWriteSet, claim.declaredWriteSet)
  ))
  return overlap ? claimRefusal('write_set_overlap', overlap) : claimAccepted(claim)
}

export function validClaim(claim: Claim, nowMs: number): boolean {
  return Boolean(claim)
    && typeof claim === 'object'
    && Object.keys(claim).length === CLAIM_FIELDS.size
    && Object.keys(claim).every((field) => CLAIM_FIELDS.has(field))
    && [claim.claimId, claim.actorId, claim.deviceId, claim.sessionId, claim.semanticScope]
      .every((value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value))
    && typeof claim.worktree === 'string'
    && claim.worktree.length > 0
    && claim.worktree.length <= 1_024
    && typeof claim.branch === 'string'
    && claim.branch.length > 0
    && claim.branch.length <= 512
    && Array.isArray(claim.declaredWriteSet)
    && claim.declaredWriteSet.length > 0
    && claim.declaredWriteSet.length <= 1_000
    && claim.declaredWriteSet.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512)
    && new Set(claim.declaredWriteSet).size === claim.declaredWriteSet.length
    && Number.isSafeInteger(claim.leaseEpoch)
    && claim.leaseEpoch >= 1
    && Number.isSafeInteger(claim.leaseExpiresAtMs)
    && claim.leaseExpiresAtMs > nowMs
    && REVISION_PATTERN.test(claim.fenceRevision)
}

export function readClaimMutationRequest(value: unknown): ClaimMutationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== MUTATION_REQUEST_FIELDS.size
    || Object.keys(input).some((field) => !MUTATION_REQUEST_FIELDS.has(field))
    || typeof input.semanticScope !== 'string'
    || !IDENTIFIER_PATTERN.test(input.semanticScope)
    || typeof input.claimId !== 'string'
    || !IDENTIFIER_PATTERN.test(input.claimId)
    || !Number.isSafeInteger(input.leaseEpoch)
    || Number(input.leaseEpoch) < 1
    || typeof input.fenceRevision !== 'string'
    || !REVISION_PATTERN.test(input.fenceRevision)
    || typeof input.requiredWriteTarget !== 'string'
    || input.requiredWriteTarget.length < 1
    || input.requiredWriteTarget.length > 512) return null
  return Object.freeze({
    semanticScope: input.semanticScope,
    claimId: input.claimId,
    leaseEpoch: Number(input.leaseEpoch),
    fenceRevision: input.fenceRevision,
    requiredWriteTarget: input.requiredWriteTarget,
  })
}

export function claimMutationPermit(
  claim: Claim,
  request: ClaimMutationRequest,
  operationId: string,
  requestDigest: string,
  mutationSequence: number,
  reservedAtMs: number,
): ClaimMutationPermit | null {
  const mutationId = `mutation:${claim.leaseEpoch}:${mutationSequence}:${requestDigest.slice(0, 32)}`
  if (!IDENTIFIER_PATTERN.test(mutationId)
    || !IDENTIFIER_PATTERN.test(operationId)
    || !SHA256_PATTERN.test(requestDigest)
    || !Number.isSafeInteger(mutationSequence)
    || mutationSequence < 1
    || !Number.isSafeInteger(reservedAtMs)
    || reservedAtMs < 0
    || claim.semanticScope !== request.semanticScope
    || claim.claimId !== request.claimId
    || claim.leaseEpoch !== request.leaseEpoch
    || claim.fenceRevision !== request.fenceRevision) return null
  return Object.freeze({
    schema: MUTATION_PERMIT_SCHEMA,
    mutationId,
    operationId,
    requestDigest,
    mutationSequence,
    semanticScope: request.semanticScope,
    claimId: request.claimId,
    leaseEpoch: request.leaseEpoch,
    leaseExpiresAtMs: claim.leaseExpiresAtMs,
    fenceRevision: request.fenceRevision,
    requiredWriteTarget: request.requiredWriteTarget,
    reservedAtMs,
  })
}

export function readClaimMutationPermit(value: unknown): ClaimMutationPermit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== MUTATION_PERMIT_FIELDS.size
    || Object.keys(input).some((field) => !MUTATION_PERMIT_FIELDS.has(field))
    || input.schema !== MUTATION_PERMIT_SCHEMA
    || typeof input.mutationId !== 'string'
    || !IDENTIFIER_PATTERN.test(input.mutationId)
    || typeof input.operationId !== 'string'
    || !IDENTIFIER_PATTERN.test(input.operationId)
    || typeof input.requestDigest !== 'string'
    || !SHA256_PATTERN.test(input.requestDigest)
    || !Number.isSafeInteger(input.mutationSequence)
    || Number(input.mutationSequence) < 1
    || typeof input.semanticScope !== 'string'
    || !IDENTIFIER_PATTERN.test(input.semanticScope)
    || typeof input.claimId !== 'string'
    || !IDENTIFIER_PATTERN.test(input.claimId)
    || !Number.isSafeInteger(input.leaseEpoch)
    || Number(input.leaseEpoch) < 1
    || !Number.isSafeInteger(input.leaseExpiresAtMs)
    || Number(input.leaseExpiresAtMs) < 1
    || typeof input.fenceRevision !== 'string'
    || !REVISION_PATTERN.test(input.fenceRevision)
    || typeof input.requiredWriteTarget !== 'string'
    || input.requiredWriteTarget.length < 1
    || input.requiredWriteTarget.length > 512
    || !Number.isSafeInteger(input.reservedAtMs)
    || Number(input.reservedAtMs) < 0
    || Number(input.reservedAtMs) >= Number(input.leaseExpiresAtMs)) return null
  if (input.operationId !== authoringMutationOperationId(input.requestDigest)
    || input.mutationId !== `mutation:${input.leaseEpoch}:${input.mutationSequence}:${input.requestDigest.slice(0, 32)}`) {
    return null
  }
  return Object.freeze({
    schema: MUTATION_PERMIT_SCHEMA,
    mutationId: input.mutationId,
    operationId: input.operationId,
    requestDigest: input.requestDigest,
    mutationSequence: Number(input.mutationSequence),
    semanticScope: input.semanticScope,
    claimId: input.claimId,
    leaseEpoch: Number(input.leaseEpoch),
    leaseExpiresAtMs: Number(input.leaseExpiresAtMs),
    fenceRevision: input.fenceRevision,
    requiredWriteTarget: input.requiredWriteTarget,
    reservedAtMs: Number(input.reservedAtMs),
  })
}

export async function authoringMutationRequestDigest(
  expected: MutationClaimBinding,
  payload: unknown,
): Promise<string> {
  return sha256Hex(canonicalJson({
    schema: MUTATION_OPERATION_SCHEMA,
    semanticScope: expected.semanticScope,
    writeTarget: expected.writeTarget,
    payload,
  }))
}

export function authoringMutationOperationId(requestDigest: string): string | null {
  return SHA256_PATTERN.test(requestDigest) ? `operation:${requestDigest}` : null
}

export function sameClaim(left: Claim, right: Claim): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export function claimAccepted(claim: Claim): ClaimAdmission {
  return Object.freeze({
    ok: true,
    semanticScope: claim.semanticScope,
    claimId: claim.claimId,
    actorId: claim.actorId,
    deviceId: claim.deviceId,
    sessionId: claim.sessionId,
    worktree: claim.worktree,
    branch: claim.branch,
    leaseEpoch: claim.leaseEpoch,
    leaseExpiresAtMs: claim.leaseExpiresAtMs,
    fenceRevision: claim.fenceRevision,
    declaredWriteSet: Object.freeze([...claim.declaredWriteSet]),
  })
}

export function claimRefusal(
  code: Exclude<ClaimAdmission, { ok: true }>['code'],
  holding: Claim | null,
): Exclude<ClaimAdmission, { ok: true }> {
  return Object.freeze({
    ok: false,
    code,
    holdingClaimId: holding?.claimId ?? null,
    holdingLeaseEpoch: holding?.leaseEpoch ?? null,
    holdingFenceRevision: holding?.fenceRevision ?? null,
  })
}
