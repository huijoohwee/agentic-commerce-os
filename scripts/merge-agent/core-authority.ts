import { randomUUID } from 'node:crypto'

import { isRecord, readJsonResponse } from '../../src/shared/http.ts'
import type {
  LaneAuthorityObservation,
  LaneMutationAdmission,
  LaneMutationAdmissionRequest,
} from './evidence.ts'
import type {
  MergeOrchestrationDependencies,
  MergeOrchestrationLaneBinding,
} from './orchestrator.ts'
import type { CommandRunner } from './runner.ts'

const EDGE_CORE_CONTRACT = 'commerce.edge-core/v1'
const MAXIMUM_AUTHORITY_RESPONSE_BYTES = 65_536
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const ADMISSION_PATHS = new Set([
  '/v1/operator/claims/admit',
  '/internal/v1/operator/claims/admit',
])

export type CoreAuthorityFetch = (request: Request) => Promise<Response>

export type CoreAuthorityAdapterOptions = Readonly<{
  runner: CommandRunner
  lane: MergeOrchestrationLaneBinding
  coreAdmissionUrl: string
  operatorBearerToken: string
  releaseCandidateSha: string
  fetchAuthority?: CoreAuthorityFetch
  nowMs?: () => number
  circuitBreakerObserved?: () => Promise<boolean>
  requestTimeoutMs?: number
}>

export function createCoreAuthorityDependencies(
  options: CoreAuthorityAdapterOptions,
): MergeOrchestrationDependencies {
  const route = readRoute(options.coreAdmissionUrl)
  const bearer = readBearer(options.operatorBearerToken)
  const releaseCandidateSha = readRevision(options.releaseCandidateSha)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const readTarget = options.lane.declaredWriteSet[0]
  if (!route
    || !bearer
    || !releaseCandidateSha
    || !readTarget
    || !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1
    || requestTimeoutMs > 30_000) throw new Error('merge_agent_core_authority_configuration_invalid')
  const fetchAuthority = options.fetchAuthority ?? ((request: Request) => fetch(request))

  async function requestAdmission(request: LaneMutationAdmissionRequest): Promise<unknown> {
    try {
      const response = await fetchAuthority(new Request(route, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'x-commerce-contract': EDGE_CORE_CONTRACT,
          'x-commerce-release-candidate': releaseCandidateSha,
          'x-request-id': randomUUID(),
        },
        body: JSON.stringify({
          semanticScope: request.semanticScope,
          claimId: request.claimId,
          leaseEpoch: request.leaseEpoch,
          fenceRevision: request.fenceRevision,
          requiredWriteTarget: request.requiredWriteTarget,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      }))
      const payload = await readJsonResponse(response, MAXIMUM_AUTHORITY_RESPONSE_BYTES)
      return response.ok ? payload : refusal(payload)
    } catch {
      return Object.freeze({ ok: false, code: 'core_authority_unavailable' })
    }
  }

  return Object.freeze({
    runner: options.runner,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.circuitBreakerObserved ? { circuitBreakerObserved: options.circuitBreakerObserved } : {}),
    async readAuthority(): Promise<LaneAuthorityObservation> {
      const payload = await requestAdmission(admissionRequest(options.lane, readTarget, options.nowMs?.()))
      const authority = readAuthorityPayload(payload)
      if (!authority) throw new Error('merge_agent_core_authority_read_refused')
      return authority
    },
    async admitMutation(request: LaneMutationAdmissionRequest): Promise<LaneMutationAdmission> {
      const payload = await requestAdmission(request)
      const authority = readAuthorityPayload(payload)
      if (!authority
        || authority.semanticScope !== request.semanticScope
        || authority.claimId !== request.claimId
        || authority.leaseEpoch !== request.leaseEpoch
        || authority.fenceRevision !== request.fenceRevision
        || !authority.declaredWriteSet.includes(request.requiredWriteTarget)) {
        return refusal(payload)
      }
      return Object.freeze({ ok: true })
    },
  })
}

function admissionRequest(
  lane: MergeOrchestrationLaneBinding,
  requiredWriteTarget: string,
  nowMs = Date.now(),
): LaneMutationAdmissionRequest {
  return Object.freeze({
    semanticScope: lane.semanticScope,
    claimId: lane.claimId,
    leaseEpoch: lane.leaseEpoch,
    fenceRevision: lane.fenceRevision,
    requiredWriteTarget,
    nowMs,
  })
}

function readAuthorityPayload(payload: unknown): LaneAuthorityObservation | null {
  if (!isRecord(payload)
    || payload.ok !== true
    || typeof payload.semanticScope !== 'string'
    || typeof payload.claimId !== 'string'
    || typeof payload.actorId !== 'string'
    || typeof payload.worktree !== 'string'
    || typeof payload.branch !== 'string'
    || !Number.isSafeInteger(payload.leaseEpoch)
    || !Number.isSafeInteger(payload.leaseExpiresAtMs)
    || typeof payload.fenceRevision !== 'string'
    || !Array.isArray(payload.declaredWriteSet)
    || !payload.declaredWriteSet.every((entry) => typeof entry === 'string')) return null
  return Object.freeze({
    semanticScope: payload.semanticScope,
    claimId: payload.claimId,
    actorId: payload.actorId,
    worktree: payload.worktree,
    branch: payload.branch,
    leaseEpoch: Number(payload.leaseEpoch),
    leaseExpiresAtMs: Number(payload.leaseExpiresAtMs),
    fenceRevision: payload.fenceRevision,
    declaredWriteSet: Object.freeze([...payload.declaredWriteSet] as string[]),
  })
}

function refusal(payload: unknown): Readonly<{ ok: false; code: string }> {
  const code = isRecord(payload) && typeof payload.code === 'string' && /^[a-z][a-z0-9_]{0,127}$/u.test(payload.code)
    ? payload.code
    : 'core_authority_refused'
  return Object.freeze({ ok: false, code })
}

function readRoute(value: string): string | null {
  try {
    const url = new URL(value)
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return (url.protocol === 'https:' || localHttp)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && ADMISSION_PATHS.has(url.pathname)
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function readBearer(value: string): string | null {
  return value === value.trim()
    && value.length >= 32
    && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null
}

function readRevision(value: string): string | null {
  return /^[0-9a-f]{40}$/u.test(value) ? value : null
}
