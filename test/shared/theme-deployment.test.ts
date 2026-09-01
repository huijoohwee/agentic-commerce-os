import { afterEach, describe, expect, it, vi } from 'vitest'

import { currentTheme, deployTheme } from '../../src/core/theme-deployment'
import type { ActivatedTheme } from '../../src/core/theme-deployment-store'
import { themeMutationPermit } from '../fixtures/authoring.js'

describe('theme deployment response projection', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the persisted record byte-for-byte on an idempotent activation', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_777_777_777_000).mockReturnValueOnce(1_888_888_888_000)
    let persisted: ActivatedTheme | null = null
    const store = {
      async activate(candidate: ActivatedTheme) {
        if (persisted?.manifestDigest === candidate.manifestDigest) {
          return Object.freeze({ ok: true, idempotent: true, record: persisted })
        }
        persisted = candidate
        return Object.freeze({ ok: true, idempotent: false, record: candidate })
      },
      async current() { return Object.freeze({ ok: true, record: persisted }) },
    }
    const environment = {
      REGISTRY_ID: 'primary',
      AGENT_REGISTRY: { getByName: () => ({
        list: async () => ({
          agents: [{ agentId: 'agent-theme', registrationState: 'active', admissionVerified: true }],
        }),
      }) },
      THEME_DEPLOYMENT: { getByName: () => store },
    } as unknown as CoreEnv
    const manifest = Object.freeze({
      merchantId: 'merchant-theme',
      catalogScope: Object.freeze(['agent-theme']),
      logo: Object.freeze({ href: null }),
    })

    const first = await deployTheme(environment, 'merchant-theme', manifest, themeMutationPermit('merchant-theme'))
    const repeated = await deployTheme(environment, 'merchant-theme', manifest, themeMutationPermit('merchant-theme'))
    expect(first).toMatchObject({ ok: true, idempotent: false })
    expect(repeated).toEqual({ ...first, idempotent: true })
    const current = await currentTheme(environment, 'merchant-theme')
    expect(current).toEqual(persisted)
    if (!current) throw new Error('persisted_theme_missing')
    expect(repeated.ok && repeated.deployedAt).toBe(current.deployedAt)
  })
})
