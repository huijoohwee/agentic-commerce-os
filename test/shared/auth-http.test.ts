import { describe, expect, it } from 'vitest'

import { bearerAuthorized, originAllowed, validateSecretConfiguration } from '../../src/shared/auth'
import { readJsonObject } from '../../src/shared/http'

describe('edge request boundaries', () => {
  it('matches bearer secrets exactly and keeps production authorities distinct', async () => {
    const request = new Request('https://edge.test', {
      headers: { authorization: 'Bearer exact-secret' },
    })
    await expect(bearerAuthorized(request, 'exact-secret')).resolves.toBe(true)
    await expect(bearerAuthorized(request, 'exact-secret-extra')).resolves.toBe(false)
    expect(validateSecretConfiguration('Production', 'a'.repeat(32), 'b'.repeat(32))).toEqual({ ok: true })
    expect(validateSecretConfiguration('Production', 'same'.repeat(8), 'same'.repeat(8))).toMatchObject({
      ok: false,
      code: 'secret_configuration_invalid',
    })
  })

  it('allows only configured exact origins and bounded JSON objects', async () => {
    const allowed = new Request('https://edge.test', { headers: { origin: 'https://airvio.co' } })
    const denied = new Request('https://edge.test', { headers: { origin: 'https://example.com' } })
    const insecure = new Request('https://edge.test', { headers: { origin: 'http://airvio.co' } })
    const alternatePort = new Request('https://edge.test', { headers: { origin: 'https://airvio.co:8443' } })
    expect(originAllowed(allowed, '["https://airvio.co"]')).toBe(true)
    expect(originAllowed(denied, '["https://airvio.co"]')).toBe(false)
    expect(originAllowed(insecure, '["https://airvio.co"]')).toBe(false)
    expect(originAllowed(alternatePort, '["https://airvio.co"]')).toBe(false)

    const parsed = await readJsonObject(new Request('https://edge.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }))
    expect(parsed).toEqual({ ok: true })

    const tooLarge = await readJsonObject(new Request('https://edge.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
      body: '{}',
    }), 8)
    expect(tooLarge).toMatchObject({ ok: false, code: 'body_too_large' })
  })
})
