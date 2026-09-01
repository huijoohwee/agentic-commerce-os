import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  serializeThemeManifest,
  validateThemeAssetUrl,
  validateThemeManifest,
  type ThemeManifest,
} from '../../src/shared/theme-manifest'

describe('theme manifest', () => {
  // Feature: agentic-graph-commerce-platform, Property 8: Theme manifest round trip
  it('round-trips canonical valid manifests with stable digests', async () => {
    await fc.assert(fc.asyncProperty(themeManifestArbitrary(), async (manifest) => {
      const first = await validateThemeManifest(manifest)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = await validateThemeManifest(JSON.parse(serializeThemeManifest(first.manifest)) as unknown)
      expect(second).toEqual(first)
    }), { numRuns: 300, seed: 20_260_908 })
  })

  it('reports defaults and every violating field without accepting private asset targets', async () => {
    const defaulted = await validateThemeManifest({ merchantId: 'merchant-1', catalogScope: ['agent-1'] })
    expect(defaulted).toMatchObject({ ok: true })
    if (defaulted.ok) {
      expect(defaulted.defaultedFields).toContain('palette.accent')
      expect(defaulted.defaultedFields).toContain('copy.headline')
    }
    const rejected = await validateThemeManifest({
      merchantId: 'merchant-1',
      catalogScope: ['agent-1'],
      logo: { href: 'https://127.0.0.1/logo.svg', alt: 'Local' },
      unexpected: true,
    })
    expect(rejected).toMatchObject({ ok: false })
    if (!rejected.ok) expect(rejected.violations.map(({ field }) => field)).toEqual(['logo.href', 'unexpected'])

    expect(validateThemeAssetUrl('https://assets.example.com/logo.svg')).toBe(true)
    for (const address of [
      'https://localhost/logo.svg',
      'https://store.local/logo.svg',
      'https://10.0.0.1/logo.svg',
      'https://[::1]/logo.svg',
      'https://assets.example.com:8443/logo.svg',
      'https://assets.example.com/logo.svg#fragment',
    ]) expect(validateThemeAssetUrl(address)).toBe(false)
  })

  it('accepts a 280-character asset URL and rejects the next character', async () => {
    const prefix = 'https://assets.example.com/'
    const exact = `${prefix}${'a'.repeat(280 - prefix.length)}`
    const accepted = await validateThemeManifest({
      merchantId: 'merchant-1',
      catalogScope: ['agent-1'],
      logo: { href: exact, alt: 'Logo' },
    })
    expect(accepted).toMatchObject({ ok: true })

    const rejected = await validateThemeManifest({
      merchantId: 'merchant-1',
      catalogScope: ['agent-1'],
      logo: { href: `${exact}a`, alt: 'Logo' },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (!rejected.ok) expect(rejected.violations).toContainEqual({
      field: 'logo.href', reason: 'must be null or a bounded HTTPS URL',
    })
  })
})

function themeManifestArbitrary(): fc.Arbitrary<ThemeManifest> {
  const identifier = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u)
  const hexadecimalDigit = fc.constantFrom(...'0123456789abcdef')
  const color = fc.array(hexadecimalDigit, { minLength: 6, maxLength: 6 })
    .map((digits) => `#${digits.join('')}`)
  const text = fc.string({ maxLength: 280 })
  return fc.record({
    merchantId: identifier,
    palette: fc.record({ ink: color, muted: color, line: color, panel: color, accent: color, background: color }),
    logo: fc.record({ href: fc.constant(null), alt: text }),
    copy: fc.record({ brand: text, headline: text, subhead: text, footer: text }),
    catalogScope: fc.uniqueArray(identifier, { minLength: 1, maxLength: 20 }),
    locale: fc.constantFrom('en-US', 'fr-FR', 'zh-Hans-SG'),
  }).map((value) => Object.freeze({
    ...value,
    palette: Object.freeze(value.palette),
    logo: Object.freeze(value.logo),
    copy: Object.freeze(value.copy),
    catalogScope: Object.freeze(value.catalogScope),
  }))
}
