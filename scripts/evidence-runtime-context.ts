import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
  resolveExternalDispatchTrust,
  type EvidenceDispatchTrustAnchor,
} from './evidence-dispatch-receipt.ts'
import { sha256 } from './evidence-integrity.ts'
import { resolveTrustedGitRuntime } from './evidence-source-fingerprint.ts'
import {
  readVerificationBaseline,
  type EvidenceContext,
  type IsolatedCheckExecutionRequest,
} from './evidence-verdict-runner.ts'

export const ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA = 'agentic-commerce-isolated-check-executor-module/v1'

export const EVIDENCE_RUNTIME_INPUTS = Object.freeze({
  dispatchTrustAnchor: Object.freeze({
    flag: '--dispatch-trust-anchor=',
    environment: 'AGENTIC_COMMERCE_EVIDENCE_DISPATCH_TRUST_ANCHOR',
  }),
  trustedGitExecutable: Object.freeze({
    flag: '--trusted-git-executable=',
    environment: 'AGENTIC_COMMERCE_EVIDENCE_TRUSTED_GIT_EXECUTABLE',
  }),
  agenticCanvasOsRoot: Object.freeze({
    flag: '--agentic-canvas-os-root=',
    environment: 'AGENTIC_COMMERCE_EVIDENCE_AGENTIC_CANVAS_OS_ROOT',
  }),
  isolatedExecutorModule: Object.freeze({
    flag: '--isolated-executor-module=',
    environment: 'AGENTIC_COMMERCE_EVIDENCE_ISOLATED_EXECUTOR_MODULE',
  }),
})

export type EvidenceRuntimeContextErrorCode =
  | 'evidence_runtime_context_ambiguous'
  | 'evidence_runtime_context_incomplete'
  | 'evidence_runtime_path_invalid'
  | 'evidence_runtime_source_candidate_controlled'
  | 'dispatch_trust_anchor_invalid'
  | 'trusted_git_unavailable'
  | 'agentic_canvas_os_root_invalid'
  | 'isolated_executor_module_invalid'
  | 'isolated_executor_module_changed'
  | 'isolated_executor_async_result'

export class EvidenceRuntimeContextError extends Error {
  readonly code: EvidenceRuntimeContextErrorCode

  constructor(code: EvidenceRuntimeContextErrorCode) {
    super(code)
    this.name = 'EvidenceRuntimeContextError'
    this.code = code
  }
}

export async function loadEvidenceRuntimeContext(
  workspaceRoot: string,
  argumentsValue: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EvidenceContext> {
  const workspace = realDirectory(workspaceRoot)
  if (!workspace) throw runtimeError('evidence_runtime_path_invalid')
  const requested = Object.freeze({
    dispatchTrustAnchor: runtimeValue(argumentsValue, environment, EVIDENCE_RUNTIME_INPUTS.dispatchTrustAnchor),
    trustedGitExecutable: runtimeValue(argumentsValue, environment, EVIDENCE_RUNTIME_INPUTS.trustedGitExecutable),
    agenticCanvasOsRoot: runtimeValue(argumentsValue, environment, EVIDENCE_RUNTIME_INPUTS.agenticCanvasOsRoot),
    isolatedExecutorModule: runtimeValue(argumentsValue, environment, EVIDENCE_RUNTIME_INPUTS.isolatedExecutorModule),
  })
  if (Object.values(requested).some((value) => value === null)) {
    throw runtimeError('evidence_runtime_context_incomplete')
  }

  const anchorFile = externalFile(workspace, required(requested.dispatchTrustAnchor), 256 * 1024)
  const anchorValue = parseJson(anchorFile.bytes)
  const baseline = readVerificationBaseline({ workspaceRoot: workspace })
  if (!baseline || !isRecord(anchorValue) || anchorValue.schema !== EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA) {
    throw runtimeError('dispatch_trust_anchor_invalid')
  }
  const dispatchTrust = resolveExternalDispatchTrust(anchorValue, {
    verificationBaselineSha256: baseline.documentSha256,
    implementationBaseline: baseline.implementationBaseline,
    projectedIssuers: baseline.trustedDispatchIssuers,
  })
  if (!dispatchTrust) throw runtimeError('dispatch_trust_anchor_invalid')
  const dispatchTrustAnchor = anchorValue as EvidenceDispatchTrustAnchor

  const trustedGitRequested = required(requested.trustedGitExecutable)
  assertExternalLexicalPath(workspace, trustedGitRequested)
  const trustedGit = resolveTrustedGitRuntime(workspace, trustedGitRequested, dispatchTrustAnchor.gitExecutableSha256)
  if (!trustedGit) throw runtimeError('trusted_git_unavailable')

  const agenticCanvasOsRoot = externalDirectory(workspace, required(requested.agenticCanvasOsRoot))
  if (!hasLifecycleCheck(workspace, agenticCanvasOsRoot)) throw runtimeError('agentic_canvas_os_root_invalid')

  const executorFile = externalFile(workspace, required(requested.isolatedExecutorModule), 2 * 1024 * 1024)
  if (!['.js', '.mjs'].includes(path.extname(executorFile.path))) {
    throw runtimeError('isolated_executor_module_invalid')
  }
  let namespace: unknown
  try {
    namespace = await import(`${pathToFileURL(executorFile.path).href}?sha256=${executorFile.sha256}`) as unknown
  } catch {
    throw runtimeError('isolated_executor_module_invalid')
  }
  if (!isRecord(namespace) || namespace.schema !== ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA
    || typeof namespace.isolatedCheckExecutor !== 'function') {
    throw runtimeError('isolated_executor_module_invalid')
  }
  assertExternalFileUnchanged(workspace, executorFile)
  const externalExecutor = namespace.isolatedCheckExecutor as (request: IsolatedCheckExecutionRequest) => unknown
  const isolatedCheckExecutor = (request: IsolatedCheckExecutionRequest): unknown => {
    assertExternalFileUnchanged(workspace, executorFile)
    const result = externalExecutor(request)
    if (isPromiseLike(result)) throw runtimeError('isolated_executor_async_result')
    assertExternalFileUnchanged(workspace, executorFile)
    return result
  }
  return Object.freeze({
    workspaceRoot: workspace,
    dispatchTrustAnchor,
    trustedGitExecutable: trustedGit.executable,
    agenticCanvasOsRoot,
    isolatedCheckExecutor,
  })
}

export function evidenceRuntimeErrorCode(error: unknown): string {
  return error instanceof EvidenceRuntimeContextError ? error.code : 'evidence_runtime_context_invalid'
}

type RuntimeInput = Readonly<{ flag: string; environment: string }>
type ExternalFile = Readonly<{ path: string; bytes: Buffer; sha256: string }>

function runtimeValue(
  argumentsValue: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  input: RuntimeInput,
): string | null {
  if (argumentsValue.includes(input.flag.slice(0, -1))) throw runtimeError('evidence_runtime_path_invalid')
  const flagValues = argumentsValue.filter((value) => value.startsWith(input.flag)).map((value) => value.slice(input.flag.length))
  if (flagValues.length > 1) throw runtimeError('evidence_runtime_context_ambiguous')
  const fromFlag = flagValues[0]
  const fromEnvironment = environment[input.environment]
  if (fromFlag !== undefined && fromEnvironment !== undefined && fromFlag !== fromEnvironment) {
    throw runtimeError('evidence_runtime_context_ambiguous')
  }
  const selected = fromFlag ?? fromEnvironment ?? null
  if (selected !== null && (!selected || selected.includes('\0') || selected.trim() !== selected)) {
    throw runtimeError('evidence_runtime_path_invalid')
  }
  return selected
}

function externalFile(workspaceRoot: string, requested: string, maximumBytes: number): ExternalFile {
  assertExternalLexicalPath(workspaceRoot, requested)
  try {
    const lexical = path.resolve(requested)
    const linkStat = fs.lstatSync(lexical, { bigint: true })
    if (linkStat.isSymbolicLink()) throw runtimeError('evidence_runtime_path_invalid')
    const resolved = fs.realpathSync(lexical)
    if (overlaps(workspaceRoot, resolved)) throw runtimeError('evidence_runtime_source_candidate_controlled')
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const before = fs.fstatSync(descriptor, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes)) {
        throw runtimeError('evidence_runtime_path_invalid')
      }
      const bytes = fs.readFileSync(descriptor)
      const after = fs.fstatSync(descriptor, { bigint: true })
      if (!sameStableFile(before, after) || BigInt(bytes.byteLength) !== before.size) {
        throw runtimeError('evidence_runtime_path_invalid')
      }
      return Object.freeze({ path: resolved, bytes, sha256: sha256(bytes) })
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
  } catch (error) {
    if (error instanceof EvidenceRuntimeContextError) throw error
    throw runtimeError('evidence_runtime_path_invalid')
  }
}

function externalDirectory(workspaceRoot: string, requested: string): string {
  assertExternalLexicalPath(workspaceRoot, requested)
  try {
    const lexical = path.resolve(requested)
    const before = fs.lstatSync(lexical, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) throw runtimeError('evidence_runtime_path_invalid')
    const resolved = fs.realpathSync(lexical)
    const after = fs.lstatSync(lexical, { bigint: true })
    if (!sameStableFile(before, after) || overlaps(workspaceRoot, resolved)) {
      throw runtimeError('evidence_runtime_source_candidate_controlled')
    }
    return resolved
  } catch (error) {
    if (error instanceof EvidenceRuntimeContextError) throw error
    throw runtimeError('evidence_runtime_path_invalid')
  }
}

function assertExternalLexicalPath(workspaceRoot: string, requested: string): void {
  if (!path.isAbsolute(requested) || requested.includes('\0')) throw runtimeError('evidence_runtime_path_invalid')
  if (overlaps(workspaceRoot, path.resolve(requested))) {
    throw runtimeError('evidence_runtime_source_candidate_controlled')
  }
}

function assertExternalFileUnchanged(workspaceRoot: string, expected: ExternalFile): void {
  let current: ExternalFile
  try {
    current = externalFile(workspaceRoot, expected.path, expected.bytes.byteLength)
  } catch {
    throw runtimeError('isolated_executor_module_changed')
  }
  if (current.path !== expected.path || current.sha256 !== expected.sha256) {
    throw runtimeError('isolated_executor_module_changed')
  }
}

function hasLifecycleCheck(workspaceRoot: string, root: string): boolean {
  try {
    const value = parseJson(externalFile(workspaceRoot, path.join(root, 'package.json'), 2 * 1024 * 1024).bytes)
    return isRecord(value) && isRecord(value.scripts) && typeof value.scripts['worktree:lifecycle:check'] === 'string'
  } catch {
    return false
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function required(value: string | null): string {
  if (value === null) throw runtimeError('evidence_runtime_context_incomplete')
  return value
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left)
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function realDirectory(requested: string): string | null {
  try {
    const resolved = fs.realpathSync(path.resolve(requested))
    return fs.statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function runtimeError(code: EvidenceRuntimeContextErrorCode): EvidenceRuntimeContextError {
  return new EvidenceRuntimeContextError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
