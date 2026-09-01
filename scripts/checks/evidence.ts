import { Buffer } from 'node:buffer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkArtifactRelativePath,
  canonicalJson,
  EVIDENCE_REQUEST_SCHEMA,
  evaluateEvidenceRequest,
  expectedCheckForRole,
  readTaskBoundsSnapshot,
  readVerificationBaseline,
  resolveAttestedEvidenceArtifactRoot,
  runEvidenceVerdict,
  sha256,
  validatePersistedVerdict,
  type EvidenceContext,
  type EvidenceRequest,
  type EvidenceRole,
  type EvidenceVerdict,
} from '../evidence-verdict-runner.ts'
import type { Assertion } from './common.ts'
import {
  authoredSourceIsCurrent,
  computeAuthoredSourceFingerprint,
  resolveTrustedGitRuntime,
  type AuthoredSourceFingerprint,
  type TrustedGitRuntime,
} from '../evidence-source-fingerprint.ts'
import { resolveExternalDispatchTrust } from '../evidence-dispatch-receipt.ts'
import {
  listEvidenceJsonFiles,
  readEvidenceFile,
} from '../evidence-safe-files.ts'
import { evidenceRuntimeErrorCode, loadEvidenceRuntimeContext } from '../evidence-runtime-context.ts'

const MAXIMUM_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024
const MAXIMUM_VERDICT_DIRECTORY_ENTRIES = 256
const MAXIMUM_VERDICT_DIRECTORY_BYTES = 64 * 1024 * 1024

function issueTaskVerdict(context: EvidenceContext, requestedTaskId: string, argumentsValue: readonly string[]): void {
  const performingMechanism = argument(argumentsValue, '--performer=')
  const verdictIssuingMechanism = argument(argumentsValue, '--evaluator=')
  const baseline = readVerificationBaseline(context)
  if (!performingMechanism || !verdictIssuingMechanism || !baseline) {
    process.stdout.write(`${JSON.stringify({ ok: false, check: 'evidence', code: 'verdict_arguments_invalid' })}\n`)
    process.exitCode = 1
    return
  }
  const roles = ['existing-verification', 'task-named-check'] as const
  const surfaces = roles.map((role) => surfaceFor(context, requestedTaskId, role, baseline.evidenceArtifactDirectory))
  const request: EvidenceRequest = Object.freeze({
    schema: EVIDENCE_REQUEST_SCHEMA,
    taskId: requestedTaskId,
    performingMechanism,
    verdictIssuingMechanism,
    openFindings: Object.freeze(argumentsValue
      .filter((value) => value.startsWith('--finding='))
      .map((value) => value.slice('--finding='.length))),
    surfaces: Object.freeze(surfaces),
  })
  const outcome = runEvidenceVerdict(request, context)
  process.stdout.write(`${JSON.stringify({
    ok: outcome.verdict.status === 'verified',
    check: 'evidence',
    taskId: requestedTaskId,
    status: outcome.verdict.status,
    referenceCount: outcome.verdict.references.length,
    findingCount: outcome.verdict.findings.length,
    outputPath: outcome.outputPath,
    verdictDigest: outcome.verdict.verdictDigest,
  })}\n`)
  if (outcome.verdict.status !== 'verified') process.exitCode = 1
}

export function evaluateEvidenceGate(context: EvidenceContext): Readonly<Record<string, unknown> & { ok: boolean }> {
  const baseline = readVerificationBaseline(context)
  const snapshot = readTaskBoundsSnapshot(context)
  const dispatchTrust = baseline && context.dispatchTrustAnchor
    ? resolveExternalDispatchTrust(context.dispatchTrustAnchor, {
      verificationBaselineSha256: baseline.documentSha256,
      implementationBaseline: baseline.implementationBaseline,
      projectedIssuers: baseline.trustedDispatchIssuers,
    })
    : null
  const trustedGit = dispatchTrust && context.dispatchTrustAnchor
    ? resolveTrustedGitRuntime(
      context.workspaceRoot,
      context.trustedGitExecutable,
      context.dispatchTrustAnchor.gitExecutableSha256,
    )
    : null
  const sourceAtStart = baseline && trustedGit
    ? computeAuthoredSourceFingerprint(context.workspaceRoot, baseline.implementationBaseline, trustedGit)
    : null
  const artifactRoot = baseline ? resolveAttestedEvidenceArtifactRoot(context, baseline) : null
  const expectedTaskIds = snapshot
    ? snapshot.namedCheckGroups.flatMap(({ taskIds }) => taskIds).sort(compareTaskIds)
    : []
  const audit = baseline && sourceAtStart && trustedGit && artifactRoot
    ? auditPersistedVerdicts(context, artifactRoot, expectedTaskIds, sourceAtStart, trustedGit)
    : Object.freeze({
    expectedCount: expectedTaskIds.length,
    verdictCount: 0,
    verifiedCount: 0,
    failedCount: 0,
    invalidCount: 0,
    staleCount: 0,
    missingCount: expectedTaskIds.length,
    duplicateCount: 0,
    extraCount: 0,
    })
  const sourceAtEnd = baseline && trustedGit
    ? computeAuthoredSourceFingerprint(context.workspaceRoot, baseline.implementationBaseline, trustedGit)
    : null
  const assertions: Assertion[] = [
    { condition: Boolean(baseline), detail: 'verification baseline names the aggregate gate and governed artifact directory' },
    { condition: Boolean(sourceAtStart), detail: 'implementation baseline is well-formed, reachable, and bound to the current authored source' },
    { condition: Boolean(dispatchTrust), detail: 'external evaluator trust anchor matches the exact baseline projection and policy digest' },
    { condition: Boolean(artifactRoot), detail: 'external evaluator attests exclusive stable ownership of evidence-sink ancestry' },
    { condition: Boolean(trustedGit), detail: 'external evaluator pins an absolute out-of-workspace Git executable and exact binary digest' },
    { condition: Boolean(trustedGit && authoredSourceIsCurrent(sourceAtStart, sourceAtEnd, context.workspaceRoot, trustedGit)), detail: 'authored source remains stable during aggregate evaluation' },
    { condition: Boolean(snapshot && snapshot.taskCount === snapshot.boundsCount), detail: 'portable task snapshot resolves every exact named check' },
    { condition: audit.expectedCount > 0 && audit.expectedCount === snapshot?.taskCount, detail: 'snapshot supplies the exact non-empty task-ID completion set' },
    { condition: audit.invalidCount === 0, detail: 'persisted verdict artifacts are readable and digest-valid' },
    { condition: audit.staleCount === 0, detail: 'verified verdicts still resolve their exact surfaced check artifacts' },
    { condition: audit.missingCount === 0, detail: 'every expected task has one persisted verdict artifact' },
    { condition: audit.duplicateCount === 0, detail: 'no task has more than one persisted verdict artifact' },
    { condition: audit.extraCount === 0, detail: 'no persisted verdict belongs to a task outside the snapshot' },
    { condition: audit.failedCount === 0, detail: 'every persisted task verdict has verified status' },
    { condition: audit.verifiedCount === audit.expectedCount, detail: 'every expected task has exactly one current digest-valid verified verdict' },
  ]
  const failures = assertions.filter(({ condition }) => !condition)
  return Object.freeze({
    ok: failures.length === 0,
    check: 'evidence',
    sourceFingerprintDigest: sourceAtStart?.fingerprintDigest ?? null,
    dispatchTrustPolicyDigest: dispatchTrust?.policyDigest ?? null,
    assertionCount: assertions.length,
    expectedTaskCount: audit.expectedCount,
    verdictArtifactCount: audit.verdictCount,
    verifiedTaskCount: audit.verifiedCount,
    failedVerdictCount: audit.failedCount,
    invalidVerdictCount: audit.invalidCount,
    staleVerdictCount: audit.staleCount,
    missingVerdictCount: audit.missingCount,
    duplicateVerdictCount: audit.duplicateCount,
    extraVerdictCount: audit.extraCount,
    failures: failures.map(({ detail }) => detail),
  })
}

function surfaceFor(
  context: EvidenceContext,
  task: string,
  role: EvidenceRole,
  artifactDirectory: string,
): EvidenceRequest['surfaces'][number] {
  const namedCheck = expectedCheckForRole(context, task, role) ?? 'unresolved'
  const readableSurface = path.posix.join(artifactDirectory, checkArtifactRelativePath(task, role))
  const baseline = readVerificationBaseline(context)
  const artifactRoot = baseline ? resolveAttestedEvidenceArtifactRoot(context, baseline) : null
  const file = artifactRoot
    ? readEvidenceFile(context.workspaceRoot, artifactRoot, readableSurface, MAXIMUM_EVIDENCE_FILE_BYTES)
    : null
  const digest = file ? sha256(file.bytes) : '0'.repeat(64)
  return Object.freeze({ role, namedCheck, readableSurface, sha256: digest })
}

function auditPersistedVerdicts(
  context: EvidenceContext,
  artifactRoot: string,
  expectedTaskIds: readonly string[],
  currentSourceFingerprint: AuthoredSourceFingerprint,
  trustedGit: TrustedGitRuntime,
): Readonly<{
  expectedCount: number
  verdictCount: number
  verifiedCount: number
  failedCount: number
  invalidCount: number
  staleCount: number
  missingCount: number
  duplicateCount: number
  extraCount: number
}> {
  const expected = new Set(expectedTaskIds)
  const files = listEvidenceJsonFiles(context.workspaceRoot, artifactRoot, 'verdicts', {
    maximumEntries: MAXIMUM_VERDICT_DIRECTORY_ENTRIES,
    maximumFileBytes: MAXIMUM_EVIDENCE_FILE_BYTES,
    maximumTotalBytes: MAXIMUM_VERDICT_DIRECTORY_BYTES,
  })
  if (!files) {
    return Object.freeze({
      expectedCount: expected.size,
      verdictCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      invalidCount: 1,
      staleCount: 0,
      missingCount: expected.size,
      duplicateCount: 0,
      extraCount: 0,
    })
  }
  const byTask = new Map<string, EvidenceVerdict[]>()
  let failedCount = 0
  let invalidCount = 0
  let staleCount = 0
  let extraCount = 0
  for (const file of files) {
    const value = readJsonBytes(file.bytes)
    if (!validatePersistedVerdict(value)) {
      invalidCount += 1
      continue
    }
    if (!expected.has(value.taskId)) {
      extraCount += 1
      continue
    }
    const taskVerdicts = byTask.get(value.taskId) ?? []
    taskVerdicts.push(value)
    byTask.set(value.taskId, taskVerdicts)
    if (value.status !== 'verified') {
      failedCount += 1
      continue
    }
    if (!verdictStillCurrent(context, value, currentSourceFingerprint, trustedGit)) staleCount += 1
  }
  let verifiedCount = 0
  let missingCount = 0
  let duplicateCount = 0
  for (const taskId of expectedTaskIds) {
    const taskVerdicts = byTask.get(taskId) ?? []
    if (taskVerdicts.length === 0) {
      missingCount += 1
      continue
    }
    if (taskVerdicts.length > 1) {
      duplicateCount += taskVerdicts.length - 1
      continue
    }
    const [verdict] = taskVerdicts
    if (verdict?.status === 'verified' && verdictStillCurrent(context, verdict, currentSourceFingerprint, trustedGit)) verifiedCount += 1
  }
  return Object.freeze({
    expectedCount: expected.size,
    verdictCount: files.length,
    verifiedCount,
    failedCount,
    invalidCount,
    staleCount,
    missingCount,
    duplicateCount,
    extraCount,
  })
}

function verdictStillCurrent(
  context: EvidenceContext,
  verdict: EvidenceVerdict,
  currentSourceFingerprint: AuthoredSourceFingerprint,
  trustedGit: TrustedGitRuntime,
): boolean {
  if (!authoredSourceIsCurrent(verdict.sourceFingerprint, currentSourceFingerprint, context.workspaceRoot, trustedGit)) return false
  const request: EvidenceRequest = Object.freeze({
    schema: EVIDENCE_REQUEST_SCHEMA,
    taskId: verdict.taskId,
    performingMechanism: verdict.performingMechanism,
    verdictIssuingMechanism: verdict.verdictIssuingMechanism,
    openFindings: Object.freeze([]),
    surfaces: Object.freeze(verdict.references.map(({ role, namedCheck, readableSurface, artifactSha256 }) => Object.freeze({
      role,
      namedCheck,
      readableSurface,
      sha256: artifactSha256,
    }))),
  })
  const current = evaluateEvidenceRequest(request, context)
  if (current.status !== 'verified') return false
  return canonicalJson(stableVerdictProjection(current)) === canonicalJson(stableVerdictProjection(verdict))
}

function stableVerdictProjection(verdict: EvidenceVerdict): Omit<
  EvidenceVerdict,
  'sourceFingerprint' | 'evidenceDigest' | 'verdictDigest'
> {
  const { sourceFingerprint: _source, evidenceDigest: _evidence, verdictDigest: _verdict, ...stable } = verdict
  return stable
}

function readJsonBytes(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function argument(values: readonly string[], prefix: string): string | null {
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
}

function compareTaskIds(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? -1) - (rightParts[index] ?? -1)
    if (difference !== 0) return difference
  }
  return 0
}

async function main(): Promise<void> {
  const argumentsValue = process.argv.slice(2)
  let context: EvidenceContext
  try {
    context = await loadEvidenceRuntimeContext(process.cwd(), argumentsValue, process.env)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      check: 'evidence',
      code: evidenceRuntimeErrorCode(error),
    })}\n`)
    process.exitCode = 1
    return
  }
  const taskId = argument(argumentsValue, '--task=')
  if (taskId) {
    issueTaskVerdict(context, taskId, argumentsValue)
    return
  }
  const outcome = evaluateEvidenceGate(context)
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
  if (!outcome.ok) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
