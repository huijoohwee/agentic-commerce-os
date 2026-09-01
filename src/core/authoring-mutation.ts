import {
  authoringMutationOperationId,
  authoringMutationRequestDigest,
  readClaimMutationPermit,
  type ClaimMutationPermit,
  type ClaimMutationRequest,
  type MutationClaimBinding,
} from '../domain/authoring-claim-policy.js'
import { isRecord } from '../shared/http.js'
import { authoringClaimStub } from './core-clients.js'
import { reject, respond, resultOk } from './core-http-utils.js'

export type ReservedOperatorMutation = Readonly<{
  permit: ClaimMutationPermit
  finish: () => Promise<boolean>
}>

export type OperatorMutationReservation =
  | Readonly<{ ok: true; reservation: ReservedOperatorMutation }>
  | Readonly<{ ok: false; response: Response }>

export async function admitOperatorMutation(
  request: Request,
  env: CoreEnv,
  requestId: string,
  expected: MutationClaimBinding,
): Promise<Response | null> {
  const claimRequest = readOperatorClaimRequest(request, expected)
  if (!claimRequest.ok) return respond(reject(claimRequest.code), requestId, 409)
  const result = await authoringClaimStub(env, expected.semanticScope).admitMutation(claimRequest.request)
  return resultOk(result) ? null : respond(result, requestId, 409)
}

export async function reserveOperatorMutation(
  request: Request,
  env: CoreEnv,
  requestId: string,
  expected: MutationClaimBinding,
  operation: unknown,
): Promise<OperatorMutationReservation> {
  const claimRequest = readOperatorClaimRequest(request, expected)
  if (!claimRequest.ok) {
    return Object.freeze({ ok: false, response: respond(reject(claimRequest.code), requestId, 409) })
  }
  const requestDigest = await authoringMutationRequestDigest(expected, operation)
  const operationId = authoringMutationOperationId(requestDigest)
  if (!operationId) {
    return Object.freeze({
      ok: false,
      response: respond(reject('authoring_mutation_operation_invalid'), requestId, 503),
    })
  }
  const coordinator = authoringClaimStub(env, expected.semanticScope)
  const result = await coordinator.beginMutation(claimRequest.request, operationId, requestDigest)
  if (!isRecord(result) || result.ok !== true || !('permit' in result)) {
    return Object.freeze({ ok: false, response: respond(result, requestId, 409) })
  }
  const permit = readClaimMutationPermit(result.permit)
  if (!permit) {
    return Object.freeze({ ok: false, response: respond(reject('authoring_mutation_permit_invalid'), requestId, 503) })
  }
  let finished = false
  return Object.freeze({
    ok: true,
    reservation: Object.freeze({
      permit,
      async finish() {
        if (finished) return true
        try {
          const completion = await coordinator.completeMutation(permit)
          finished = isRecord(completion) && completion.ok === true
        } catch {
          finished = false
        }
        return finished
      },
    }),
  })
}

function readOperatorClaimRequest(
  request: Request,
  expected: MutationClaimBinding,
): Readonly<{ ok: true; request: ClaimMutationRequest }> | Readonly<{ ok: false; code: string }> {
  const claimedScope = request.headers.get('x-authoring-semantic-scope') ?? ''
  const claimId = request.headers.get('x-authoring-claim-id') ?? ''
  const leaseEpoch = readPositiveInteger(request.headers.get('x-authoring-lease-epoch'))
  const fenceRevision = request.headers.get('x-authoring-fence-revision') ?? ''
  if (!claimedScope || !claimId || leaseEpoch === null || !fenceRevision) {
    return Object.freeze({ ok: false, code: 'authoring_claim_required' })
  }
  if (claimedScope !== expected.semanticScope) {
    return Object.freeze({ ok: false, code: 'authoring_claim_scope_mismatch' })
  }
  return Object.freeze({
    ok: true,
    request: Object.freeze({
      semanticScope: expected.semanticScope,
      claimId,
      leaseEpoch,
      fenceRevision,
      requiredWriteTarget: expected.writeTarget,
    }),
  })
}

function readPositiveInteger(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
