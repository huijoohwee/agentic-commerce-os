import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseActiveVersion } from './lifecycle.ts'
import { proveProductionRoute } from './route-proof.ts'
import type { ProductionReleaseAdapter, UploadInput } from './production-controller.ts'
import type { ProductionRouteAuthority } from './route-authority.ts'
import type { WorkerKind } from './controller-receipts.ts'
import { probeDeviceHost } from '../../src/sandbox/device-host.ts'
import { DEVICE_HOST_PROOF_SCHEMA } from './device-host-release.ts'
import { readBoundedJsonResponse } from './bounded-response.ts'

const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1_048_576
const COMMAND_TIMEOUT_MS = 12 * 60_000
const CONFIGS: Readonly<Record<WorkerKind, string>> = Object.freeze({
  sandbox: 'wrangler.sandbox.jsonc',
  core: 'wrangler.core.jsonc',
  edge: 'wrangler.edge.jsonc',
})

export function createWranglerReleaseAdapter(root: string): ProductionReleaseAdapter {
  const cwd = path.resolve(root)
  return Object.freeze({
    async activeVersion(kind) {
      const deployments = jsonCommand(cwd, [
        'deployments', 'list', '-c', CONFIGS[kind], '--env', 'production', '--json',
      ])
      if (!Array.isArray(deployments)) throw new Error('wrangler_release:deployments_invalid')
      if (deployments.length === 0) return null
      return parseActiveVersion(deployments[0])
    },
    async listVersions(kind) {
      const versions = jsonCommand(cwd, [
        'versions', 'list', '-c', CONFIGS[kind], '--env', 'production', '--json',
      ])
      if (!Array.isArray(versions)) throw new Error('wrangler_release:versions_invalid')
      return versions
    },
    async uploadInactive(kind, input) {
      uploadVersion(cwd, kind, input)
    },
    async deploySandbox(input) {
      deploySandbox(cwd, input)
    },
    async viewVersion(kind, versionId) {
      return jsonCommand(cwd, [
        'versions', 'view', versionId, '-c', CONFIGS[kind], '--env', 'production', '--json',
      ])
    },
    async activate(kind, versionId) {
      command(cwd, [
        'versions', 'deploy', `${versionId}@100%`, '-c', CONFIGS[kind], '--env', 'production',
        '--message', `exact-candidate activation ${kind}`, '--yes',
      ])
    },
    async probeExecutionHost(pins, token) {
      await probeDeviceHost(pins, token)
      return Object.freeze({ ...pins, schema: DEVICE_HOST_PROOF_SCHEMA,
        availability: 'device-session', observedAt: new Date().toISOString() })
    },
    async readRouteAuthority(authority, phase) {
      return readRouteAuthority(authority, phase)
    },
    async activateBootstrapRoute(authority) {
      await activateBootstrapRoute(authority)
    },
    async proveLiveRoute(input) {
      return proveProductionRoute({
        ...input,
        fetch: async (request) => fetch(new Request(request, {
          signal: AbortSignal.timeout(30_000),
        })),
      })
    },
  })
}

function uploadVersion(root: string, kind: 'core' | 'edge', input: UploadInput): void {
  withSecretFile(input.secrets, kind, (secretFile) => {
    command(root, [
      'versions', 'upload', '-c', CONFIGS[kind], '--env', 'production',
      '--tag', input.candidateSha, '--message', `exact protected candidate ${kind}`,
      '--minify', '--strict', '--keep-vars',
      ...variableArguments(input.variables),
      ...(secretFile ? ['--secrets-file', secretFile] : []),
    ])
  })
}

function deploySandbox(root: string, input: UploadInput): void {
  if (Object.keys(input.secrets).join(',') !== 'EXECUTION_HOST_BEARER_TOKEN') {
    throw new Error('wrangler_release:sandbox_secret_inventory_invalid')
  }
  withSecretFile(input.secrets, 'sandbox', secretFile => command(root, [
    'deploy', '-c', CONFIGS.sandbox, '--env', 'production',
    '--tag', input.candidateSha, '--message', 'exact protected candidate device sandbox',
    '--minify', '--strict', '--keep-vars', '--secrets-file', secretFile as string,
    ...variableArguments(input.variables),
  ]))
}

async function readRouteAuthority(
  authority: ProductionRouteAuthority,
  phase: 'before' | 'after' | 'recovery',
): Promise<unknown> {
  const routes = await fetchRoutes(authority)
  const matches = authority.mode === 'steady-state'
    ? routes.filter((route) => isRecord(route) && route.id === authority.routeId)
    : routes.filter((route) => isRecord(route) && route.pattern === authority.pattern)
  if (authority.mode === 'bootstrap' && phase === 'before') {
    if (matches.length !== 0) throw new Error('wrangler_release:bootstrap_route_not_absent')
    return Object.freeze({ state: 'absent', id: null, pattern: authority.pattern, script: null })
  }
  if (authority.mode === 'bootstrap' && phase === 'recovery' && matches.length === 0) {
    return Object.freeze({ state: 'absent', id: null, pattern: authority.pattern, script: null })
  }
  if (matches.length !== 1) throw new Error('wrangler_release:route_cardinality_invalid')
  const route = matches[0] as Record<string, unknown>
  return Object.freeze({ state: 'bound', id: route.id, pattern: route.pattern, script: route.script })
}

async function activateBootstrapRoute(authority: ProductionRouteAuthority): Promise<void> {
  if (authority.mode !== 'bootstrap') throw new Error('wrangler_release:bootstrap_route_mode_invalid')
  await readRouteAuthority(authority, 'before')
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('wrangler_release:cloudflare_api_token_missing')
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${authority.zoneId}/workers/routes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pattern: authority.pattern, script: authority.script }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== 200) throw new Error('wrangler_release:route_create_status_invalid')
  const body = await readBoundedJsonResponse(response, 1_048_576)
  if (!isRecord(body) || body.success !== true || !isRecord(body.result)
    || body.result.pattern !== authority.pattern || body.result.script !== authority.script) {
    throw new Error('wrangler_release:route_create_result_invalid')
  }
}

async function fetchRoutes(authority: ProductionRouteAuthority): Promise<unknown[]> {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('wrangler_release:cloudflare_api_token_missing')
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${authority.zoneId}/workers/routes`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== 200) throw new Error('wrangler_release:route_inventory_status_invalid')
  const body = await readBoundedJsonResponse(response, 1_048_576)
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.result)) {
    throw new Error('wrangler_release:route_inventory_invalid')
  }
  return body.result
}

function variableArguments(variables: Readonly<Record<string, string>>): string[] {
  return Object.entries(variables).sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ['--var', `${name}:${value}`])
}

function withSecretFile(
  secrets: Readonly<Record<string, string>>,
  kind: WorkerKind,
  action: (secretFile: string | null) => void,
): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-release-'))
  try {
    if (Object.keys(secrets).length === 0) return action(null)
    const secretFile = path.join(temporary, `${kind}-secrets.json`)
    fs.writeFileSync(secretFile, JSON.stringify(secrets), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    action(secretFile)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function jsonCommand(root: string, arguments_: readonly string[]): unknown {
  const output = command(root, arguments_)
  try {
    return JSON.parse(output) as unknown
  } catch {
    throw new Error('wrangler_release:json_output_invalid')
  }
}

function command(root: string, arguments_: readonly string[]): string {
  return execFileSync('npx', ['--no-install', 'wrangler', ...arguments_], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
