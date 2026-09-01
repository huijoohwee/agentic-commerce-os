import {
  readClaimMutationPermit,
  type ClaimMutationPermit,
} from '../domain/authoring-claim-policy.ts'

const HEADERS = Object.freeze({
  schema: 'x-authoring-mutation-contract',
  mutationId: 'x-authoring-mutation-id',
  operationId: 'x-authoring-operation-id',
  requestDigest: 'x-authoring-request-digest',
  mutationSequence: 'x-authoring-mutation-sequence',
  semanticScope: 'x-authoring-semantic-scope',
  claimId: 'x-authoring-claim-id',
  leaseEpoch: 'x-authoring-lease-epoch',
  leaseExpiresAtMs: 'x-authoring-lease-expires-at-ms',
  fenceRevision: 'x-authoring-fence-revision',
  requiredWriteTarget: 'x-authoring-write-target',
  reservedAtMs: 'x-authoring-reserved-at-ms',
})

export function authoringMutationHeaders(permit: ClaimMutationPermit): Readonly<Record<string, string>> {
  return Object.freeze({
    [HEADERS.schema]: permit.schema,
    [HEADERS.mutationId]: permit.mutationId,
    [HEADERS.operationId]: permit.operationId,
    [HEADERS.requestDigest]: permit.requestDigest,
    [HEADERS.mutationSequence]: String(permit.mutationSequence),
    [HEADERS.semanticScope]: permit.semanticScope,
    [HEADERS.claimId]: permit.claimId,
    [HEADERS.leaseEpoch]: String(permit.leaseEpoch),
    [HEADERS.leaseExpiresAtMs]: String(permit.leaseExpiresAtMs),
    [HEADERS.fenceRevision]: permit.fenceRevision,
    [HEADERS.requiredWriteTarget]: permit.requiredWriteTarget,
    [HEADERS.reservedAtMs]: String(permit.reservedAtMs),
  })
}

export function readAuthoringMutationHeaders(request: Request): ClaimMutationPermit | null {
  return readClaimMutationPermit({
    schema: request.headers.get(HEADERS.schema),
    mutationId: request.headers.get(HEADERS.mutationId),
    operationId: request.headers.get(HEADERS.operationId),
    requestDigest: request.headers.get(HEADERS.requestDigest),
    mutationSequence: readPositiveInteger(request.headers.get(HEADERS.mutationSequence)),
    semanticScope: request.headers.get(HEADERS.semanticScope),
    claimId: request.headers.get(HEADERS.claimId),
    leaseEpoch: readPositiveInteger(request.headers.get(HEADERS.leaseEpoch)),
    leaseExpiresAtMs: readPositiveInteger(request.headers.get(HEADERS.leaseExpiresAtMs)),
    fenceRevision: request.headers.get(HEADERS.fenceRevision),
    requiredWriteTarget: request.headers.get(HEADERS.requiredWriteTarget),
    reservedAtMs: readNonnegativeInteger(request.headers.get(HEADERS.reservedAtMs)),
  })
}

export function responseMatchesAuthoringMutation(response: Response, permit: ClaimMutationPermit): boolean {
  return Object.entries(authoringMutationHeaders(permit)).every(([name, value]) => response.headers.get(name) === value)
}

function readPositiveInteger(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function readNonnegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
