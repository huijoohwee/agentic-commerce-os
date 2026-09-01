import { describe, expect, it } from 'vitest'

import {
  HUMAN_PRESENCE_RECEIPT_SCHEMA,
  HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA,
  HUMAN_PRESENCE_AUDIENCE,
  readHumanPresenceTrustAnchor,
  verifyHumanPresenceReceipt,
} from '../../src/edge/human-presence'
import { canonicalJson } from '../../src/shared/digest'

describe('external human-presence receipt', () => {
  it('accepts only a fresh signature bound to the exact shopper session and checkout facts', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const anchor = readHumanPresenceTrustAnchor(JSON.stringify({
      schema: HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA,
      issuer: 'shopper-presence-fixture',
      publicKeySpkiBase64: base64(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))),
    }))
    expect(anchor).not.toBeNull()
    if (!anchor) throw new Error('test_anchor_invalid')
    const nowMs = Date.UTC(2026, 7, 30)
    const expected = Object.freeze({
      audience: HUMAN_PRESENCE_AUDIENCE,
      relyingPartyOrigin: 'https://airvio.co',
      challenge: base64Url(crypto.getRandomValues(new Uint8Array(32))),
      checkoutId: 'checkout-1',
      offerId: 'offer-1',
      amountMinor: 1_250,
      currency: 'USD',
      blockerDigest: 'a'.repeat(64),
      sessionNonceDigest: 'b'.repeat(64),
      expectedShopperPrincipalDigest: 'c'.repeat(64),
    })
    const unsigned = Object.freeze({
      schema: HUMAN_PRESENCE_RECEIPT_SCHEMA,
      issuer: anchor.issuer,
      audience: expected.audience,
      relyingPartyOrigin: expected.relyingPartyOrigin,
      shopperPrincipalDigest: expected.expectedShopperPrincipalDigest,
      sessionNonceDigest: expected.sessionNonceDigest,
      challenge: expected.challenge,
      checkoutId: expected.checkoutId,
      offerId: expected.offerId,
      amountMinor: expected.amountMinor,
      currency: expected.currency,
      blockerDigest: expected.blockerDigest,
      confirmedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: crypto.randomUUID(),
    })
    const signature = await crypto.subtle.sign(
      'Ed25519', keys.privateKey, new TextEncoder().encode(canonicalJson(unsigned)),
    )
    const receipt = Object.freeze({ ...unsigned, signature: base64Url(new Uint8Array(signature)) })

    await expect(verifyHumanPresenceReceipt(receipt, anchor, expected, nowMs)).resolves.toEqual({
      ok: true,
      shopperPrincipalDigest: expected.expectedShopperPrincipalDigest,
    })
    await expect(verifyHumanPresenceReceipt(
      receipt, anchor, { ...expected, currency: 'JPY' }, nowMs,
    )).resolves.toEqual({ ok: false, code: 'human_presence_receipt_invalid' })
    await expect(verifyHumanPresenceReceipt(
      { ...receipt, amountMinor: 1_251 }, anchor, expected, nowMs,
    )).resolves.toEqual({ ok: false, code: 'human_presence_receipt_invalid' })
    await expect(verifyHumanPresenceReceipt(
      receipt, anchor, { ...expected, relyingPartyOrigin: 'https://merchant.example' }, nowMs,
    )).resolves.toEqual({ ok: false, code: 'human_presence_receipt_invalid' })
    await expect(verifyHumanPresenceReceipt(
      receipt, anchor, expected, nowMs + 180_000,
    )).resolves.toEqual({ ok: false, code: 'human_presence_receipt_expired' })
  })
})

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}
