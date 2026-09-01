import { isRecord } from '../shared/http.ts'

export const PRODUCTION_DELIVERY_HOST = 'airvio.co'
export const PRODUCTION_DELIVERY_PATH = '/agentic-commerce-os'
export const ROUTE_LIVE_READINESS_CONTRACT = 'commerce.edge-route-live-readiness/v1'

export type RouteLiveReadinessReason =
  | 'core_readiness_unavailable'
  | 'core_release_metadata_mismatch'
  | 'core_source_not_ready'
  | 'delivery_route_request_mismatch'
  | 'delivery_route_unauthorized_in_dev'
  | 'delivery_route_unauthorized_outside_production'
  | 'edge_configuration_invalid'
  | 'edge_release_metadata_mismatch'

export type RouteLiveReadiness = Readonly<{
  ok: boolean
  contract: typeof ROUTE_LIVE_READINESS_CONTRACT
  reason: RouteLiveReadinessReason | null
  servingCandidateSha: string | null
  edgeVersion: WorkerVersionMetadata | null
  coreVersion: WorkerVersionMetadata | null
}>

export type EdgeReleaseIdentity = Readonly<{
  lane: string
  releaseCandidateSha: string
  version: unknown
  configurationOk: boolean
}>

export type CoreReadinessProbe = Readonly<{
  status: number
  payload: unknown
}>

export type CoreReadinessFetcher = (
  path: '/internal/readyz' | '/internal/livez',
) => Promise<CoreReadinessProbe>

export async function observeProductionRouteReadiness(
  request: Request,
  edge: EdgeReleaseIdentity,
  fetchCore: CoreReadinessFetcher,
): Promise<RouteLiveReadiness> {
  if (edge.lane.toLowerCase() === 'dev') {
    return refused('delivery_route_unauthorized_in_dev')
  }
  if (edge.lane.toLowerCase() !== 'production') {
    return refused('delivery_route_unauthorized_outside_production')
  }
  if (!isExactProductionDeliveryRequest(request)) {
    return refused('delivery_route_request_mismatch')
  }
  if (!edge.configurationOk) return refused('edge_configuration_invalid')
  const edgeVersion = readVersion(edge.version)
  if (!validCandidate(edge.releaseCandidateSha)
    || !edgeVersion
    || edgeVersion.tag !== edge.releaseCandidateSha) {
    return refused('edge_release_metadata_mismatch')
  }

  let coreReadiness: CoreReadinessProbe
  let coreLive: CoreReadinessProbe
  try {
    [coreReadiness, coreLive] = await Promise.all([
      fetchCore('/internal/readyz'),
      fetchCore('/internal/livez'),
    ])
  } catch {
    return refused('core_readiness_unavailable')
  }
  const readiness = readCoreReadiness(coreReadiness, edge.releaseCandidateSha)
  if (readiness.kind === 'source-failed') return refused('core_source_not_ready')
  if (readiness.kind !== 'accepted') return refused('core_release_metadata_mismatch')
  const liveVersion = readCoreLive(coreLive, edge.releaseCandidateSha)
  if (!liveVersion || !sameVersion(readiness.version, liveVersion)) {
    return refused('core_release_metadata_mismatch')
  }
  return Object.freeze({
    ok: true,
    contract: ROUTE_LIVE_READINESS_CONTRACT,
    reason: null,
    servingCandidateSha: edge.releaseCandidateSha,
    edgeVersion,
    coreVersion: liveVersion,
  })
}

export function attachRouteReadinessHeaders(response: Response, readiness: RouteLiveReadiness): Response {
  response.headers.set('cache-control', 'no-store')
  response.headers.set('x-commerce-live-readiness-contract', readiness.contract)
  response.headers.set('x-commerce-live-readiness', readiness.ok ? 'ready' : 'not-ready')
  response.headers.set('x-commerce-live-readiness-reason', readiness.reason ?? 'none')
  if (readiness.servingCandidateSha) {
    response.headers.set('x-commerce-release-candidate', readiness.servingCandidateSha)
  }
  if (readiness.edgeVersion) response.headers.set('x-commerce-edge-version-id', readiness.edgeVersion.id)
  if (readiness.coreVersion) response.headers.set('x-commerce-core-version-id', readiness.coreVersion.id)
  return response
}

export function isExactProductionDeliveryRequest(request: Request): boolean {
  const url = new URL(request.url)
  return request.method === 'GET'
    && url.protocol === 'https:'
    && url.hostname === PRODUCTION_DELIVERY_HOST
    && url.port === ''
    && url.pathname === PRODUCTION_DELIVERY_PATH
    && url.search === ''
    && url.username === ''
    && url.password === ''
}

function readCoreReadiness(
  probe: CoreReadinessProbe,
  expectedCandidate: string,
): Readonly<{ kind: 'accepted'; version: WorkerVersionMetadata }>
  | Readonly<{ kind: 'source-failed' | 'invalid' }> {
  const value = probe.payload
  if (!isRecord(value)
    || value.contract !== 'commerce.core-readiness/v2'
    || value.lane !== 'Production'
    || value.releaseCandidateSha !== expectedCandidate) return Object.freeze({ kind: 'invalid' })
  const version = readVersion(value.version)
  if (!version || version.tag !== expectedCandidate) return Object.freeze({ kind: 'invalid' })
  if (!isRecord(value.sourceReadiness) || value.sourceReadiness.ok !== true) {
    return Object.freeze({ kind: 'source-failed' })
  }
  if (!coreStatusReflectsOnlyRouteUnknown(probe.status, value)) return Object.freeze({ kind: 'invalid' })
  return Object.freeze({ kind: 'accepted', version })
}

function coreStatusReflectsOnlyRouteUnknown(status: number, value: Record<string, unknown>): boolean {
  if (status === 200 && value.ok === true) {
    return isRecord(value.liveReleaseReadiness) && value.liveReleaseReadiness.ok === true
  }
  return status === 503
    && value.ok === false
    && isRecord(value.liveReleaseReadiness)
    && value.liveReleaseReadiness.ok === false
    && value.liveReleaseReadiness.reason === 'delivery_route_live_unknown'
    && value.liveReleaseReadiness.servingCandidateSha === null
}

function readCoreLive(probe: CoreReadinessProbe, expectedCandidate: string): WorkerVersionMetadata | null {
  const value = probe.payload
  if (probe.status !== 200
    || !isRecord(value)
    || value.ok !== true
    || value.contract !== 'commerce.core-live/v1'
    || value.lane !== 'Production'
    || value.releaseCandidateSha !== expectedCandidate) return null
  const version = readVersion(value.version)
  return version?.tag === expectedCandidate ? version : null
}

function readVersion(value: unknown): WorkerVersionMetadata | null {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'id,tag,timestamp'
    || typeof value.id !== 'string'
    || value.id.length < 1
    || value.id.length > 128
    || typeof value.tag !== 'string'
    || typeof value.timestamp !== 'string'
    || !Number.isFinite(Date.parse(value.timestamp))) return null
  return Object.freeze({ id: value.id, tag: value.tag, timestamp: value.timestamp })
}

function sameVersion(left: WorkerVersionMetadata, right: WorkerVersionMetadata): boolean {
  return left.id === right.id && left.tag === right.tag && left.timestamp === right.timestamp
}

function validCandidate(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value)
}

function refused(reason: RouteLiveReadinessReason): RouteLiveReadiness {
  return Object.freeze({
    ok: false,
    contract: ROUTE_LIVE_READINESS_CONTRACT,
    reason,
    servingCandidateSha: null,
    edgeVersion: null,
    coreVersion: null,
  })
}
