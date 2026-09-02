import { isHttpFailure, jsonResponse, readJsonObject } from '../shared/http.js'
import {
  canonicalJson,
  MAXIMUM_SANDBOX_PACKAGE_BYTES,
  parseSandboxProofRequest,
  SANDBOX_PROOF_BOUNDS,
  SANDBOX_PROOF_COMMANDS,
  SANDBOX_PROOF_IMAGE,
  SANDBOX_PROOF_PACKAGE_VERSION,
  SANDBOX_UNSIGNED_PROOF_SCHEMA,
  sha256Hex,
  validSandboxProofBearer,
  type SandboxProofRequest,
} from './provision-contract.js'
import { SANDBOX_PROVISION_HARNESS_SOURCE } from './provision-harness.js'

const PROOF_PATH = '/v1/provision-proof'
const WORKSPACE_PATH = '/workspace/agentic-commerce-proof'
const INSTALL_COMMAND = 'npm ci --ignore-scripts --no-audit --no-fund'
const MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024
const EXTRACTION_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 300_000
const DESTROY_TIMEOUT_MS = 4_750
const PROOF_COMMAND_ENV = Object.freeze({
  CI: 'true',
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  NPM_CONFIG_USERCONFIG: '/dev/null',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
})

type CommandResult = Readonly<{
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
}>

export type SandboxProofRuntime = Readonly<{
  writeFile(path: string, content: string): Promise<unknown>
  readFile(path: string, options?: { encoding?: 'utf8' }): Promise<Readonly<{ content: string }>>
  exec(command: string, options: Readonly<{
    cwd?: string
    env?: Readonly<Record<string, string>>
    timeout: number
  }>): Promise<CommandResult>
  destroy(): Promise<void>
}>

export type SandboxProofWorkerEnv = Readonly<{
  Sandbox: DurableObjectNamespace
  SANDBOX_PROOF_BEARER_TOKEN?: string
}>

export type SandboxProofOptions = Readonly<{
  createSandbox?: (
    namespace: DurableObjectNamespace,
    instanceIdentity: string,
  ) => SandboxProofRuntime
  createInstanceIdentity?: () => string
  now?: () => number
}>

export function isSandboxProofRequest(request: Request): boolean {
  const url = new URL(request.url)
  return url.pathname === PROOF_PATH
}

export async function handleSandboxProofRequest(
  request: Request,
  env: SandboxProofWorkerEnv,
  options: SandboxProofOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ ok: false, code: 'method_not_allowed' }, 405)
  if (!await validSandboxProofBearer(request, env.SANDBOX_PROOF_BEARER_TOKEN)) {
    return jsonResponse({ ok: false, code: 'sandbox_proof_unauthorized' }, 401)
  }
  const input = await readJsonObject(request, MAXIMUM_SANDBOX_PACKAGE_BYTES)
  if (isHttpFailure(input)) return jsonResponse(input, 400)
  const parsed = await parseSandboxProofRequest(input)
  if (!parsed) return jsonResponse({ ok: false, code: 'sandbox_proof_request_invalid' }, 400)

  const now = options.now ?? Date.now
  const instanceIdentity = (options.createInstanceIdentity ?? randomInstanceIdentity)()
  if (!/^proof-[a-z0-9]{32}$/u.test(instanceIdentity)) {
    return jsonResponse({ ok: false, code: 'sandbox_proof_instance_identity_invalid' }, 500)
  }
  if (!options.createSandbox) {
    return jsonResponse({ ok: false, code: 'sandbox_proof_runtime_unavailable' }, 503)
  }
  const sandbox = options.createSandbox(env.Sandbox, instanceIdentity)
  const provisionedAtMs = now()
  let lanes: readonly ReceiptLane[] | null = null
  let browser: BrowserObservation | null = null
  let failure: ProofFailure | null = null
  let terminationRequestedAtMs = 0
  let terminationCompletedAtMs = 0

  try {
    const executionId = instanceIdentity.slice('proof-'.length)
    const sourcePath = `/tmp/ag-proof-${executionId}-source.json`
    const harnessPath = `/tmp/ag-proof-${executionId}-harness.mjs`
    const extractionPath = `/tmp/ag-proof-${executionId}-extract.json`
    const inspectionPath = `/tmp/ag-proof-${executionId}-inspect.json`
    await Promise.all([
      sandbox.writeFile(sourcePath, canonicalJson(parsed.sourcePackage)),
      sandbox.writeFile(harnessPath, SANDBOX_PROVISION_HARNESS_SOURCE),
    ])
    const harnessEnvironment = Object.freeze({
      AG_SANDBOX_SOURCE_PACKAGE_PATH: sourcePath,
      AG_SANDBOX_WORKSPACE: WORKSPACE_PATH,
      AG_SANDBOX_INSPECTION_PATH: extractionPath,
      AG_SANDBOX_PROOF_MODE: 'extract',
    })
    requireSuccess(await sandbox.exec(`node ${harnessPath}`, {
      timeout: EXTRACTION_TIMEOUT_MS,
      env: harnessEnvironment,
    }), 'sandbox_proof_extraction_failed')
    const extraction = parseExtraction(await readText(sandbox, extractionPath))
    if (!extraction || extraction.packageDigest !== parsed.sourcePackage.packageDigest
      || extraction.sourceFingerprintDigest !== parsed.sourcePackage.sourceFingerprint.fingerprintDigest) {
      throw new ProofFailure('sandbox_proof_extraction_invalid', 422)
    }

    requireSuccess(await sandbox.exec(INSTALL_COMMAND, {
      cwd: WORKSPACE_PATH,
      timeout: INSTALL_TIMEOUT_MS,
      env: PROOF_COMMAND_ENV,
    }), 'sandbox_proof_install_failed')

    lanes = Object.freeze(await runProofLanes(sandbox, instanceIdentity, now))

    requireSuccess(await sandbox.exec(`node ${harnessPath}`, {
      timeout: EXTRACTION_TIMEOUT_MS,
      env: Object.freeze({
        ...harnessEnvironment,
        AG_SANDBOX_INSPECTION_PATH: inspectionPath,
        AG_SANDBOX_PROOF_MODE: 'inspect',
      }),
    }), 'sandbox_proof_inspection_failed')
    const inspection = parseInspection(await readText(sandbox, inspectionPath))
    if (!inspection || !nodeVersionSupported(inspection.nodeVersion)) {
      throw new ProofFailure('sandbox_proof_runtime_invalid', 422)
    }
    browser = inspection.browser
  } catch (error) {
    failure = error instanceof ProofFailure ? error : new ProofFailure('sandbox_proof_execution_failed', 503)
  } finally {
    terminationRequestedAtMs = now()
    try {
      await withTimeout(sandbox.destroy(), DESTROY_TIMEOUT_MS)
      terminationCompletedAtMs = now()
      if (terminationCompletedAtMs - terminationRequestedAtMs
        > SANDBOX_PROOF_BOUNDS.terminationGraceSeconds * 1_000) {
        failure = new ProofFailure('sandbox_proof_destroy_deadline_exceeded', 503)
      }
    } catch {
      failure = new ProofFailure('sandbox_proof_destroy_failed', 503)
    }
  }

  if (failure || !lanes || !browser) {
    return jsonResponse({ ok: false, code: failure?.code ?? 'sandbox_proof_incomplete' }, failure?.status ?? 503)
  }
  const issuedAtMs = now()
  const receiptBody = await buildReceiptBody(parsed, {
    instanceIdentity,
    provisionedAtMs,
    browser,
    lanes,
    terminationRequestedAtMs,
    terminationCompletedAtMs,
    issuedAtMs,
  })
  return jsonResponse({
    ok: true,
    schema: SANDBOX_UNSIGNED_PROOF_SCHEMA,
    receiptBody,
    receiptDigest: await sha256Hex(canonicalJson(receiptBody)),
  })
}

async function runProofLanes(
  sandbox: SandboxProofRuntime,
  instanceIdentity: string,
  now: () => number,
): Promise<ReceiptLane[]> {
  const lanes: ReceiptLane[] = []
  for (const expected of SANDBOX_PROOF_COMMANDS) {
    const startedAtMs = now()
    let result: CommandResult
    try {
      result = await sandbox.exec(expected.command, {
        cwd: WORKSPACE_PATH,
        timeout: SANDBOX_PROOF_BOUNDS.wallClockSeconds * 1_000,
        env: PROOF_COMMAND_ENV,
      })
    } catch {
      throw new ProofFailure(`sandbox_proof_lane_${expected.taskId.replace('.', '_')}_failed`, 422)
    }
    const completedAtMs = now()
    if (!result.success || result.exitCode !== 0 || completedAtMs - startedAtMs
      > SANDBOX_PROOF_BOUNDS.wallClockSeconds * 1_000) {
      throw new ProofFailure(`sandbox_proof_lane_${expected.taskId.replace('.', '_')}_failed`, 422)
    }
    const stdout = new TextEncoder().encode(result.stdout)
    const stderr = new TextEncoder().encode(result.stderr)
    if (stdout.byteLength < 1 || stdout.byteLength + stderr.byteLength > MAXIMUM_OUTPUT_BYTES) {
      throw new ProofFailure('sandbox_proof_lane_output_unbounded', 422)
    }
    const output = Object.freeze({
      exitCode: 0 as const,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      stdoutSha256: await sha256Hex(stdout),
      stderrSha256: await sha256Hex(stderr),
      outputTruncated: false as const,
    })
    lanes.push(Object.freeze({
      taskId: expected.taskId,
      command: expected.command,
      commandSha256: await sha256Hex(expected.command),
      instanceIdentity,
      startedAtMs,
      completedAtMs,
      ...output,
      outputSha256: await sha256Hex(canonicalJson(output)),
    }))
  }
  return lanes
}

async function buildReceiptBody(
  request: SandboxProofRequest,
  observation: Readonly<{
    instanceIdentity: string
    provisionedAtMs: number
    browser: BrowserObservation
    lanes: readonly ReceiptLane[]
    terminationRequestedAtMs: number
    terminationCompletedAtMs: number
    issuedAtMs: number
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const receiptId = await sha256Hex(canonicalJson({
    nonce: request.nonce,
    packageDigest: request.sourcePackage.packageDigest,
    instanceIdentity: observation.instanceIdentity,
    lanes: observation.lanes,
    terminationCompletedAtMs: observation.terminationCompletedAtMs,
  }))
  return Object.freeze({
    schema: 'agentic-commerce-sandbox-provision-receipt/v1',
    receiptId,
    sourceFingerprint: request.sourcePackage.sourceFingerprint,
    sandboxPackageVersion: SANDBOX_PROOF_PACKAGE_VERSION,
    sandboxImage: SANDBOX_PROOF_IMAGE,
    instance: Object.freeze({
      provider: 'cloudflare-sandbox',
      identity: observation.instanceIdentity,
      provisionedAtMs: observation.provisionedAtMs,
    }),
    browser: observation.browser,
    lanes: observation.lanes,
    resourceBounds: SANDBOX_PROOF_BOUNDS,
    termination: Object.freeze({
      instanceIdentity: observation.instanceIdentity,
      outcome: 'destroyed',
      requestedAtMs: observation.terminationRequestedAtMs,
      completedAtMs: observation.terminationCompletedAtMs,
    }),
    issuedAtMs: observation.issuedAtMs,
    expiresAtMs: observation.issuedAtMs + request.validityMs,
    issuer: request.issuer,
    issuerKeyId: request.issuerKeyId,
  })
}

type ReceiptLane = Readonly<{
  taskId: '12.4' | '12.7'
  command: string
  commandSha256: string
  instanceIdentity: string
  startedAtMs: number
  completedAtMs: number
  exitCode: 0
  stdoutBytes: number
  stderrBytes: number
  stdoutSha256: string
  stderrSha256: string
  outputTruncated: false
  outputSha256: string
}>

type BrowserObservation = Readonly<{
  engine: 'Chromium'
  version: number
  executableSha256: string
  supportedBrowsers: readonly Readonly<{ name: string; minimumVersion: number }>[]
}>

function parseExtraction(value: string): Readonly<{
  packageDigest: string
  sourceFingerprintDigest: string
}> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed.ok === true && parsed.mode === 'extract' && digest(parsed.packageDigest)
      && digest(parsed.sourceFingerprintDigest)
      ? Object.freeze({
        packageDigest: parsed.packageDigest,
        sourceFingerprintDigest: parsed.sourceFingerprintDigest,
      })
      : null
  } catch {
    return null
  }
}

function parseInspection(value: string): Readonly<{
  nodeVersion: string
  browser: BrowserObservation
}> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const browser = parsed.browser as Record<string, unknown>
    if (parsed.ok !== true || parsed.mode !== 'inspect' || typeof parsed.nodeVersion !== 'string'
      || parsed.playwrightVersion !== '1.62.1' || !browser || browser.engine !== 'Chromium'
      || !Number.isSafeInteger(browser.version) || Number(browser.version) < 151
      || !digest(browser.executableSha256) || !Array.isArray(browser.supportedBrowsers)) return null
    const supportedBrowsers: Array<Readonly<{ name: string; minimumVersion: number }>> = []
    let prior = ''
    for (const support of browser.supportedBrowsers) {
      if (!support || typeof support !== 'object') return null
      const candidate = support as Record<string, unknown>
      if (typeof candidate.name !== 'string' || !Number.isSafeInteger(candidate.minimumVersion)
        || Number(candidate.minimumVersion) < 1 || prior.localeCompare(candidate.name) >= 0) return null
      prior = candidate.name
      supportedBrowsers.push(Object.freeze({ name: candidate.name, minimumVersion: Number(candidate.minimumVersion) }))
    }
    if (supportedBrowsers.length < 1) return null
    return Object.freeze({
      nodeVersion: parsed.nodeVersion,
      browser: Object.freeze({
        engine: 'Chromium',
        version: Number(browser.version),
        executableSha256: browser.executableSha256,
        supportedBrowsers: Object.freeze(supportedBrowsers),
      }),
    })
  } catch {
    return null
  }
}

async function readText(sandbox: SandboxProofRuntime, path: string): Promise<string> {
  const result = await sandbox.readFile(path, { encoding: 'utf8' })
  if (typeof result.content !== 'string' || result.content.length < 2 || result.content.length > 64 * 1024) {
    throw new ProofFailure('sandbox_proof_artifact_invalid', 422)
  }
  return result.content
}

function nodeVersionSupported(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return Boolean(major! > 22 || (major === 22 && (minor! > 22 || (minor === 22 && patch! >= 0))))
}

function requireSuccess(result: CommandResult, code: string): void {
  if (!result.success || result.exitCode !== 0) throw new ProofFailure(code, 422)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('sandbox_proof_destroy_timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function randomInstanceIdentity(): string {
  return `proof-${crypto.randomUUID().replaceAll('-', '')}`
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

class ProofFailure extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'ProofFailure'
  }
}
