import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import {
  expectedCheckForRole,
  MAX_CHECK_ARTIFACT_BYTES,
  readVerificationBaseline,
  resolveAttestedEvidenceArtifactRoot,
  writeCheckArtifact,
  type EvidenceContext,
  type EvidenceRole,
} from './evidence-verdict-runner.ts'
import { parseCheckArtifact } from './evidence-check-artifact.ts'
import { parseGovernedCheckCommand } from './evidence-command-policy.ts'
import {
  resolveExternalDispatchTrust,
  verifyEvidenceDispatchReceipt,
  type EvidenceDispatchReceipt,
} from './evidence-dispatch-receipt.ts'
import {
  authoredSourceIsCurrent,
  computeAuthoredSourceFingerprint,
  resolveTrustedGitRuntime,
  sameAuthoredSource,
} from './evidence-source-fingerprint.ts'
import { readEvidenceFile } from './evidence-safe-files.ts'
import { evidenceRuntimeErrorCode, loadEvidenceRuntimeContext } from './evidence-runtime-context.ts'

type CaptureArguments = Readonly<{
  taskId: string
  role: EvidenceRole
  performingMechanism: string
  dispatchReceiptPath: string
}>

export function captureCheckOutput(argumentsValue: CaptureArguments, context: EvidenceContext): Readonly<{
  ok: boolean
  command: string
  descriptor: ReturnType<typeof writeCheckArtifact>
}> {
  if (!context.dispatchTrustAnchor) throw new Error('dispatch_trust_anchor_unavailable')
  if (!context.isolatedCheckExecutor) throw new Error('isolated_check_executor_unavailable')
  if (!context.trustedGitExecutable) throw new Error('trusted_git_unavailable')
  const command = expectedCheckForRole(context, argumentsValue.taskId, argumentsValue.role)
  if (!command) throw new Error('named_check_unresolved')
  const baseline = readVerificationBaseline(context)
  if (!baseline) throw new Error('verification_baseline_invalid')
  const dispatchTrust = resolveExternalDispatchTrust(context.dispatchTrustAnchor, {
    verificationBaselineSha256: baseline.documentSha256,
    implementationBaseline: baseline.implementationBaseline,
    projectedIssuers: baseline.trustedDispatchIssuers,
  })
  if (!dispatchTrust) throw new Error('dispatch_trust_anchor_mismatch')
  if (!resolveAttestedEvidenceArtifactRoot(context, baseline)) throw new Error('evidence_sink_untrusted')
  const trustedGit = resolveTrustedGitRuntime(
    context.workspaceRoot,
    context.trustedGitExecutable,
    context.dispatchTrustAnchor.gitExecutableSha256,
  )
  if (!trustedGit) throw new Error('trusted_git_unavailable')
  const sourceAtStart = computeAuthoredSourceFingerprint(
    context.workspaceRoot,
    baseline.implementationBaseline,
    trustedGit,
  )
  if (!sourceAtStart) throw new Error('source_fingerprint_unavailable')
  const receiptValue = readDispatchReceipt(
    context.workspaceRoot,
    resolveAttestedEvidenceArtifactRoot(context, baseline),
    argumentsValue.dispatchReceiptPath,
  )
  const dispatch = verifyEvidenceDispatchReceipt(receiptValue, {
    taskId: argumentsValue.taskId,
    sourceFingerprint: sourceAtStart,
    trustedIssuers: dispatchTrust.trustedIssuers,
    expectedPerformingMechanism: argumentsValue.performingMechanism,
  })
  if (!dispatch.receipt || dispatch.findings.length > 0) {
    throw new Error(dispatch.findings[0]?.code ?? 'dispatch_receipt_invalid')
  }
  const invocation = parseGovernedCheckCommand(command, {
    agenticCanvasOsRoot: context.agenticCanvasOsRoot ?? null,
  })
  if (!invocation) throw new Error('governed_check_command_unsupported')
  const artifact = parseCheckArtifact(context.isolatedCheckExecutor({
    taskId: argumentsValue.taskId,
    role: argumentsValue.role,
    namedCheck: command,
    invocation,
    workspaceRoot: context.workspaceRoot,
    maxOutputBytes: MAX_CHECK_ARTIFACT_BYTES,
    sourceFingerprint: sourceAtStart,
    dispatchReceipt: dispatch.receipt,
    dispatchTrustPolicyDigest: dispatchTrust.policyDigest,
  }))
  if (!artifact || artifact.namedCheck !== command || artifact.performingMechanism !== dispatch.receipt.performingMechanism
    || artifact.dispatchReceipt.receiptDigest !== dispatch.receipt.receiptDigest
    || artifact.dispatchTrustPolicyDigest !== dispatchTrust.policyDigest
    || !sameAuthoredSource(artifact.sourceFingerprint, sourceAtStart) || !artifact.sourceStable) {
    throw new Error('isolated_check_artifact_invalid')
  }
  if (sanitizeOutput(artifact.stdout, context.workspaceRoot) !== artifact.stdout
    || sanitizeOutput(artifact.stderr, context.workspaceRoot) !== artifact.stderr) {
    throw new Error('isolated_check_artifact_unsanitized')
  }
  if (Buffer.byteLength(artifact.stdout) + Buffer.byteLength(artifact.stderr) > MAX_CHECK_ARTIFACT_BYTES / 2) {
    throw new Error('isolated_check_artifact_oversized')
  }
  const sourceAtEnd = computeAuthoredSourceFingerprint(context.workspaceRoot, baseline.implementationBaseline, trustedGit)
  if (!authoredSourceIsCurrent(sourceAtStart, sourceAtEnd, context.workspaceRoot, trustedGit)) {
    throw new Error('source_changed_during_check')
  }
  const descriptor = writeCheckArtifact(context, argumentsValue.taskId, argumentsValue.role, artifact)
  return Object.freeze({ ok: artifact.ran && artifact.exitCode === 0 && !artifact.outputTruncated, command, descriptor })
}

export function sanitizeOutput(value: string, workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replaceAll('\\', '/')
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replaceAll('\\', '/')
    .replaceAll(normalizedRoot, '<workspace>')
    .replace(/\/(?:Users|home)\/[^/\s"']+\//gu, '<developer-root>/')
    .replace(/\b(Bearer\s+)[a-z0-9._~+/=-]{8,}/giu, '$1<redacted>')
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|password|secret)(\s*[:=]\s*)["'][^"']+["']/giu, '$1$2"<redacted>"')
    .replace(/\r\n/gu, '\n')
}

function parseArguments(values: readonly string[]): CaptureArguments | null {
  const taskId = valueAfter(values, '--task=')
  const role = valueAfter(values, '--role=')
  const performingMechanism = valueAfter(values, '--performer=')
  const dispatchReceiptPath = valueAfter(values, '--dispatch-receipt=')
  if (!taskId || !/^\d+\.\d+$/u.test(taskId) || (role !== 'existing-verification' && role !== 'task-named-check')) return null
  if (!performingMechanism || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(performingMechanism)
    || !dispatchReceiptPath || dispatchReceiptPath.includes('\0')) return null
  return Object.freeze({ taskId, role, performingMechanism, dispatchReceiptPath })
}

function valueAfter(values: readonly string[], prefix: string): string | null {
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
}

function readDispatchReceipt(
  workspaceRoot: string,
  artifactRoot: string | null,
  requestedPath: string,
): EvidenceDispatchReceipt | null {
  const file = artifactRoot ? readEvidenceFile(workspaceRoot, artifactRoot, requestedPath, 64 * 1024) : null
  if (!file) return null
  try {
    return JSON.parse(new TextDecoder().decode(file.bytes)) as EvidenceDispatchReceipt
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const argumentsValue = process.argv.slice(2)
  const captureArguments = parseArguments(argumentsValue)
  if (!captureArguments) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'capture_arguments_invalid' })}\n`)
    process.exitCode = 1
    return
  }
  let result: ReturnType<typeof captureCheckOutput>
  try {
    const context = await loadEvidenceRuntimeContext(process.cwd(), argumentsValue, process.env)
    result = captureCheckOutput(captureArguments, context)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      check: 'evidence-capture',
      code: error instanceof Error && !error.message.startsWith('evidence_runtime_')
        ? error.message
        : evidenceRuntimeErrorCode(error),
    })}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    check: 'evidence-capture',
    taskId: captureArguments.taskId,
    role: captureArguments.role,
    namedCheck: result.command,
    readableSurface: result.descriptor.readableSurface,
    sha256: result.descriptor.sha256,
  })}\n`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
