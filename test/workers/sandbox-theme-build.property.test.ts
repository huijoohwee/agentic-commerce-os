import { describe, expect, it } from 'vitest'

import { deployTheme } from '../../src/core/theme-deployment'
import { themeMutationPermit } from '../fixtures/authoring.js'

describe('Template Pack activation boundary', () => {
  it('activates without reading the Sandbox service binding', async () => {
    const availableEnvironment = {
      REGISTRY_ID: 'primary',
      AGENT_REGISTRY: {
        getByName: () => ({
          list: async () => ({
            agents: [{ agentId: 'agent-1', registrationState: 'active', admissionVerified: true }],
          }),
        }),
      },
      THEME_DEPLOYMENT: {
        getByName: () => ({ activate: async (record: unknown) => ({ ok: true, idempotent: false, record }) }),
      },
    }
    const environmentWithoutSandbox = new Proxy(availableEnvironment, {
      get(target, property, receiver) {
        if (property === 'COMMERCE_SANDBOX') {
          throw new Error('sandbox_must_not_be_read_by_theme_activation')
        }
        return Reflect.get(target, property, receiver)
      },
    }) as unknown as CoreEnv

    await expect(deployTheme(environmentWithoutSandbox, 'merchant-1', {
      merchantId: 'merchant-1',
      catalogScope: ['agent-1'],
      logo: { href: null },
    }, themeMutationPermit('merchant-1'))).resolves.toMatchObject({ ok: true, merchantId: 'merchant-1' })
  })
})
