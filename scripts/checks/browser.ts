import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { podman, podmanEnvironment, podmanIdentity } from '../container-runtime.ts'
import { readJson } from './common.ts'
import { REGISTRATION_CORE_REQUEST_TIMEOUT_MS } from '../../src/shared/registration-budget.ts'
import { DEV_AGENTIC_OS_ADMISSION_AUTH_SECRET, DEV_CHECKOUT_PROVIDER_AUTH_SECRET, DEV_MARKETPLACE_PROVIDER_AUTH_SECRET } from '../../src/dev/provider-credentials.ts'

type RuntimeState = { baseUrl: string | null; closed: boolean; failure: string | null }
type ManagedChild = { child: ChildProcess; terminal: Promise<number>; result: number | null; groups: Set<number>; runtime?: RuntimeState }
type Fixture = { secrets: Record<string, string>; vars: Record<string, string> }
const children: ManagedChild[] = []
let sidecars: SidecarCapture | null = null
let podmanLock: PodmanLock | null = null
const PLAYWRIGHT = './node_modules/@playwright/test/cli.js'
const CONFIGS = ['wrangler.edge.jsonc', 'wrangler.core.jsonc', 'wrangler.dev-provider.jsonc', 'wrangler.sandbox.jsonc']
const CLOSE_TIMEOUT_MS = 30_000
let ownedDirectory: { path: string; dev: number; ino: number } | null = null
let interrupted = false

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dev-only')) throw new Error('browser_arguments_invalid')
  const manifest = readJson<Readonly<{ devDependencies?: Readonly<Record<string, string>> }>>('package.json')
  if (manifest.devDependencies?.['@playwright/test'] !== '1.62.1') throw new Error('playwright_not_exact_pinned')
  assertNoAmbientVariables()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-dev-e2e-'))
  const stat = fs.lstatSync(directory)
  ownedDirectory = { path: directory, dev: stat.dev, ino: stat.ino }
  const nonce = randomBytes(16).toString('hex')
  const candidate = `dev-e2e-${nonce}`
  const agentToken = randomBytes(32).toString('hex')
  const operatorToken = randomBytes(32).toString('hex')
  const fixture: Fixture = {
    secrets: {
      MCP_BEARER_TOKEN: agentToken, OPERATOR_BEARER_TOKEN: operatorToken,
      STOREFRONT_SESSION_SECRET: randomBytes(32).toString('hex'),
      DISCOVERY_PROVIDER_BEARER_TOKEN: randomBytes(32).toString('hex'),
      AGENTIC_OS_ADMISSION_AUTH_SECRET: DEV_AGENTIC_OS_ADMISSION_AUTH_SECRET,
      CHECKOUT_PROVIDER_AUTH_SECRET: DEV_CHECKOUT_PROVIDER_AUTH_SECRET,
      MARKETPLACE_PROVIDER_AUTH_SECRET: DEV_MARKETPLACE_PROVIDER_AUTH_SECRET,
    },
    vars: {
      RELEASE_CANDIDATE_SHA: candidate,
      RELEASE_CANDIDATE_DIGEST: createHash('sha256').update(candidate).digest('hex'),
      ALLOWED_ORIGINS_JSON: '[]',
    },
  }
  const environment = {
    ...localEnvironment(), TMPDIR: directory,
    WRANGLER_REGISTRY_PATH: path.join(directory, 'registry'),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false',
    AGENTIC_COMMERCE_DEV_E2E_AGENT_TOKEN: agentToken,
    AGENTIC_COMMERCE_DEV_E2E_OPERATOR_TOKEN: operatorToken,
    AGENTIC_COMMERCE_DEV_E2E_RUN_ID: nonce,
  }
  const baseUrl = await startRuntime(fixture, environment, 600_000)
  if (args[0] !== '--dev-only') {
    const components = launch([PLAYWRIGHT, 'test', `--output=${path.join(directory, 'components')}`], {
      ...environment, AGENTIC_COMMERCE_BROWSER_OWNER: '1', AGENTIC_COMMERCE_BROWSER_BASE_URL: baseUrl,
    })
    await requireSuccess(components, 180_000, 'browser_components')
    // Retire the completed suite's process-group authority before the next suite.
    const cutoff = Date.now() + 2_000
    while ([...components.groups].some(groupAlive) && Date.now() < cutoff) await delay(100)
    if ([...components.groups].some(groupAlive)) throw new Error('browser_component_processes_still_live')
    components.groups.clear()
  }
  await requireSuccess(launch([PLAYWRIGHT, 'test', '--config=playwright.dev-e2e.config.ts', `--output=${path.join(directory, 'dev')}`], {
    ...environment, AGENTIC_COMMERCE_DEV_E2E_BASE_URL: baseUrl,
  }), 2 * (REGISTRATION_CORE_REQUEST_TIMEOUT_MS + 15_000) + 120_000, 'browser_dev_paid_loop')
}

function assertNoAmbientVariables(): void {
  for (const config of CONFIGS) for (const name of ['.dev.vars', '.dev.vars.dev']) {
    const file = path.resolve(path.dirname(config), name)
    if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`browser_ambient_dev_vars_forbidden:${name}`)
  }
}

function localEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CONTAINER_HOST', 'AGENTIC_PODMAN_MACHINE', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'MINIFLARE_WORKERD_PATH', 'CI']
  return podmanEnvironment(Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])))
}

function launch(args: string[], env: NodeJS.ProcessEnv, runtime?: RuntimeState): ManagedChild {
  if (interrupted) throw new Error('browser_interrupted')
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(), env, detached: process.platform !== 'win32',
    stdio: runtime ? ['ignore', 'pipe', 'pipe', 'ipc'] : 'inherit',
  })
  let complete!: (code: number) => void
  const terminal = new Promise<number>(resolve => { complete = resolve })
  const managed: ManagedChild = { child, terminal, result: null, groups: new Set(child.pid && process.platform !== 'win32' ? [child.pid] : []), ...(runtime ? { runtime } : {}) }
  const finish = (code: number) => { managed.result = code; complete(code) }
  child.once('error', () => finish(1))
  child.once('exit', (code, signal) => finish(code ?? (signal ? 128 : 1)))
  if (runtime) child.on('message', message => {
    if (!message || typeof message !== 'object' || !('type' in message)) { runtime.failure = 'browser_runtime_ipc_invalid'; return }
    if (message.type === 'ready' && 'baseUrl' in message && typeof message.baseUrl === 'string'
      && /^http:\/\/127\.0\.0\.1:\d+$/u.test(message.baseUrl)) runtime.baseUrl = message.baseUrl
    else if (message.type === 'closed') runtime.closed = true
    else if (message.type === 'failure' && 'message' in message && typeof message.message === 'string') runtime.failure = message.message.slice(0, 512)
    else runtime.failure = 'browser_runtime_ipc_invalid'
  })
  if (runtime) for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
    let pending = ''
    stream?.on('data', (chunk: Buffer) => {
      output.write(chunk)
      if (!sidecars) return
      pending += chunk.toString('utf8')
      const lines = pending.split('\n'); pending = lines.pop() ?? ''
      if (Buffer.byteLength(pending) > 16_384) { sidecarError(sidecars, 'native_build_line_over_budget'); pending = '' }
      for (const line of lines) observeNativeImage(line.trim(), sidecars)
    })
  }
  children.push(managed)
  return managed
}

async function startRuntime(fixture: Fixture, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  sidecars = await startSidecarCapture(await acquirePodmanLock(env, deadline), deadline)
  const runtime: RuntimeState = { baseUrl: null, closed: false, failure: null }
  const runtimeEnv = sidecars.env
  const managed = launch([fileURLToPath(import.meta.url), '--runtime-child'], runtimeEnv, runtime)
  managed.child.send?.({ type: 'start', fixture })
  while (!runtime.baseUrl && !runtime.failure && managed.result === null && !interrupted && Date.now() < deadline) await delay(100)
  if (interrupted) throw new Error('browser_interrupted')
  if (runtime.failure) throw new Error(`browser_runtime_start_failed:${runtime.failure}`)
  if (!runtime.baseUrl) throw new Error(managed.result === null ? 'dev_runtime_startup_timeout' : 'dev_runtime_exited_before_ready')
  if (Date.now() >= deadline) throw new Error('dev_runtime_startup_timeout')
  const response = await fetch(`${runtime.baseUrl}/livez`, { signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))) })
  const payload = await response.json() as { ok?: boolean; releaseCandidateSha?: string }
  if (!response.ok || payload.ok !== true || payload.releaseCandidateSha !== fixture.vars.RELEASE_CANDIDATE_SHA) throw new Error('dev_runtime_identity_mismatch')
  return runtime.baseUrl
}

async function requireSuccess(managed: ManagedChild, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (managed.result === null && Date.now() < deadline && !interrupted) {
    const failedRuntime = children.find(value => value.runtime && (value.runtime.failure || value.result !== null))
    if (failedRuntime) throw new Error(`browser_runtime_lost:${failedRuntime.runtime?.failure ?? failedRuntime.result}`)
    await delay(100)
  }
  if (interrupted) throw new Error('browser_interrupted')
  if (managed.result === null) throw new Error(`${label}_timeout`)
  if (managed.result !== 0) throw new Error(`${label}_failed:${managed.result}`)
}

function observeDescendantGroups(managed: ManagedChild): void {
  if (process.platform === 'win32' || !managed.child.pid || managed.result !== null) return
  const snapshot = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 2_000_000 })
  if (snapshot.status !== 0) throw new Error('browser_process_ownership_observation_failed')
  const rows = snapshot.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
  const descendants = new Set([managed.child.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parent, group] of rows) if (pid && parent && group && descendants.has(parent) && !descendants.has(pid)) {
      descendants.add(pid); managed.groups.add(group); changed = true
    }
  }
}

function groupAlive(group: number): boolean {
  try { process.kill(-group, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function stopOwnedProcesses(): Promise<void> {
  const failures: unknown[] = []
  // Observe before native shutdown while ancestry still establishes ownership.
  for (const managed of children) try { observeDescendantGroups(managed) } catch (error) { failures.push(error) }
  for (const managed of children) if (managed.runtime && !managed.runtime.closed && managed.child.connected) {
    managed.child.send?.({ type: 'close' }, error => { if (error) managed.runtime!.failure = error.message })
  }
  const deadline = Date.now() + CLOSE_TIMEOUT_MS
  while (children.some(value => value.runtime && !value.runtime.closed && value.result === null) && Date.now() < deadline) await delay(100)
  for (const managed of children) if (managed.runtime && (!managed.runtime.closed || managed.runtime.failure)) {
    failures.push(new Error(`browser_native_teardown_unconfirmed:${managed.runtime.failure ?? 'close acknowledgement missing'}`))
  }
  // Give acknowledged native owners time to exit without signalling their runtime tree.
  const exitDeadline = Date.now() + 2_000
  while (children.some(value => value.result === null) && Date.now() < exitDeadline) await delay(100)
  if (process.platform === 'win32' && children.some(value => value.result === null)) {
    failures.push(new Error('browser_process_tree_cleanup_unconfirmed_windows'))
    for (const value of children) if (value.result === null) value.child.kill('SIGTERM')
    const cutoff = Date.now() + 5_000
    while (children.some(value => value.result === null) && Date.now() < cutoff) await delay(100)
    for (const value of children) if (value.result === null) value.child.kill('SIGKILL')
  }
  const groups = new Set(children.flatMap(value => [...value.groups]))
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const group of groups) try { if (groupAlive(group)) process.kill(-group, signal) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error)
    }
    const cutoff = Date.now() + 5_000
    while ([...groups].some(groupAlive) && Date.now() < cutoff) await delay(100)
    if (![...groups].some(groupAlive)) break
  }
  const live = [...groups].filter(groupAlive)
  if (live.length) failures.push(new Error(`browser_owned_processes_still_live:${live.join(',')}`))
  if (sidecars) try {
    await finishSidecarCapture(sidecars, children.every(value => !value.runtime || value.runtime.closed))
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'browser_cleanup_incomplete')
  await Promise.all(children.map(value => value.terminal))
  if (podmanLock) {
    const owned = podmanLock
    if ((await podmanIdentity(owned.env)) !== owned.daemon) throw new Error('browser_podman_daemon_changed')
    owned.finishOperationLock(owned.identity, { label: 'browser-dev-podman', result: null })
    podmanLock = null
    process.stdout.write(JSON.stringify({ check: 'browser-dev-podman-lock', state: 'released', daemon: owned.daemon, path: owned.identity.path }) + '\n')
  }
}

type ContainerIdentity = { id: string; name: string; created: string; image: string; imageId: string; network: string }
type Creation = { id: string; name: string; image: string; time: string }
type SidecarProof = { main: ContainerIdentity; proxy: ContainerIdentity; event: Creation; outcome?: string }
type SidecarCapture = {
  env: NodeJS.ProcessEnv; daemon: string; before: Set<string>; images: Set<string>; proxyImages: Set<string>;
  events: Map<string, Creation>; proofs: Map<string, SidecarProof>; attempted: Set<string>; errors: string[];
  observer: ChildProcess; ended: boolean; stopping: boolean; bytes: number;
}
function sidecarError(capture: SidecarCapture, message: string): void {
  if (capture.errors.length < 16) capture.errors.push(message.slice(0, 512))
}
const CONTAINER_FORMAT = '{"id":{{json .ID}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"network":{{json .HostConfig.NetworkMode}}}'
// Podman 4.9 exposes time.Time; 5.8+ exposes int64 plus TimeNano. Keep nanosecond precision.
const EVENT_FORMAT = '{"id":{{json .ID}},"name":{{json .Name}},"image":{{json .Image}},"time":"{{if eq (printf "%T" .Time) "int64"}}{{.TimeNano}}{{else}}{{.Time.UnixNano}}{{end}}"}'

function containerIds(args: string[], env: NodeJS.ProcessEnv): Set<string> {
  const text = podman(['container', 'ls', '--all', '--no-trunc', ...args, '--format', '{{.ID}}'], env)
  const ids = text ? text.split('\n') : []
  if (ids.length > 256 || ids.some(id => !/^[0-9a-f]{64}$/u.test(id))) throw new Error('browser_podman_inventory_invalid')
  return new Set(ids)
}

function inspectContainer(id: string, capture: SidecarCapture): ContainerIdentity {
  const value = JSON.parse(podman(['container', 'inspect', id, '--format', CONTAINER_FORMAT], capture.env)) as ContainerIdentity
  if (typeof value.name === 'string' && !value.name.startsWith('/')) value.name = `/${value.name}`
  if (/^[0-9a-f]{64}$/u.test(value.imageId)) value.imageId = `sha256:${value.imageId}`
  if (!/^[0-9a-f]{64}$/u.test(value.id) || !/^[a-z0-9][a-z0-9_.-]*$/iu.test(value.name.slice(1))
    || !Number.isFinite(Date.parse(value.created)) || !/^sha256:[0-9a-f]{64}$/u.test(value.imageId)
    || typeof value.image !== 'string' || typeof value.network !== 'string') throw new Error('browser_podman_identity_invalid')
  value.image = nativeImageIdentity(value.image)
  return value
}

type PodmanSession = { env: NodeJS.ProcessEnv; daemon: string }
type LockIdentity = Readonly<{ path: string; dev: bigint; ino: bigint }>
type LockPrimitives = {
  acquireDirectoryLock: (path: string) => LockIdentity | null
  finishOperationLock: (lock: LockIdentity, options: { label: string; result: null }) => unknown
}
type PodmanLock = PodmanSession & { identity: LockIdentity; finishOperationLock: LockPrimitives['finishOperationLock'] }

async function acquirePodmanLock(environment: NodeJS.ProcessEnv, deadline: number): Promise<PodmanSession> {
  const startedAt = Date.now()
  const env = podmanEnvironment(environment)
  const endpoint = env.CONTAINER_HOST
  const daemon = await podmanIdentity(env)
  const primitives = await import(new URL('./file-integrity.mjs', import.meta.resolve('agentic-os')).href) as LockPrimitives
  // Home is shared by local runners even when each invocation has a different TMPDIR.
  const lockPath = path.join(os.homedir(), `.agentic-commerce-dev-podman-${createHash('sha256').update(daemon).digest('hex')}.lock`)
  while (!interrupted && Date.now() < deadline) {
    const identity = primitives.acquireDirectoryLock(lockPath)
    if (identity) {
      podmanLock = { env, daemon, identity, finishOperationLock: primitives.finishOperationLock }
      if (!ownedDirectory) throw new Error('browser_podman_lock_evidence_directory_missing')
      const receipt = { daemon, endpoint, identity, pid: process.pid, acquiredAt: new Date().toISOString(), artifactDirectory: ownedDirectory.path }
      fs.writeFileSync(path.join(ownedDirectory.path, 'native-podman-lock.json'), JSON.stringify(receipt, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx', mode: 0o600 })
      process.stdout.write(JSON.stringify({ check: 'browser-dev-podman-lock', state: 'acquired', daemon, path: lockPath, waitMs: Date.now() - startedAt }) + '\n')
      return { env, daemon }
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())))
  }
  throw new Error(interrupted ? 'browser_interrupted' : `browser_dev_podman_lock_timeout:${lockPath}`)
}

async function startSidecarCapture({ env, daemon }: PodmanSession, deadline: number): Promise<SidecarCapture> {
  if ((await podmanIdentity(env)) !== daemon) throw new Error('browser_podman_daemon_changed')
  const since = String(Math.floor(Date.now() / 1_000))
  const before = containerIds([], env)
  if (interrupted || Date.now() >= deadline) throw new Error(interrupted ? 'browser_interrupted' : 'dev_runtime_startup_timeout')
  const observer = spawn('podman', ['events', '--since', since, '--filter', 'type=container', '--filter', 'event=create', '--format', EVENT_FORMAT], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture: SidecarCapture = { env, daemon, before, observer, ended: false, stopping: false, bytes: 0,
    images: new Set(), proxyImages: new Set(), events: new Map(), proofs: new Map(), attempted: new Set(), errors: [] }
  let pending = ''
  observer.stdout?.on('data', (chunk: Buffer) => {
    capture.bytes += chunk.length
    if (capture.bytes > 262_144) { sidecarError(capture, 'podman_events_over_budget'); observer.kill(); return }
    pending += chunk.toString('utf8')
    const lines = pending.split('\n'); pending = lines.pop() ?? ''
    if (Buffer.byteLength(pending) > 16_384) { sidecarError(capture, 'podman_event_line_over_budget'); observer.kill(); return }
    for (const line of lines) try {
      const event = JSON.parse(line) as Creation
      event.image = nativeImageIdentity(event.image)
      if (!/^[0-9a-f]{64}$/u.test(event.id) || typeof event.name !== 'string' || typeof event.image !== 'string' || !/^\d+$/u.test(event.time)) throw new Error('podman_event_invalid')
      if (capture.events.size >= 256 && !capture.events.has(event.id)) throw new Error('podman_event_count_over_budget')
      capture.events.set(event.id, event)
      captureOwnedSidecars(capture)
    } catch (error) { sidecarError(capture, error instanceof Error ? error.message : String(error)) }
  })
  observer.stderr?.on('data', () => { if (capture.errors.length < 16) sidecarError(capture, 'podman_event_observer_stderr') })
  observer.once('error', () => { sidecarError(capture, 'podman_event_observer_failed'); capture.ended = true })
  observer.once('close', () => {
    capture.ended = true
    if (pending.trim()) sidecarError(capture, 'podman_event_truncated')
    if (!capture.stopping) sidecarError(capture, 'podman_event_observer_ended_early')
  })
  return capture
}

function nativeImageIdentity(value: string): string {
  if (typeof value !== 'string') throw new Error('native_image_invalid')
  return value.replace(/^localhost\/(?=cloudflare-dev\/sandbox:)/u, '')
    .replace(/^docker\.io\/(?=cloudflare\/proxy-everything)/u, '')
    .replace(/^(cloudflare\/proxy-everything):[a-zA-Z0-9._-]+(?=@sha256:)/u, '$1')
}

function observeNativeImage(line: string, capture: SidecarCapture): void {
  const image = /^Successfully tagged (?:localhost\/)?(cloudflare-dev\/sandbox:[0-9a-f]{8})$/u.exec(line)?.[1]
  const pulled = /^podman-pulled ((?:docker\.io\/)?cloudflare\/proxy-everything:[a-zA-Z0-9._-]+@sha256:[0-9a-f]{64})$/u.exec(line)?.[1]
  const proxy = pulled ? nativeImageIdentity(pulled) : null
  if ((image && !capture.images.has(image) && capture.images.size >= 8)
    || (proxy && !capture.proxyImages.has(proxy) && capture.proxyImages.size >= 2)) { sidecarError(capture, 'native_image_inventory_over_budget'); return }
  if (image) capture.images.add(image)
  if (proxy) capture.proxyImages.add(proxy)
  captureOwnedSidecars(capture)
}

function captureOwnedSidecars(capture: SidecarCapture): void {
  if (capture.errors.length || capture.proxyImages.size === 0) return
  for (const event of capture.events.values()) {
    if (!capture.images.has(event.image) || capture.attempted.has(event.id)) continue
    capture.attempted.add(event.id)
    try {
      if (capture.proofs.size >= 16 || capture.before.has(event.id)
        || !/^workerd-agentic-commerce-sandbox-dev-Sandbox-[0-9a-f]{64}$/u.test(event.name)) throw new Error('owned_main_container_identity_unproven')
      const main = inspectContainer(event.id, capture)
      if (main.id !== event.id || main.name !== `/${event.name}` || main.image !== event.image) throw new Error('owned_main_container_changed')
      const reference = main.network.startsWith('container:') ? main.network.slice(10) : ''
      if (!/^[0-9a-f]{12,64}$/u.test(reference) && reference !== `${event.name}-proxy`) throw new Error('owned_main_proxy_binding_unproven')
      const proxy = inspectContainer(reference, capture)
      const creation = capture.events.get(proxy.id)
      if (capture.before.has(proxy.id) || proxy.name !== `${main.name}-proxy` || !capture.proxyImages.has(proxy.image)
        || !creation || creation.name !== proxy.name.slice(1) || creation.image !== proxy.image
        || BigInt(creation.time) > BigInt(event.time)) throw new Error('owned_proxy_creation_unproven')
      capture.proofs.set(proxy.id, { main, proxy, event: creation })
    } catch (error) { sidecarError(capture, error instanceof Error ? error.message : String(error)) }
  }
}

async function finishSidecarCapture(capture: SidecarCapture, nativeClosed: boolean): Promise<void> {
  capture.stopping = true
  if (!capture.ended) capture.observer.kill('SIGTERM')
  let deadline = Date.now() + 2_000
  while (!capture.ended && Date.now() < deadline) await delay(50)
  if (!capture.ended) {
    capture.observer.kill('SIGKILL'); deadline = Date.now() + 2_000
    while (!capture.ended && Date.now() < deadline) await delay(50)
    sidecarError(capture, 'podman_event_observer_shutdown_unconfirmed')
  }
  if (!nativeClosed) sidecarError(capture, 'native_close_required_before_proxy_cleanup')
  captureOwnedSidecars(capture)
  const unpaired = [...capture.events.values()].filter(event => capture.images.has(event.image) && ![...capture.proofs.values()].some(proof => proof.main.id === event.id))
  if (unpaired.length) sidecarError(capture, 'owned_main_proxy_pair_incomplete')
  if (capture.images.size === 0 || capture.proxyImages.size === 0) sidecarError(capture, 'native_image_inventory_missing')
  const evidence = { daemon: capture.daemon, proofs: [...capture.proofs.values()], errors: capture.errors.slice(0, 16) }
  const evidencePath = ownedDirectory && path.join(ownedDirectory.path, 'native-sidecar-ownership.json')
  if (!evidencePath) throw new Error('sidecar_evidence_directory_missing')
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (capture.errors.length) throw new Error(`browser_sidecar_ownership_incomplete:${capture.errors.slice(0, 8).join(',')}`)
  for (const proof of capture.proofs.values()) {
    if ((await podmanIdentity(capture.env)) !== capture.daemon) throw new Error('browser_podman_daemon_changed')
    if (containerIds(['--filter', `id=${proof.main.id}`], capture.env).size !== 0) throw new Error('browser_owned_main_removal_unconfirmed')
    const ids = containerIds(['--filter', `id=${proof.proxy.id}`], capture.env)
    if (ids.size === 0) { proof.outcome = 'native-removed'; continue }
    if (ids.size !== 1 || !ids.has(proof.proxy.id) || JSON.stringify(inspectContainer(proof.proxy.id, capture)) !== JSON.stringify(proof.proxy)) throw new Error('browser_sidecar_identity_changed')
    const removed = podman(['container', 'rm', '--force', proof.proxy.id], capture.env)
    if (removed !== proof.proxy.id || containerIds(['--filter', `id=${proof.proxy.id}`], capture.env).size !== 0) throw new Error('browser_sidecar_removal_unconfirmed')
    proof.outcome = 'owned-proxy-removed'
  }
  process.stdout.write(JSON.stringify({ check: 'browser-native-sidecars', proofs: [...capture.proofs.values()] }) + '\n')
}

function removeOwnedDirectory(): void {
  if (!ownedDirectory) return
  const current = fs.lstatSync(ownedDirectory.path)
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedDirectory.dev || current.ino !== ownedDirectory.ino) throw new Error('browser_temporary_directory_ownership_changed')
  fs.rmSync(ownedDirectory.path, { recursive: true })
}

async function runRuntimeChild(): Promise<void> {
  if (!process.send) throw new Error('browser_runtime_child_requires_ipc')
  let server: ReturnType<typeof import('wrangler')['createTestHarness']> | null = null
  let startup: Promise<void> | null = null
  let closing: Promise<void> | null = null
  const send = (message: object) => new Promise<void>((resolve, reject) => {
    if (!process.connected) { resolve(); return }
    process.send!(message, error => error ? reject(error) : resolve())
  })
  const close = () => closing ??= (async () => {
    await startup?.catch(() => undefined)
    try {
      await server?.close()
      await send({ type: 'closed' })
    } catch (error) {
      process.exitCode = 1
      await send({ type: 'failure', message: `native_close_failed:${error instanceof Error ? error.message : String(error)}` })
    } finally { if (process.connected) process.disconnect?.() }
  })()
  const start = async (fixture: Fixture) => {
    const { createTestHarness } = await import('wrangler')
    assertNoAmbientVariables()
    const workers = CONFIGS.map(configPath => ({ configPath, env: 'dev', secrets: fixture.secrets, vars: fixture.vars }))
    server = createTestHarness({ root: process.cwd(), workers })
    const { url } = await server.listen()
    // The public harness allocates port0. Bind CORS to its exact origin once before exposing it.
    assertNoAmbientVariables()
    await server.update({ root: process.cwd(), workers: workers.map(worker => ({ ...worker,
      vars: { ...fixture.vars, ALLOWED_ORIGINS_JSON: JSON.stringify([url.origin]) },
    })) })
    const current = await server.listen()
    if (current.url.origin !== url.origin) throw new Error('browser_runtime_origin_changed_during_configuration')
    if (!closing) await send({ type: 'ready', baseUrl: url.origin })
  }
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'close') { void close(); return }
    if (startup || closing || !message || typeof message !== 'object' || !('type' in message) || message.type !== 'start' || !('fixture' in message) || !message.fixture || typeof message.fixture !== 'object') {
      void send({ type: 'failure', message: 'browser_runtime_start_message_invalid' }).then(close)
      return
    }
    startup = start(message.fixture as Fixture)
    void startup.catch(async error => {
      process.exitCode = 1
      await send({ type: 'failure', message: error instanceof Error ? error.message : String(error) })
      void close()
    })
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close() })
  process.on('disconnect', () => { void close() })
}

async function runOwner(): Promise<void> {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true })
  let failure: unknown
  try { await main() } catch (error) { failure = error }
  try {
    await stopOwnedProcesses()
    if (!failure && !interrupted) removeOwnedDirectory()
  } catch (error) {
    failure = new AggregateError(failure ? [failure, error] : [error], 'browser_cleanup_incomplete')
  }
  if (interrupted && !failure) failure = new Error('browser_interrupted')
  const artifactDirectory = failure ? ownedDirectory?.path ?? null : null
  if (artifactDirectory) process.stderr.write(`Browser artifacts preserved: ${artifactDirectory}\n`)
  const causes: string[] = []
  const addCause = (error: unknown): void => {
    if (causes.length >= 8) return
    causes.push((error instanceof Error ? error.message : String(error)).slice(0, 512))
    if (error instanceof AggregateError) for (const nested of error.errors) addCause(nested)
  }
  if (failure) addCause(failure)
  process.stdout.write(JSON.stringify({ ok: !failure, check: 'browser', code: causes[0] ?? null, causes, artifactDirectory }) + '\n')
  if (failure) process.exitCode = 1
}

if (process.argv.length === 3 && process.argv[2] === '--runtime-child') await runRuntimeChild()
else await runOwner()
