#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_VALUE_FLAGS = new Set(['-t', '--tag', '--platform', '--build-arg', '--network', '-f', '--file'])

// Wrangler 4.127.1 emits a BuildKit flag that Podman does not implement.
// Remove only this disabled option; retain all other argv and native exit status.
export function podmanArguments(args: readonly string[]): string[] {
  if (args[0] !== 'build') return [...args]
  const translated = ['build']
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') { translated.push(...args.slice(index)); break }
    if (arg !== '--provenance=false') translated.push(arg)
    if (BUILD_VALUE_FLAGS.has(arg) && index + 1 < args.length) translated.push(args[++index]!)
  }
  return translated
}

// Podman prints every cached alias after a build. Only the requested tag belongs
// to this invocation; old aliases are neither new images nor cleanup authority.
export function podmanBuildTag(args: readonly string[]): string | null {
  if (args[0] !== 'build') return null
  const tags: string[] = []
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') break
    if (arg.startsWith('--tag=')) tags.push(arg.slice(6))
    if (!BUILD_VALUE_FLAGS.has(arg)) continue
    const value = args[++index]
    if (value === undefined) return null
    if (arg === '-t' || arg === '--tag') tags.push(value)
  }
  return tags.length === 1 && /^cloudflare-dev\/sandbox:[0-9a-f]{8}$/u.test(tags[0]!) ? tags[0]! : null
}

export function podmanRuntimeEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const runtime = parent.MINIFLARE_WORKERD_PATH
  if (!runtime) throw new Error('podman_workerd_override_required:see docs/container-runtime.md')
  if (runtime.length > 4096 || !isAbsolute(runtime) || /[\0\r\n]/u.test(runtime)) {
    throw new Error('podman_workerd_override_invalid:absolute_executable_required')
  }
  try {
    if (!statSync(runtime).isFile()) throw new Error('not a file')
    accessSync(runtime, constants.R_OK | constants.X_OK)
  } catch { throw new Error('podman_workerd_override_invalid:absolute_executable_required') }
  // Compatibility and checksum verification remain the build receipt's contract.
  // Check this prerequisite before contacting Podman or launching Wrangler.
  return podmanEnvironment(parent)
}

export function podman(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('podman', args, { env, encoding: 'utf8', timeout: 5_000, maxBuffer: 65_536 })
  if (result.status !== 0) throw new Error(`podman_${args[0]}_failed:${result.error?.message ?? `${result.status}:${result.stderr.trim().slice(0, 1024)}`}`)
  return result.stdout.trim()
}

export function podmanEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !/^unix:\/\/\/[^\0\r\n]+$/u.test(value)) {
    throw new Error('podman_local_socket_required')
  }
  return value
}

export function podmanEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent }
  // Bind CLI and Miniflare to one local Podman service; never inherit a Docker endpoint.
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'WRANGLER_DOCKER_HOST', 'CONTAINER_CONNECTION']) delete env[key]
  let endpoint = env.CONTAINER_HOST
  if (!endpoint) {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const machine = env.AGENTIC_PODMAN_MACHINE ?? 'podman-machine-default'
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(machine)) throw new Error('podman_machine_name_invalid')
      const inspected = JSON.parse(podman(['machine', 'inspect', machine], env))
      if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0]?.State !== 'running') throw new Error('podman_machine_not_running')
      endpoint = `unix://${inspected[0]?.ConnectionInfo?.PodmanSocket?.Path}`
    } else {
      const socket = JSON.parse(podman(['info', '--format', '{{json .Host.RemoteSocket.Path}}'], env))
      endpoint = typeof socket === 'string' && socket.startsWith('unix://') ? socket : `unix://${socket}`
    }
  }
  endpoint = podmanEndpoint(endpoint)
  return { ...env, CONTAINER_HOST: endpoint, DOCKER_HOST: endpoint, WRANGLER_DOCKER_HOST: endpoint,
    WRANGLER_DOCKER_BIN: fileURLToPath(import.meta.url) }
}

export async function podmanIdentity(env: NodeJS.ProcessEnv): Promise<string> {
  const endpoint = podmanEndpoint(env.CONTAINER_HOST)
  // Bind the actual local socket node and Podman storage identity; the compatibility
  // /info ID is randomized on each request and cannot identify a Podman engine.
  const socket = lstatSync(endpoint.slice(7), { bigint: true })
  if (!socket.isSocket()) throw new Error('podman_socket_required')
  return new Promise((resolve, reject) => {
    const call = request({ socketPath: endpoint.slice(7), path: '/v4.0.0/libpod/info', timeout: 5_000 }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 65_536) { response.destroy(new Error('podman_identity_over_budget')); return }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const host = value.host?.hostname; const root = value.store?.graphRoot
          const current = lstatSync(endpoint.slice(7), { bigint: true })
          if (response.statusCode !== 200 || typeof host !== 'string' || !host || host.length > 256
            || typeof root !== 'string' || !root.startsWith('/') || root.length > 1024
            || typeof value.host?.security?.rootless !== 'boolean' || !value.version?.APIVersion
            || current.dev !== socket.dev || current.ino !== socket.ino) throw new Error('podman_identity_invalid')
          resolve(JSON.stringify([endpoint, String(socket.dev), String(socket.ino), host, root, value.host.security.rootless]))
        } catch (error) { reject(error) }
      })
    })
    call.once('timeout', () => { call.destroy(new Error('podman_identity_timeout')) })
    call.once('error', reject); call.end()
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn('podman', podmanArguments(process.argv.slice(2)), { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child.kill(signal) })
  child.once('error', () => { process.exitCode = 1 })
  child.once('close', (code, signal) => {
    const args = process.argv.slice(2)
    const built = code === 0 ? podmanBuildTag(args) : null
    if (built) process.stdout.write(`podman-built ${built}\n`)
    if (code === 0 && args.length === 2 && args[0] === 'pull'
      && /^(?:docker\.io\/)?cloudflare\/proxy-everything:[a-zA-Z0-9._-]+@sha256:[0-9a-f]{64}$/u.test(args[1]!)) {
      process.stdout.write(`podman-pulled ${args[1]}\n`)
    }
    process.exitCode = code ?? (signal ? 128 : 1)
  })
}
