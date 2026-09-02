import { describe, expect, it } from 'vitest'

import {
  buildDryDeployEnvironment,
  CLOUDFLARE_AUTH_ENVIRONMENT_VARIABLES,
  DEV_DRY_DEPLOY_TARGETS,
  validateDryDeployInvocation,
} from '../../scripts/dry-deploy-controller.ts'

describe('credentialless dry-deploy controller', () => {
  it('fixes the four Dev targets and rejects every caller argument', () => {
    expect(DEV_DRY_DEPLOY_TARGETS.map(({ config }) => config)).toEqual([
      'wrangler.dev-provider.jsonc',
      'wrangler.core.jsonc',
      'wrangler.edge.jsonc',
      'wrangler.sandbox.jsonc',
    ])
    expect(() => validateDryDeployInvocation([])).not.toThrow()
    for (const argument of ['--no-dry-run', '--name', 'agentic-commerce-edge-production', '--env=production']) {
      expect(() => validateDryDeployInvocation([argument])).toThrow('dry_deploy:arguments_forbidden')
    }
  })

  it('isolates Wrangler configuration and strips every Cloudflare auth source', () => {
    const parentEnvironment = { ...process.env }
    for (const name of CLOUDFLARE_AUTH_ENVIRONMENT_VARIABLES) parentEnvironment[name] = `secret-${name}`
    parentEnvironment.UNRELATED_VALUE = 'preserved'
    parentEnvironment.XDG_CONFIG_HOME = '/persisted/wrangler/config'

    const childEnvironment = buildDryDeployEnvironment(parentEnvironment, '/isolated/config')

    for (const name of CLOUDFLARE_AUTH_ENVIRONMENT_VARIABLES) expect(childEnvironment[name]).toBeUndefined()
    expect(childEnvironment).toMatchObject({
      CI: 'true',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      UNRELATED_VALUE: 'preserved',
      XDG_CONFIG_HOME: '/isolated/config',
    })
  })
})
