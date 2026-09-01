import { sha256Hex } from '../shared/digest.js'
import { isHttpFailure, isRecord, jsonResponse, readJsonObject } from '../shared/http.js'

export const PREVIEW_CONTRACT = 'agentic-graph-engagement-preview/v1'
export const MAXIMUM_PREVIEW_LIFETIME_HOURS = 24
const MAXIMUM_DATE_MS = 8_640_000_000_000_000

export type PreviewIdentity = Readonly<{
  previewId: string
  engagementId: string
  address: string
  createdAt: string
  expiresAt: string
}>

export type PreviewResolution =
  | Readonly<{ ok: true; contract: typeof PREVIEW_CONTRACT; identity: PreviewIdentity }>
  | Readonly<{
    ok: false
    contract: typeof PREVIEW_CONTRACT
    code: 'preview_revoked'
    previewId: string
  }>

export type PreviewRepository = Readonly<{
  save(identity: PreviewIdentity): Promise<void>
  read(previewId: string): Promise<unknown>
  delete(previewId: string): Promise<void>
}>

export async function previewIdentity(
  engagementId: string,
  lifetimeHours: number,
  nowMs = Date.now(),
): Promise<PreviewIdentity> {
  if (!validEngagementId(engagementId)
    || !Number.isInteger(lifetimeHours)
    || lifetimeHours < 1
    || lifetimeHours > MAXIMUM_PREVIEW_LIFETIME_HOURS
    || !Number.isSafeInteger(nowMs)
    || nowMs < 0
    || nowMs > MAXIMUM_DATE_MS - MAXIMUM_PREVIEW_LIFETIME_HOURS * 60 * 60 * 1_000) {
    throw new Error('preview_identity_invalid')
  }
  const expiresAtMs = nowMs + lifetimeHours * 60 * 60 * 1_000
  const previewId = (await sha256Hex(`preview:${engagementId}`)).slice(0, 32)
  return Object.freeze({
    previewId,
    engagementId,
    address: `/preview/${previewId}`,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  })
}

export function resolvePreview(identity: PreviewIdentity, nowMs = Date.now()): PreviewResolution {
  return nowMs < Date.parse(identity.expiresAt)
    ? Object.freeze({ ok: true, contract: PREVIEW_CONTRACT, identity })
    : revoked(identity.previewId)
}

export async function resolveStoredPreview(
  repository: PreviewRepository,
  previewId: string,
  nowMs = Date.now(),
): Promise<PreviewResolution> {
  if (!validPreviewId(previewId)) return revoked(previewId)
  const stored = await repository.read(previewId)
  const identity = readPreviewIdentity(stored)
  if (!identity || identity.previewId !== previewId) {
    if (stored !== undefined && stored !== null) await repository.delete(previewId)
    return revoked(previewId)
  }
  const resolution = resolvePreview(identity, nowMs)
  if (!resolution.ok) await repository.delete(previewId)
  return resolution
}

export async function handlePreviewRequest(
  request: Request,
  repository: PreviewRepository,
  nowMs = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/v1/previews') {
    const body = await readJsonObject(request, 1_024)
    if (isHttpFailure(body)) return jsonResponse(body, 400)
    if (Object.keys(body).sort().join(',') !== 'engagementId,lifetimeHours'
      || typeof body.engagementId !== 'string'
      || !Number.isInteger(body.lifetimeHours)) {
      return jsonResponse({ ok: false, code: 'preview_request_invalid' }, 400)
    }
    let identity: PreviewIdentity
    try {
      identity = await previewIdentity(body.engagementId, Number(body.lifetimeHours), nowMs)
    } catch {
      return jsonResponse({ ok: false, code: 'preview_request_invalid' }, 400)
    }
    try {
      await repository.save(identity)
    } catch {
      return jsonResponse({
        ok: false,
        code: 'sandbox_blocked',
        reason: 'preview_persistence_failed',
        rung: 'dev-proven',
      }, 503)
    }
    return jsonResponse({ ok: true, contract: PREVIEW_CONTRACT, identity }, 201)
  }

  const previewId = readAddressedPreviewId(url.pathname)
  if (request.method !== 'GET' || previewId === null) return null
  try {
    const resolution = await resolveStoredPreview(repository, previewId, nowMs)
    return jsonResponse(resolution, resolution.ok ? 200 : 410)
  } catch {
    return jsonResponse({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'preview_persistence_failed',
      rung: 'dev-proven',
    }, 503)
  }
}

export function readPreviewIdentity(value: unknown): PreviewIdentity | null {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'address,createdAt,engagementId,expiresAt,previewId'
    || typeof value.previewId !== 'string'
    || !validPreviewId(value.previewId)
    || typeof value.engagementId !== 'string'
    || !validEngagementId(value.engagementId)
    || value.address !== `/preview/${value.previewId}`
    || typeof value.createdAt !== 'string'
    || typeof value.expiresAt !== 'string') return null
  const createdAtMs = Date.parse(value.createdAt)
  const expiresAtMs = Date.parse(value.expiresAt)
  if (!Number.isSafeInteger(createdAtMs)
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > MAXIMUM_PREVIEW_LIFETIME_HOURS * 60 * 60 * 1_000) return null
  return Object.freeze({
    previewId: value.previewId,
    engagementId: value.engagementId,
    address: value.address,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  })
}

function readAddressedPreviewId(pathname: string): string | null {
  const match = /^\/preview\/([0-9a-f]{32})$/u.exec(pathname)
  return match?.[1] ?? null
}

function validPreviewId(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value)
}

function validEngagementId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
}

function revoked(previewId: string): PreviewResolution {
  return Object.freeze({ ok: false, contract: PREVIEW_CONTRACT, code: 'preview_revoked', previewId })
}
