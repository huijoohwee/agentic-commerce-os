const AUTHORING_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u

export const AUTHORING_HEADER_NAMES = Object.freeze([
  'x-authoring-semantic-scope',
  'x-authoring-claim-id',
  'x-authoring-lease-epoch',
  'x-authoring-fence-revision',
] as const)

export type AuthoringClaimHeaders = Readonly<{
  'x-authoring-semantic-scope': string
  'x-authoring-claim-id': string
  'x-authoring-lease-epoch': string
  'x-authoring-fence-revision': string
}>

export type AuthoringClaimHeaderVerdict =
  | Readonly<{ ok: true; headers: AuthoringClaimHeaders }>
  | Readonly<{ ok: false; code: 'authoring_claim_required' }>

export function readAuthoringClaimHeaders(request: Request): AuthoringClaimHeaderVerdict {
  const semanticScope = request.headers.get(AUTHORING_HEADER_NAMES[0]) ?? ''
  const claimId = request.headers.get(AUTHORING_HEADER_NAMES[1]) ?? ''
  const leaseEpoch = request.headers.get(AUTHORING_HEADER_NAMES[2]) ?? ''
  const fenceRevision = request.headers.get(AUTHORING_HEADER_NAMES[3]) ?? ''
  if (![semanticScope, claimId, fenceRevision].every((value) => AUTHORING_VALUE_PATTERN.test(value))
    || !/^[1-9]\d*$/u.test(leaseEpoch)
    || !Number.isSafeInteger(Number(leaseEpoch))) {
    return Object.freeze({ ok: false, code: 'authoring_claim_required' })
  }
  return Object.freeze({
    ok: true,
    headers: Object.freeze({
      'x-authoring-semantic-scope': semanticScope,
      'x-authoring-claim-id': claimId,
      'x-authoring-lease-epoch': leaseEpoch,
      'x-authoring-fence-revision': fenceRevision,
    }),
  })
}
