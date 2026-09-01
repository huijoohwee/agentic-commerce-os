import { fileURLToPath } from 'node:url'

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const MAXIMUM_AUTHORIZATION_AGE_MS = 24 * 60 * 60 * 1_000

export type ReleaseTarget = 'prod-mirror' | 'delivery-route'
export type CandidateState = Readonly<{
  candidateSha: string
  frontierSha: string
  status: 'sealed' | 'retired'
  sealedAtMs: number
}>
export type RollbackDisposition = Readonly<{
  priorCandidateSha: string
  restoreAction: string
}>
export type ReleaseAuthorization = Readonly<{
  candidateSha: string
  target: ReleaseTarget
  humanIdentity: string
  authorizedAtMs: number
  rollbackDisposition: RollbackDisposition
}>
export type AuthorizationRequest = Readonly<{
  candidate: CandidateState
  authorization: ReleaseAuthorization
}>
export type ControllerVerdict =
  | Readonly<{
    ok: true
    advanced: ReleaseTarget
    candidateSha: string
    authorizationOnly: true
  }>
  | Readonly<{
    ok: false
    code: 'release_authorization_incomplete'
    missingElement: string
    requestedCandidateSha: string | null
    requestedTarget: string | null
  }>
  | Readonly<{
    ok: false
    code: 'release_candidate_retired'
    candidateSha: string
    frontierSha: string
  }>
  | Readonly<{
    ok: false
    code: 'release_rollback_disposition_required'
    candidateSha: string
  }>

export type SealResult =
  | Readonly<{ ok: true; candidate: CandidateState }>
  | Readonly<{ ok: false; code: 'release_candidate_invalid'; candidateSha: string }>

export function sealCandidate(
  sha: string,
  frontierSha: string,
  sealedAtMs = Date.now(),
): SealResult {
  if (!SHA_PATTERN.test(sha) || !SHA_PATTERN.test(frontierSha) || sha !== frontierSha) {
    return Object.freeze({ ok: false, code: 'release_candidate_invalid', candidateSha: sha })
  }
  return Object.freeze({
    ok: true,
    candidate: Object.freeze({ candidateSha: sha, frontierSha, status: 'sealed', sealedAtMs }),
  })
}

export function retireOnFrontierAdvance(
  frontierSha: string,
  candidates: readonly CandidateState[] = [],
): readonly string[] {
  if (!SHA_PATTERN.test(frontierSha)) return Object.freeze([])
  return Object.freeze(candidates
    .filter((candidate) => candidate.status === 'sealed' && candidate.candidateSha !== frontierSha)
    .map((candidate) => candidate.candidateSha)
    .sort())
}

export async function authorizeAndAdvance(
  request: unknown,
  nowMs = Date.now(),
): Promise<ControllerVerdict> {
  const record = asRecord(request)
  const candidate = asRecord(record?.candidate)
  const authorization = asRecord(record?.authorization)
  const requestedCandidateSha = textOrNull(authorization?.candidateSha)
    ?? textOrNull(candidate?.candidateSha)
  const requestedTarget = textOrNull(authorization?.target)

  const missing = firstMissingAuthorizationElement(candidate, authorization, nowMs)
  if (missing) {
    return Object.freeze({
      ok: false,
      code: 'release_authorization_incomplete',
      missingElement: missing,
      requestedCandidateSha,
      requestedTarget,
    })
  }

  const candidateSha = authorization?.candidateSha as string
  const frontierSha = candidate?.frontierSha as string
  if (candidate?.status === 'retired'
    || candidate?.candidateSha !== frontierSha
    || candidateSha !== frontierSha) {
    return Object.freeze({
      ok: false,
      code: 'release_candidate_retired',
      candidateSha,
      frontierSha,
    })
  }

  const rollback = asRecord(authorization?.rollbackDisposition)
  if (!rollback
    || !SHA_PATTERN.test(String(rollback.priorCandidateSha ?? ''))
    || !boundedText(rollback.restoreAction)) {
    return Object.freeze({
      ok: false,
      code: 'release_rollback_disposition_required',
      candidateSha,
    })
  }

  return Object.freeze({
    ok: true,
    advanced: authorization?.target as ReleaseTarget,
    candidateSha,
    authorizationOnly: true,
  })
}

function firstMissingAuthorizationElement(
  candidate: Readonly<Record<string, unknown>> | null,
  authorization: Readonly<Record<string, unknown>> | null,
  nowMs: number,
): string | null {
  if (!candidate) return 'candidate'
  if (!authorization) return 'authorization'
  if (!SHA_PATTERN.test(String(candidate.candidateSha ?? ''))) return 'candidate.candidateSha'
  if (!SHA_PATTERN.test(String(candidate.frontierSha ?? ''))) return 'candidate.frontierSha'
  if (candidate.status !== 'sealed' && candidate.status !== 'retired') return 'candidate.status'
  if (!SHA_PATTERN.test(String(authorization.candidateSha ?? ''))) return 'candidateSha'
  if (authorization.target !== 'prod-mirror' && authorization.target !== 'delivery-route') return 'target'
  if (!boundedText(authorization.humanIdentity)) return 'humanIdentity'
  if (!Number.isSafeInteger(authorization.authorizedAtMs)) return 'authorizedAtMs'
  const age = nowMs - Number(authorization.authorizedAtMs)
  if (age < 0 || age > MAXIMUM_AUTHORIZATION_AGE_MS) return 'authorizedAtMs'
  return null
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 280
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command !== 'guard') {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'unsupported_controller_command' })}\n`)
    process.exitCode = 2
    return
  }
  const targetArgument = arguments_.find((value) => value.startsWith('--target='))?.slice(9)
  const target = targetArgument === 'prod-mirror' || targetArgument === 'delivery-route'
    ? targetArgument
    : null
  if (arguments_.includes('--dry-run') && target !== null) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      code: 'non_mutating_bundle_authorized',
      target,
      authorizationOnly: true,
      deploymentPerformed: false,
    })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: 'release_external_authority_required',
    target,
    requiredExternalContract: 'controller-issued-lease-fence-cas/v1',
    deploymentPerformed: false,
  })}\n`)
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
