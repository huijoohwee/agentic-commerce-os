import { constantTimeTextMatch } from '../shared/auth'
import { canonicalJson, sha256Hex } from '../shared/digest'
import { isRecord } from '../shared/http'
import {
  HUMAN_PRESENCE_AUDIENCE,
  createHumanPresenceChallenge,
  sessionNonceDigest,
  verifyHumanPresenceReceipt,
  type HumanPresenceTrustAnchor,
} from './human-presence'

export const HUMAN_CONFIRMATION_COOKIE = '__Host-ag_human_confirmation'
export const HUMAN_CONFIRMATION_TTL_SECONDS = 2 * 60

const PROOF_SCHEMA = 'agentic-graph-human-confirmation/v2'
const MINIMUM_SECRET_LENGTH = 32
const MAXIMUM_COOKIE_BYTES = 4_096
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CONFIRMATION_TOKEN_PATTERN = /^[\x21-\x7e]{64,128}$/u

type HumanConfirmationProof = Readonly<{
  schema: typeof PROOF_SCHEMA
  origin: string
  checkoutId: string
  offerId: string
  amountMinor: number
  currency: string
  blockerDigest: string
  expectedShopperPrincipalDigest: string | null
  sessionNonceDigest: string
  challenge: string
  confirmationToken: string
  csrfDigest: string
  issuedAt: number
  expiresAt: number
  nonce: string
}>

export type IssuedHumanConfirmation = Readonly<{
  cookie: string
  publicProof: Readonly<{ csrfToken: string; expiresAt: string }>
  publicResult: Readonly<Record<string, unknown>>
}>

export type HumanConfirmationAuthorization =
  | Readonly<{
    ok: true
    body: Readonly<{
      checkoutId: string
      confirmationToken: string
      offerId: string
      amountMinor: number
      currency: string
      blockerDigest: string
      shopperPrincipalDigest: string
    }>
    reissue: Readonly<{
      confirmationExpiresAt: number
      expectedShopperPrincipalDigest: string
    }>
  }>
  | Readonly<{ ok: false; code: 'human_confirmation_invalid' | 'human_confirmation_expired' }>

export type HumanConfirmationIssueContext = Readonly<{
  sessionNonce: string
  trustAnchor: HumanPresenceTrustAnchor | null
  blockerDigest?: string
  blockers?: readonly unknown[]
  expectedShopperPrincipalDigest?: string | null
}>

export async function issueHumanConfirmation(
  request: Request,
  secret: unknown,
  prepareInput: unknown,
  prepareResult: unknown,
  context: HumanConfirmationIssueContext,
  nowMs = Date.now(),
  allowLoopback = false,
): Promise<IssuedHumanConfirmation | null> {
  const origin = requestOrigin(request, allowLoopback)
  if (!origin
    || !validSecret(secret)
    || !validSessionNonce(context.sessionNonce)
    || !isRecord(prepareInput)
    || !isRecord(prepareResult)) return null
  const checkoutId = readIdentifier(prepareInput.checkoutId)
  const offerId = readIdentifier(prepareInput.offerId)
  const amountMinor = readPositiveInteger(prepareInput.amountMinor)
  const currency = readCurrency(prepareInput.currency)
  const confirmationToken = readConfirmationToken(prepareResult.confirmationToken)
  const coreExpiresAt = readFutureMilliseconds(prepareResult.confirmationExpiresAt, nowMs)
  const blockerDigest = context.blockerDigest ?? await sha256Hex(canonicalJson([]))
  const expectedShopperPrincipalDigest = context.expectedShopperPrincipalDigest ?? null
  if (!checkoutId || !offerId || !amountMinor || !currency || !confirmationToken || !coreExpiresAt
    || !isDigest(blockerDigest)
    || (expectedShopperPrincipalDigest !== null && !isDigest(expectedShopperPrincipalDigest))
    || prepareResult.ok !== true
    || prepareResult.status !== 'confirmation_required'
    || prepareResult.checkoutId !== checkoutId) return null

  const issuedAt = Math.floor(nowMs / 1_000)
  const expiresAt = Math.min(
    issuedAt + HUMAN_CONFIRMATION_TTL_SECONDS,
    Math.floor(coreExpiresAt / 1_000),
  )
  if (expiresAt <= issuedAt) return null
  const csrfToken = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const challenge = createHumanPresenceChallenge()
  const boundSessionNonceDigest = await sessionNonceDigest(context.sessionNonce)
  const proof: HumanConfirmationProof = Object.freeze({
    schema: PROOF_SCHEMA,
    origin,
    checkoutId,
    offerId,
    amountMinor,
    currency,
    blockerDigest,
    expectedShopperPrincipalDigest,
    sessionNonceDigest: boundSessionNonceDigest,
    challenge,
    confirmationToken,
    csrfDigest: await digest(csrfToken),
    issuedAt,
    expiresAt,
    nonce: crypto.randomUUID(),
  })
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(proof)))
  const value = `${payload}.${await sign(payload, secret)}`
  const maximumAge = expiresAt - issuedAt
  const publicProof = Object.freeze({
    csrfToken,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
    challenge,
    sessionNonceDigest: boundSessionNonceDigest,
    blockerDigest,
    audience: HUMAN_PRESENCE_AUDIENCE,
    relyingPartyOrigin: origin,
    blockers: Object.freeze([...(context.blockers ?? [])]),
    verificationMode: context.trustAnchor ? 'external-signed-user-presence' : 'development-visual-only',
    ...(context.trustAnchor ? { presenceIssuer: context.trustAnchor.issuer } : {}),
  })
  return Object.freeze({
    cookie: `${HUMAN_CONFIRMATION_COOKIE}=${value}; Max-Age=${maximumAge}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    publicProof,
    publicResult: Object.freeze({
      ok: true,
      status: 'confirmation_required',
      idempotent: prepareResult.idempotent === true,
      checkoutId,
      confirmationExpiresAt: coreExpiresAt,
      guardrailReceipt: prepareResult.guardrailReceipt ?? null,
      humanConfirmation: publicProof,
    }),
  })
}

export async function authorizeHumanConfirmation(
  request: Request,
  secret: unknown,
  sessionNonce: string,
  trustAnchor: HumanPresenceTrustAnchor | null,
  checkoutId: string,
  candidate: unknown,
  nowMs = Date.now(),
  allowLoopback = false,
): Promise<HumanConfirmationAuthorization> {
  if (!validSecret(secret)
    || !validSessionNonce(sessionNonce)
    || !isRecord(candidate)
    || !exactConfirmationFields(candidate)) return invalid()
  const token = readCookie(request.headers.get('cookie'), HUMAN_CONFIRMATION_COOKIE)
  if (!token || token.length > MAXIMUM_COOKIE_BYTES) return invalid()
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined
    || !await constantTimeTextMatch(signature, await sign(payload, secret))) return invalid()
  const proof = decodeProof(payload, allowLoopback)
  const origin = requestOrigin(request, allowLoopback)
  if (!proof
    || !origin
    || proof.origin !== origin
    || proof.checkoutId !== checkoutId
    || proof.sessionNonceDigest !== await sessionNonceDigest(sessionNonce)) return invalid()
  const nowSeconds = Math.floor(nowMs / 1_000)
  if (proof.expiresAt <= nowSeconds || proof.issuedAt > nowSeconds + 30) {
    return Object.freeze({ ok: false, code: 'human_confirmation_expired' })
  }

  const offerId = readIdentifier(candidate.offerId)
  const amountMinor = readPositiveInteger(candidate.amountMinor)
  const currency = readCurrency(candidate.currency)
  const blockerDigest = typeof candidate.blockerDigest === 'string' ? candidate.blockerDigest : ''
  const csrfToken = request.headers.get('x-human-confirmation-csrf') ?? ''
  if (!offerId || !amountMinor || !currency || !isDigest(blockerDigest)
    || candidate.checkoutId !== checkoutId
    || offerId !== proof.offerId
    || amountMinor !== proof.amountMinor
    || currency !== proof.currency
    || blockerDigest !== proof.blockerDigest
    || !await constantTimeTextMatch(await digest(csrfToken), proof.csrfDigest)) return invalid()
  let shopperPrincipalDigest: string
  if (trustAnchor) {
    const presence = await verifyHumanPresenceReceipt(candidate.presenceReceipt, trustAnchor, {
      audience: HUMAN_PRESENCE_AUDIENCE,
      relyingPartyOrigin: proof.origin,
      challenge: proof.challenge,
      checkoutId,
      offerId,
      amountMinor,
      currency,
      blockerDigest,
      sessionNonceDigest: proof.sessionNonceDigest,
      expectedShopperPrincipalDigest: proof.expectedShopperPrincipalDigest,
    }, nowMs)
    if (!presence.ok) return invalid()
    shopperPrincipalDigest = presence.shopperPrincipalDigest
  } else {
    if (candidate.presenceReceipt !== undefined) return invalid()
    shopperPrincipalDigest = await digest(`development-visual-only:${sessionNonce}`)
  }
  return Object.freeze({
    ok: true,
    body: Object.freeze({
      checkoutId,
      confirmationToken: proof.confirmationToken,
      offerId,
      amountMinor,
      currency,
      blockerDigest,
      shopperPrincipalDigest,
    }),
    reissue: Object.freeze({
      confirmationExpiresAt: proof.expiresAt * 1_000,
      expectedShopperPrincipalDigest: shopperPrincipalDigest,
    }),
  })
}

export function clearHumanConfirmationCookie(): string {
  return `${HUMAN_CONFIRMATION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`
}

function decodeProof(payload: string, allowLoopback: boolean): HumanConfirmationProof | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(payload)))
  } catch {
    return null
  }
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'amountMinor,blockerDigest,challenge,checkoutId,confirmationToken,csrfDigest,currency,expectedShopperPrincipalDigest,expiresAt,issuedAt,nonce,offerId,origin,schema,sessionNonceDigest'
    || value.schema !== PROOF_SCHEMA
    || !readIdentifier(value.checkoutId)
    || !readIdentifier(value.offerId)
    || !readPositiveInteger(value.amountMinor)
    || !readCurrency(value.currency)
    || typeof value.blockerDigest !== 'string'
    || !isDigest(value.blockerDigest)
    || (value.expectedShopperPrincipalDigest !== null
      && (typeof value.expectedShopperPrincipalDigest !== 'string'
        || !isDigest(value.expectedShopperPrincipalDigest)))
    || typeof value.sessionNonceDigest !== 'string'
    || !isDigest(value.sessionNonceDigest)
    || typeof value.challenge !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.challenge)
    || !readConfirmationToken(value.confirmationToken)
    || typeof value.csrfDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.csrfDigest)
    || typeof value.nonce !== 'string'
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || Number(value.expiresAt) <= Number(value.issuedAt)
    || Number(value.expiresAt) - Number(value.issuedAt) > HUMAN_CONFIRMATION_TTL_SECONDS
    || typeof value.origin !== 'string'
    || !validOrigin(value.origin, allowLoopback)) return null
  return Object.freeze({
    schema: PROOF_SCHEMA,
    origin: value.origin,
    checkoutId: String(value.checkoutId),
    offerId: String(value.offerId),
    amountMinor: Number(value.amountMinor),
    currency: String(value.currency),
    blockerDigest: value.blockerDigest,
    expectedShopperPrincipalDigest: value.expectedShopperPrincipalDigest,
    sessionNonceDigest: value.sessionNonceDigest,
    challenge: value.challenge,
    confirmationToken: String(value.confirmationToken),
    csrfDigest: value.csrfDigest,
    issuedAt: Number(value.issuedAt),
    expiresAt: Number(value.expiresAt),
    nonce: value.nonce,
  })
}

function exactConfirmationFields(value: Record<string, unknown>): boolean {
  const allowed = new Set([
    'amountMinor', 'blockerDigest', 'checkoutId', 'currency', 'offerId', 'presenceReceipt',
  ])
  return Object.keys(value).every((field) => allowed.has(field))
}

function requestOrigin(request: Request, allowLoopback: boolean): string | null {
  const value = request.headers.get('origin')
  return value && validOrigin(value, allowLoopback) ? value : null
}

function validOrigin(value: string, allowLoopback: boolean): boolean {
  try {
    const parsed = new URL(value)
    const loopback = allowLoopback && parsed.protocol === 'http:' && isLoopback(parsed.hostname)
    return parsed.origin === value && (parsed.protocol === 'https:' || loopback)
  } catch {
    return false
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return null
}

function readIdentifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : null
}

function readPositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function readCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/u.test(value) ? value : null
}

function readFutureMilliseconds(value: unknown, nowMs: number): number | null {
  return Number.isSafeInteger(value) && Number(value) > nowMs ? Number(value) : null
}

function readConfirmationToken(value: unknown): string | null {
  return typeof value === 'string' && CONFIRMATION_TOKEN_PATTERN.test(value) ? value : null
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
    'HMAC', key, new TextEncoder().encode(payload),
  )))
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('base64url_invalid')
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MINIMUM_SECRET_LENGTH
}

function validSessionNonce(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value)
}

function invalid(): HumanConfirmationAuthorization {
  return Object.freeze({ ok: false, code: 'human_confirmation_invalid' })
}
