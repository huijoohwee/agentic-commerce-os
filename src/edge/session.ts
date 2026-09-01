import { constantTimeTextMatch } from '../shared/auth'
import { isRecord } from '../shared/http'

export const STOREFRONT_SESSION_COOKIE = '__Host-ag_session'
export const STOREFRONT_SESSION_TTL_SECONDS = 15 * 60
const SESSION_SCHEMA = 'agentic-graph-storefront-session/v1'
const MINIMUM_SESSION_SECRET_LENGTH = 32
const MAXIMUM_COOKIE_BYTES = 4_096

export type StorefrontSessionScope = 'storefront:read' | 'checkout:prepare'
export type StorefrontSession = Readonly<{
  schema: typeof SESSION_SCHEMA
  origin: string
  issuedAt: number
  expiresAt: number
  nonce: string
  scopes: readonly StorefrontSessionScope[]
}>

export type SessionAuthorization =
  | Readonly<{ ok: true; session: StorefrontSession }>
  | Readonly<{
    ok: false
    code: 'storefront_session_invalid' | 'storefront_session_expired' | 'storefront_session_scope_refused'
  }>

export type IssuedStorefrontSession = Readonly<{
  session: StorefrontSession
  cookie: string
}>

export async function issueStorefrontSession(
  request: Request,
  secret: unknown,
  nowMs = Date.now(),
  allowLoopback = false,
): Promise<IssuedStorefrontSession | null> {
  const origin = requestOrigin(request, allowLoopback)
  if (!origin || !validSecret(secret)) return null
  const issuedAt = Math.floor(nowMs / 1_000)
  const session: StorefrontSession = Object.freeze({
    schema: SESSION_SCHEMA,
    origin,
    issuedAt,
    expiresAt: issuedAt + STOREFRONT_SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID(),
    scopes: Object.freeze<StorefrontSessionScope[]>(['storefront:read', 'checkout:prepare']),
  })
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(session)))
  const signature = await sign(payload, secret)
  const value = `${payload}.${signature}`
  return Object.freeze({
    session,
    cookie: `${STOREFRONT_SESSION_COOKIE}=${value}; Max-Age=${STOREFRONT_SESSION_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`,
  })
}

export async function authorizeStorefrontSession(
  request: Request,
  secret: unknown,
  requiredScope: StorefrontSessionScope,
  nowMs = Date.now(),
  allowLoopback = false,
): Promise<SessionAuthorization> {
  if (!validSecret(secret)) return invalidSession()
  const token = readCookie(request.headers.get('cookie'), STOREFRONT_SESSION_COOKIE)
  if (!token || token.length > MAXIMUM_COOKIE_BYTES) return invalidSession()
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return invalidSession()
  const expected = await sign(payload, secret)
  if (!await constantTimeTextMatch(signature, expected)) return invalidSession()
  const session = decodeSession(payload, allowLoopback)
  const origin = requestOrigin(request, allowLoopback)
  if (!session || !origin || session.origin !== origin) return invalidSession()
  const nowSeconds = Math.floor(nowMs / 1_000)
  if (session.expiresAt <= nowSeconds || session.issuedAt > nowSeconds + 30) {
    return Object.freeze({ ok: false, code: 'storefront_session_expired' })
  }
  if (!session.scopes.includes(requiredScope)) {
    return Object.freeze({ ok: false, code: 'storefront_session_scope_refused' })
  }
  return Object.freeze({ ok: true, session })
}

export function validateStorefrontSessionSecret(secret: unknown): boolean {
  return validSecret(secret)
}

function decodeSession(payload: string, allowLoopback: boolean): StorefrontSession | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(payload)))
  } catch {
    return null
  }
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'expiresAt,issuedAt,nonce,origin,schema,scopes'
    || value.schema !== SESSION_SCHEMA
    || typeof value.origin !== 'string'
    || typeof value.nonce !== 'string'
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || Number(value.expiresAt) - Number(value.issuedAt) !== STOREFRONT_SESSION_TTL_SECONDS
    || !Array.isArray(value.scopes)
    || value.scopes.length !== 2
    || value.scopes[0] !== 'storefront:read'
    || value.scopes[1] !== 'checkout:prepare') return null
  try {
    const parsedOrigin = new URL(value.origin)
    const loopback = allowLoopback
      && parsedOrigin.protocol === 'http:'
      && isLoopback(parsedOrigin.hostname)
    if (parsedOrigin.origin !== value.origin || (parsedOrigin.protocol !== 'https:' && !loopback)) return null
  } catch {
    return null
  }
  return Object.freeze({
    schema: SESSION_SCHEMA,
    origin: value.origin,
    issuedAt: Number(value.issuedAt),
    expiresAt: Number(value.expiresAt),
    nonce: value.nonce,
    scopes: Object.freeze<StorefrontSessionScope[]>(['storefront:read', 'checkout:prepare']),
  })
}

function requestOrigin(request: Request, allowLoopback: boolean): string | null {
  const value = request.headers.get('origin')
  if (!value) return null
  try {
    const parsed = new URL(value)
    const loopback = allowLoopback && parsed.protocol === 'http:' && isLoopback(parsed.hostname)
    return parsed.origin === value && (parsed.protocol === 'https:' || loopback) ? parsed.origin : null
  } catch {
    return null
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return null
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )))
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('base64url_invalid')
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function validSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= MINIMUM_SESSION_SECRET_LENGTH
}

function invalidSession(): SessionAuthorization {
  return Object.freeze({ ok: false, code: 'storefront_session_invalid' })
}
