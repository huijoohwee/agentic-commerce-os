import { describe, expect, it } from 'vitest'

import {
  HUMAN_CONFIRMATION_COOKIE,
  authorizeHumanConfirmation,
  issueHumanConfirmation,
} from '../../src/edge/human-confirmation'
import { sha256Hex } from '../../src/shared/digest'

describe('visual human-confirmation proof', () => {
  it('binds the core token inside a short-lived HttpOnly proof and accepts no client token', async () => {
    const secret = crypto.randomUUID().repeat(2)
    const confirmationToken = crypto.randomUUID().repeat(2)
    const sessionNonce = crypto.randomUUID()
    const now = Date.UTC(2026, 7, 30)
    const request = new Request('https://airvio.co/v1/checkouts/checkout-1/prepare', {
      method: 'POST', headers: { origin: 'https://airvio.co' },
    })
    const issued = await issueHumanConfirmation(request, secret, {
      checkoutId: 'checkout-1', offerId: 'offer-1', amountMinor: 1_250, currency: 'USD',
    }, {
      ok: true,
      status: 'confirmation_required',
      checkoutId: 'checkout-1',
      confirmationToken,
      confirmationExpiresAt: now + 90_000,
    }, { sessionNonce, trustAnchor: null }, now)
    expect(issued).not.toBeNull()
    expect(issued?.cookie).toContain(`${HUMAN_CONFIRMATION_COOKIE}=`)
    expect(issued?.cookie).toContain('Path=/; Secure; HttpOnly; SameSite=Strict')
    expect(issued?.cookie).not.toContain(confirmationToken)
    expect(issued?.cookie).not.toContain(issued?.publicProof.csrfToken ?? 'missing-proof')
    expect(issued?.publicResult).not.toHaveProperty('confirmationToken')

    const cookie = issued?.cookie.split(';', 1)[0] ?? ''
    const proof = issued?.publicProof as Readonly<Record<string, unknown>> | undefined
    const body = {
      checkoutId: 'checkout-1', offerId: 'offer-1', amountMinor: 1_250, currency: 'USD',
      blockerDigest: proof?.blockerDigest,
    }
    const confirmation = new Request('https://airvio.co/v1/human/checkouts/checkout-1/confirm', {
      method: 'POST',
      headers: {
        origin: 'https://airvio.co',
        cookie,
        'x-human-confirmation-csrf': issued?.publicProof.csrfToken ?? '',
      },
    })
    const shopperPrincipalDigest = await sha256Hex(`development-visual-only:${sessionNonce}`)
    await expect(authorizeHumanConfirmation(
      confirmation, secret, sessionNonce, null, 'checkout-1', body, now + 1_000,
    )).resolves.toEqual({
      ok: true,
      body: { ...body, confirmationToken, shopperPrincipalDigest },
      reissue: {
        confirmationExpiresAt: expect.any(Number),
        expectedShopperPrincipalDigest: shopperPrincipalDigest,
      },
    })
    await expect(authorizeHumanConfirmation(confirmation, secret, sessionNonce, null, 'checkout-1', {
      ...body, confirmationToken,
    }, now + 1_000)).resolves.toEqual({ ok: false, code: 'human_confirmation_invalid' })
    await expect(authorizeHumanConfirmation(new Request(confirmation, {
      headers: { origin: 'https://airvio.co', cookie, 'x-human-confirmation-csrf': crypto.randomUUID() },
    }), secret, sessionNonce, null, 'checkout-1', body, now + 1_000)).resolves.toEqual({
      ok: false, code: 'human_confirmation_invalid',
    })
    await expect(authorizeHumanConfirmation(
      confirmation, secret, sessionNonce, null, 'checkout-1', body, now + 91_000,
    ))
      .resolves.toEqual({ ok: false, code: 'human_confirmation_expired' })
  })

  it('refuses issue when the core result cannot prove a current prepared checkout', async () => {
    const secret = crypto.randomUUID().repeat(2)
    const now = Date.UTC(2026, 7, 30)
    await expect(issueHumanConfirmation(new Request('https://airvio.co/v1/session', {
      headers: { origin: 'https://airvio.co' },
    }), secret, {
      checkoutId: 'checkout-1', offerId: 'offer-1', amountMinor: 1, currency: 'USD',
    }, {
      ok: true,
      status: 'confirmation_required',
      checkoutId: 'checkout-other',
      confirmationToken: crypto.randomUUID().repeat(2),
      confirmationExpiresAt: now + 60_000,
    }, { sessionNonce: crypto.randomUUID(), trustAnchor: null }, now)).resolves.toBeNull()
  })
})
