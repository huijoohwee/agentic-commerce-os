import { describe, expect, it } from 'vitest'

import {
  STOREFRONT_SESSION_COOKIE,
  authorizeStorefrontSession,
  issueStorefrontSession,
} from '../../src/edge/session'

describe('first-party storefront sessions', () => {
  it('issues an HttpOnly origin-bound cookie that authorizes preparation but not settlement', async () => {
    const secret = crypto.randomUUID().repeat(2)
    const now = Date.UTC(2026, 7, 29)
    const issued = await issueStorefrontSession(new Request('https://airvio.co/v1/session', {
      method: 'POST', headers: { origin: 'https://airvio.co' },
    }), secret, now)
    expect(issued).not.toBeNull()
    expect(issued?.cookie).toContain(`${STOREFRONT_SESSION_COOKIE}=`)
    expect(issued?.cookie).toContain('Secure; HttpOnly; SameSite=Strict')
    const cookie = issued?.cookie.split(';', 1)[0] ?? ''
    const request = new Request('https://airvio.co/v1/checkouts/checkout-1/prepare', {
      method: 'POST', headers: { origin: 'https://airvio.co', cookie },
    })
    await expect(authorizeStorefrontSession(request, secret, 'checkout:prepare', now + 1_000))
      .resolves.toMatchObject({ ok: true })
    await expect(authorizeStorefrontSession(
      new Request(request, { headers: { origin: 'https://other.example', cookie } }),
      secret,
      'checkout:prepare',
      now + 1_000,
    )).resolves.toEqual({ ok: false, code: 'storefront_session_invalid' })
  })

  it('keeps loopback behavior explicit and consistent outside production', async () => {
    const secret = crypto.randomUUID().repeat(2)
    const now = Date.UTC(2026, 7, 29)
    const localRequest = new Request('http://127.0.0.1:8787/v1/session', {
      method: 'POST', headers: { origin: 'http://127.0.0.1:8787' },
    })
    await expect(issueStorefrontSession(localRequest, secret, now)).resolves.toBeNull()
    const issued = await issueStorefrontSession(localRequest, secret, now, true)
    expect(issued).not.toBeNull()
    const cookie = issued?.cookie.split(';', 1)[0] ?? ''
    await expect(authorizeStorefrontSession(new Request(localRequest, {
      headers: { origin: 'http://127.0.0.1:8787', cookie },
    }), secret, 'storefront:read', now + 1_000, true)).resolves.toMatchObject({ ok: true })
  })
})
