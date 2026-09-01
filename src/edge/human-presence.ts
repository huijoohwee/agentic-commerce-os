import { canonicalJson, sha256Hex } from '../shared/digest'
import { isRecord } from '../shared/http'

export const HUMAN_PRESENCE_RECEIPT_SCHEMA = 'agentic-graph-human-presence-receipt/v2'
export const HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA = 'agentic-graph-human-presence-trust-anchor/v1'
export const HUMAN_PRESENCE_AUDIENCE = 'agentic-graph-commerce-checkout'

const MAXIMUM_PRESENCE_AGE_MS = 2 * 60 * 1_000
const MAXIMUM_CLOCK_SKEW_MS = 30 * 1_000
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export type HumanPresenceTrustAnchor = Readonly<{
  schema: typeof HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA
  issuer: string
  publicKeySpkiBase64: string
}>

export type HumanPresenceExpectation = Readonly<{
  audience: typeof HUMAN_PRESENCE_AUDIENCE
  relyingPartyOrigin: string
  challenge: string
  checkoutId: string
  offerId: string
  amountMinor: number
  currency: string
  blockerDigest: string
  sessionNonceDigest: string
  expectedShopperPrincipalDigest: string | null
}>

export type HumanPresenceReceipt = Readonly<{
  schema: typeof HUMAN_PRESENCE_RECEIPT_SCHEMA
  issuer: string
  audience: typeof HUMAN_PRESENCE_AUDIENCE
  relyingPartyOrigin: string
  shopperPrincipalDigest: string
  sessionNonceDigest: string
  challenge: string
  checkoutId: string
  offerId: string
  amountMinor: number
  currency: string
  blockerDigest: string
  confirmedAtMs: number
  expiresAtMs: number
  nonce: string
  signature: string
}>

export type HumanPresenceVerdict =
  | Readonly<{ ok: true; shopperPrincipalDigest: string }>
  | Readonly<{ ok: false; code: 'human_presence_receipt_invalid' | 'human_presence_receipt_expired' }>

export function readHumanPresenceTrustAnchor(value: unknown): HumanPresenceTrustAnchor | null {
  if (typeof value !== 'string' || value.length > 8_192) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)
      || Object.keys(parsed).sort().join(',') !== 'issuer,publicKeySpkiBase64,schema'
      || parsed.schema !== HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA
      || typeof parsed.issuer !== 'string'
      || !IDENTIFIER_PATTERN.test(parsed.issuer)
      || typeof parsed.publicKeySpkiBase64 !== 'string'
      || !BASE64_PATTERN.test(parsed.publicKeySpkiBase64)
      || !validEd25519Spki(decodeBase64(parsed.publicKeySpkiBase64))) return null
    return Object.freeze({
      schema: HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA,
      issuer: parsed.issuer,
      publicKeySpkiBase64: parsed.publicKeySpkiBase64,
    })
  } catch {
    return null
  }
}

export async function verifyHumanPresenceReceipt(
  candidate: unknown,
  anchor: HumanPresenceTrustAnchor,
  expected: HumanPresenceExpectation,
  nowMs = Date.now(),
): Promise<HumanPresenceVerdict> {
  const receipt = readReceipt(candidate)
  if (!receipt
    || receipt.issuer !== anchor.issuer
    || receipt.audience !== expected.audience
    || receipt.relyingPartyOrigin !== expected.relyingPartyOrigin
    || receipt.challenge !== expected.challenge
    || receipt.checkoutId !== expected.checkoutId
    || receipt.offerId !== expected.offerId
    || receipt.amountMinor !== expected.amountMinor
    || receipt.currency !== expected.currency
    || receipt.blockerDigest !== expected.blockerDigest
    || receipt.sessionNonceDigest !== expected.sessionNonceDigest
    || (expected.expectedShopperPrincipalDigest !== null
      && receipt.shopperPrincipalDigest !== expected.expectedShopperPrincipalDigest)) return invalid()
  if (receipt.confirmedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS
    || receipt.confirmedAtMs < nowMs - MAXIMUM_PRESENCE_AGE_MS
    || receipt.expiresAtMs <= nowMs
    || receipt.expiresAtMs > receipt.confirmedAtMs + MAXIMUM_PRESENCE_AGE_MS) {
    return Object.freeze({ ok: false, code: 'human_presence_receipt_expired' })
  }
  try {
    const keyBytes = decodeBase64(anchor.publicKeySpkiBase64)
    const key = await crypto.subtle.importKey(
      'spki',
      copiedBuffer(keyBytes),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    const verified = await crypto.subtle.verify(
      'Ed25519',
      key,
      copiedBuffer(decodeBase64Url(receipt.signature)),
      new TextEncoder().encode(canonicalJson(unsignedReceipt(receipt))),
    )
    return verified
      ? Object.freeze({ ok: true, shopperPrincipalDigest: receipt.shopperPrincipalDigest })
      : invalid()
  } catch {
    return invalid()
  }
}

export async function sessionNonceDigest(sessionNonce: string): Promise<string> {
  return sha256Hex(sessionNonce)
}

export function createHumanPresenceChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return encodeBase64Url(bytes)
}

function readReceipt(value: unknown): HumanPresenceReceipt | null {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'amountMinor,audience,blockerDigest,challenge,checkoutId,confirmedAtMs,currency,expiresAtMs,issuer,nonce,offerId,relyingPartyOrigin,schema,sessionNonceDigest,shopperPrincipalDigest,signature'
    || value.schema !== HUMAN_PRESENCE_RECEIPT_SCHEMA
    || typeof value.issuer !== 'string'
    || !IDENTIFIER_PATTERN.test(value.issuer)
    || value.audience !== HUMAN_PRESENCE_AUDIENCE
    || typeof value.relyingPartyOrigin !== 'string'
    || !validRelyingPartyOrigin(value.relyingPartyOrigin)
    || typeof value.shopperPrincipalDigest !== 'string'
    || !DIGEST_PATTERN.test(value.shopperPrincipalDigest)
    || typeof value.sessionNonceDigest !== 'string'
    || !DIGEST_PATTERN.test(value.sessionNonceDigest)
    || typeof value.challenge !== 'string'
    || !BASE64URL_PATTERN.test(value.challenge)
    || typeof value.checkoutId !== 'string'
    || !IDENTIFIER_PATTERN.test(value.checkoutId)
    || typeof value.offerId !== 'string'
    || !IDENTIFIER_PATTERN.test(value.offerId)
    || !Number.isSafeInteger(value.amountMinor)
    || Number(value.amountMinor) <= 0
    || typeof value.currency !== 'string'
    || !/^[A-Z]{3}$/u.test(value.currency)
    || typeof value.blockerDigest !== 'string'
    || !DIGEST_PATTERN.test(value.blockerDigest)
    || !Number.isSafeInteger(value.confirmedAtMs)
    || !Number.isSafeInteger(value.expiresAtMs)
    || typeof value.nonce !== 'string'
    || !IDENTIFIER_PATTERN.test(value.nonce)
    || typeof value.signature !== 'string'
    || value.signature.length > 256
    || !/^[A-Za-z0-9_-]+$/u.test(value.signature)) return null
  return Object.freeze({
    schema: HUMAN_PRESENCE_RECEIPT_SCHEMA,
    issuer: value.issuer,
    audience: HUMAN_PRESENCE_AUDIENCE,
    relyingPartyOrigin: value.relyingPartyOrigin,
    shopperPrincipalDigest: value.shopperPrincipalDigest,
    sessionNonceDigest: value.sessionNonceDigest,
    challenge: value.challenge,
    checkoutId: value.checkoutId,
    offerId: value.offerId,
    amountMinor: Number(value.amountMinor),
    currency: value.currency,
    blockerDigest: value.blockerDigest,
    confirmedAtMs: Number(value.confirmedAtMs),
    expiresAtMs: Number(value.expiresAtMs),
    nonce: value.nonce,
    signature: value.signature,
  })
}

function validRelyingPartyOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.origin === value && parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function unsignedReceipt(receipt: HumanPresenceReceipt): Omit<HumanPresenceReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt
  return unsigned
}

function invalid(): HumanPresenceVerdict {
  return Object.freeze({ ok: false, code: 'human_presence_receipt_invalid' })
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  return decodeBase64(padded)
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function validEd25519Spki(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 44) return false
  const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]
  return prefix.every((byte, index) => bytes[index] === byte)
}
