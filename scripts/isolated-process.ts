import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type IsolatedProcessInput = Readonly<{
  podmanExecutable: string
  imageId: string
  files: Readonly<Record<string, string>>
  entrypoint: string
  environment?: Readonly<Record<string, string>>
  timeoutMs: number
  maxOutputBytes?: number
  signal?: AbortSignal
}>
export type IsolatedProcessResult = Readonly<{
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
  oomKilled: boolean
  containerRemoved: true
  imageId: string
}>
const BOOTSTRAP = `
import { mkdirSync, writeFileSync } from 'node:fs';
let source = ''; for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source); mkdirSync('/tmp/input', { mode: 0o700 });
for (const [name, bytes] of Object.entries(input.files)) writeFileSync('/tmp/input/' + name, bytes);
await import('file:///tmp/input/' + input.entrypoint);
`;
const LABEL = 'agentic-commerce.execution-id'
const IMAGE_ID = /^(?:sha256:)?[0-9a-f]{64}$/u
const FILE_NAME = /^[a-z][a-z0-9.-]{0,63}$/u
const ENVIRONMENT_KEYS = new Set([
  'AG_SANDBOX_INPUT_PATH', 'AG_SANDBOX_ARTIFACT_PATH', 'AG_SANDBOX_PURPOSE',
  'AG_SANDBOX_MEMORY_LIMIT_MB', 'AG_SANDBOX_TIMEOUT_MS', 'AG_EXECUTABLE_TARGET_PATH',
  'AG_EXECUTABLE_RUNNER_PATH',
])

/** Candidate bytes enter a disposable container; host credentials and sockets never do. */
export async function runIsolatedProcess(input: IsolatedProcessInput): Promise<IsolatedProcessResult> {
  validate(input)
  if (input.signal?.aborted) throw new Error('isolated_process_aborted')
  const executable = realpathSync(input.podmanExecutable)
  accessSync(executable, constants.X_OK)
  const environment = podmanClientEnvironment()
  const command = (args: string[]) => {
    const result = spawnSync(executable, args, { env: environment, encoding: 'utf8',
      timeout: 15_000, maxBuffer: 65_536 })
    if (result.status !== 0) throw new Error(`isolated_process_podman_${args[0]}_failed`)
    return result.stdout.trim()
  }
  assertIsolatedProcessHost(JSON.parse(command(['info', '--format', '{{json .Host}}'])))
  // Resolve an existing immutable image. No pulls, tags, image builds or host shell execution.
  const image = JSON.parse(command(['image', 'inspect', input.imageId]))
  const expectedImage = input.imageId.replace(/^sha256:/u, '')
  if (!Array.isArray(image) || image.length !== 1
    || String(image[0]?.Id).replace(/^sha256:/u, '') !== expectedImage) throw new Error('isolated_process_image_mismatch')
  const executionId = randomUUID(), name = `commerce-isolated-${executionId}`
  let containerId: string | null = null
  let createAttempted = false
  try {
    const args = ['create', '--interactive', '--name', name, '--label', `${LABEL}=${executionId}`,
      '--pull=never', '--network=none', '--read-only', '--read-only-tmpfs=false', '--cap-drop=all',
      '--http-proxy=false', '--image-volume=ignore', '--pid=private', '--ipc=private', '--uts=private',
      '--security-opt=no-new-privileges', '--user=65534:65534', '--memory=256m',
      '--memory-swap=256m', '--pids-limit=64', '--cpus=1', '--log-driver=none',
      `--timeout=${Math.ceil(input.timeoutMs / 1000) + 5}`,
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
      '--workdir=/tmp', '--entrypoint=/usr/local/bin/node']
    for (const [key, value] of Object.entries(input.environment ?? {})) args.push('--env', `${key}=${value}`)
    args.push(input.imageId, '--input-type=module', '-e', BOOTSTRAP)
    createAttempted = true
    containerId = command(args)
    if (!/^[0-9a-f]{64}$/u.test(containerId)) throw new Error('isolated_process_container_identity_invalid')
    assertOwned(command, containerId, executionId, expectedImage)
    const result = await attach(executable, containerId, environment, input, command)
    const state = assertOwned(command, containerId, executionId, expectedImage).State
    if (state?.Running !== false || !Number.isInteger(state.ExitCode)) {
      throw new Error('isolated_process_exit_unproven')
    }
    return Object.freeze({ ...result, exitCode: state.ExitCode,
      oomKilled: state.OOMKilled === true, containerRemoved: true, imageId: expectedImage })
  } finally {
    // Resolve the unique name only after an uncertain create. Never prune by label or prefix.
    if (createAttempted) {
      const owned = containerId ?? name
      const observed = spawnSync(executable, ['container', 'exists', owned], {
        env: environment, timeout: 15_000, stdio: 'ignore',
      })
      if (observed.status === 0) {
        const value = assertOwned(command, owned, executionId, expectedImage)
        if (value.State?.Running === true) command(['kill', '--signal=KILL', value.Id])
        command(['rm', value.Id])
        if (spawnSync(executable, ['container', 'exists', value.Id], {
          env: environment, timeout: 15_000, stdio: 'ignore',
        }).status !== 1) throw new Error('isolated_process_cleanup_unproven')
      } else if (observed.status !== 1) throw new Error('isolated_process_cleanup_unproven')
    }
  }
}

/** Fail before container creation when the engine cannot supply the required isolation evidence. */
export function assertIsolatedProcessHost(host: unknown): void {
  const value = host as { os?: string; cgroupVersion?: string; cgroupControllers?: string[];
    security?: { rootless?: boolean; seccompEnabled?: boolean }; conmon?: { version?: string } } | null
  const version = /^conmon version (\d+)\.(\d+)\.(\d+)(?:,|$)/u.exec(value?.conmon?.version ?? '')
  if (!value || value.os !== 'linux' || value.cgroupVersion !== 'v2'
    || value.security?.rootless !== true || value.security?.seccompEnabled !== true
    || !Array.isArray(value.cgroupControllers)
    || !['cpu', 'memory', 'pids'].every(controller => value.cgroupControllers!.includes(controller))
    || !version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 2)) {
    throw new Error('isolated_process_host_unsupported')
  }
}

function assertOwned(command: (args: string[]) => string, id: string, executionId: string, image: string) {
  const values = JSON.parse(command(['inspect', id]))
  if (!Array.isArray(values) || values.length !== 1
    || values[0]?.Config?.Labels?.[LABEL] !== executionId
    || String(values[0]?.Image).replace(/^sha256:/u, '') !== image
    || !/^[0-9a-f]{64}$/u.test(values[0]?.Id ?? '')) throw new Error('isolated_process_ownership_changed')
  return values[0] as { Id: string; State: { Running: boolean; ExitCode: number; OOMKilled: boolean } }
}

function attach(executable: string, id: string, environment: NodeJS.ProcessEnv,
  input: IsolatedProcessInput, command: (args: string[]) => string) {
  return new Promise<{ stdout: string; stderr: string; timedOut: boolean; outputTruncated: boolean }>((resolve, reject) => {
    const child = spawn(executable, ['start', '--attach', '--interactive', id], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
    const maximum = input.maxOutputBytes ?? 1_048_576
    let bytes = 0, timedOut = false, outputTruncated = false, stopped = false, failure: Error | null = null
    const stop = () => {
      if (stopped) return
      stopped = true
      try { command(['kill', '--signal=KILL', id]) } catch {
        try {
          const state = JSON.parse(command(['inspect', id]))
          if (state.length !== 1 || state[0]?.State?.Running !== false) throw new Error('still_running')
        } catch { failure = new Error('isolated_process_termination_unproven') }
      }
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, input.timeoutMs)
    const abort = () => { timedOut = true; stop() }
    input.signal?.addEventListener('abort', abort, { once: true })
    for (const channel of ['stdout', 'stderr'] as const) child[channel].on('data', (chunk: Buffer) => {
      const remaining = maximum - bytes
      if (remaining > 0) chunks[channel].push(chunk.subarray(0, remaining))
      bytes += Math.min(chunk.length, Math.max(remaining, 0))
      if (chunk.length > remaining) { outputTruncated = true; stop() }
    })
    child.once('error', () => { failure = new Error('isolated_process_attach_failed') })
    child.once('close', () => {
      clearTimeout(timer); input.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else {
        try {
          // Replacement characters can expand malformed bytes past the output cap.
          // A forced stop may cut a valid final code point; omit only that unfinished suffix.
          const decode = (channel: 'stdout' | 'stderr') => new TextDecoder('utf-8', { fatal: true })
            .decode(Buffer.concat(chunks[channel]), { stream: timedOut || outputTruncated })
          resolve({ stdout: decode('stdout'), stderr: decode('stderr'), timedOut, outputTruncated })
        } catch { reject(new Error('isolated_process_output_encoding_invalid')) }
      }
    })
    child.stdin.on('error', () => { /* Early container termination closes stdin. */ })
    child.stdin.end(JSON.stringify({ files: input.files, entrypoint: input.entrypoint }))
    if (input.signal?.aborted) abort()
  })
}

function validate(input: IsolatedProcessInput): void {
  if (!path.isAbsolute(input.podmanExecutable) || !IMAGE_ID.test(input.imageId)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000
    || !FILE_NAME.test(input.entrypoint) || !Object.hasOwn(input.files, input.entrypoint)
    || Object.keys(input.files).length > 16) throw new Error('isolated_process_input_invalid')
  const maximum = input.maxOutputBytes ?? 1_048_576
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_048_576) throw new Error('isolated_process_output_limit_invalid')
  let bytes = 0
  for (const [name, source] of Object.entries(input.files)) {
    if (!FILE_NAME.test(name) || typeof source !== 'string') throw new Error('isolated_process_file_invalid')
    bytes += Buffer.byteLength(source)
  }
  if (bytes > 2_097_152) throw new Error('isolated_process_input_too_large')
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    if (!ENVIRONMENT_KEYS.has(key) || typeof value !== 'string' || value.length > 512 || /[\0\r\n]/u.test(value)) {
      throw new Error('isolated_process_environment_invalid')
    }
  }
}

function podmanClientEnvironment(): NodeJS.ProcessEnv {
  // These variables configure the host CLI only; none is forwarded into the container.
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST',
    'CONTAINER_CONNECTION', 'SSH_AUTH_SOCK'])
  const environment = { ...process.env }
  environment.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key]
  return environment
}
