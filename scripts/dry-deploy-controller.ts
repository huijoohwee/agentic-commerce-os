import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type DryDeployTarget = Readonly<{
  config: string
  extraArguments?: readonly string[]
}>

export const DEV_DRY_DEPLOY_TARGETS: readonly DryDeployTarget[] = Object.freeze([
  Object.freeze({ config: 'wrangler.dev-provider.jsonc' }),
  Object.freeze({ config: 'wrangler.core.jsonc' }),
  Object.freeze({ config: 'wrangler.edge.jsonc' }),
  Object.freeze({ config: 'wrangler.sandbox.jsonc', extraArguments: Object.freeze(['--containers-rollout=none']) }),
])

export const CLOUDFLARE_AUTH_ENVIRONMENT_VARIABLES = Object.freeze([
  'CF_API_BASE_URL',
  'CF_API_KEY',
  'CF_API_TOKEN',
  'CF_EMAIL',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_BASE_URL',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'CLOUDFLARE_BASE_URL',
  'CLOUDFLARE_EMAIL',
  'WRANGLER_R2_SQL_AUTH_TOKEN',
] as const)

export function validateDryDeployInvocation(argumentsValue: readonly string[]): void {
  if (argumentsValue.length !== 0) throw new Error('dry_deploy:arguments_forbidden')
}

export function buildDryDeployEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  isolatedConfigRoot: string,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...parentEnvironment }
  for (const name of CLOUDFLARE_AUTH_ENVIRONMENT_VARIABLES) delete childEnvironment[name]
  childEnvironment.XDG_CONFIG_HOME = isolatedConfigRoot
  childEnvironment.CI = 'true'
  childEnvironment.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false'
  childEnvironment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
  return childEnvironment
}

function runTarget(target: DryDeployTarget, childEnvironment: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [
    './node_modules/wrangler/bin/wrangler.js', 'deploy', '-c', target.config,
    '--env', 'dev', '--dry-run', '--minify', ...(target.extraArguments ?? []),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: childEnvironment,
    maxBuffer: 4_000_000,
    timeout: 120_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0) throw new Error(`dry_deploy:wrangler_failed:${target.config}`)
}

function main(): void {
  validateDryDeployInvocation(process.argv.slice(2))
  const isolatedConfigRoot = mkdtempSync(join(tmpdir(), 'agentic-commerce-wrangler-dry-'))
  try {
    const childEnvironment = buildDryDeployEnvironment(process.env, isolatedConfigRoot)
    for (const target of DEV_DRY_DEPLOY_TARGETS) runTarget(target, childEnvironment)
  } finally {
    rmSync(isolatedConfigRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'dry_deploy:unknown_error'}\n`)
    process.exitCode = 1
  }
}
