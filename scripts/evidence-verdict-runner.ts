import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import {
  namedCheckForTask,
  parseBoundsSnapshot,
  type BoundsSnapshot,
} from './validate-task-bounds.ts'
import {
  buildVerdictRecord,
  deriveRung,
  emitReferences,
} from './evidence-reference.ts'
import { canonicalJson, sha256 } from './evidence-integrity.ts'
import {
  computeAuthoredSourceFingerprint,
  authoredSourceIsCurrent,
  resolveTrustedGitRuntime,
  validAuthoredSourceFingerprint,
  type AuthoredSourceFingerprint,
  type TrustedGitRuntime,
} from './evidence-source-fingerprint.ts'
import {
  parseTrustedDispatchIssuers,
  resolveExternalDispatchTrust,
  verifyEvidenceDispatchReceipt,
  type TrustedDispatchIssuer,
} from './evidence-dispatch-receipt.ts'
import {
  parseCheckArtifact,
  type CheckArtifact,
} from './evidence-check-artifact.ts'
import {
  EVIDENCE_FINDING_CODES,
  EVIDENCE_REQUEST_SCHEMA,
  EVIDENCE_VERDICT_SCHEMA,
  VERDICT_ISSUING_MECHANISM,
  type EvidenceContext,
  type EvidenceFinding,
  type EvidenceFindingCode,
  type EvidenceRequest,
  type EvidenceRole,
  type EvidenceSurface,
  type EvidenceVerdict,
  type LoadedSurface,
  type VerdictEvidenceReference,
  type VerificationBaseline,
} from './evidence-contracts.ts'
import {
  readExactWorkspaceFile,
  readEvidenceFile,
  resolveEvidenceArtifactRoot,
  resolveEvidenceReadableSurface,
  validEvidenceArtifactDirectory,
  writeEvidenceJsonAtomically,
} from './evidence-safe-files.ts'

export { canonicalJson, sha256 } from './evidence-integrity.ts'
export { buildCheckArtifact, CHECK_ARTIFACT_SCHEMA, type CheckArtifact } from './evidence-check-artifact.ts'
export {
  EVIDENCE_REQUEST_SCHEMA,
  EVIDENCE_VERDICT_SCHEMA,
  VERDICT_ISSUING_MECHANISM,
  type EvidenceContext,
  type EvidenceFinding,
  type EvidenceFindingCode,
  type EvidenceRequest,
  type EvidenceRole,
  type EvidenceSurface,
  type EvidenceVerdict,
  type IsolatedCheckExecutionRequest,
  type VerdictEvidenceReference,
  type VerificationBaseline,
} from './evidence-contracts.ts'
export const MAX_CHECK_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAXIMUM_BASELINE_BYTES = 256 * 1024
const MAXIMUM_TASK_BOUNDS_BYTES = 2 * 1024 * 1024

const REQUIRED_BASELINE_CHECKS = Object.freeze([
  'types:check',
  'typecheck',
  'test:domain',
  'test:unit',
  'test:workers',
  'deploy:dev:dry',
  'deploy:production:dry',
])

export function evaluateEvidenceRequest(value: unknown, context: EvidenceContext): EvidenceVerdict {
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
  const parsed = parseEvidenceRequest(value)
  const request = parsed.request
  const findings: EvidenceFinding[] = [...parsed.findings]
  const taskId = request?.taskId ?? 'unresolved'
  const verdictIssuingMechanism = request?.verdictIssuingMechanism ?? 'unresolved'
  const taskNamedCheck = request && snapshot ? namedCheckForTask(snapshot, request.taskId) : null
  if (!baseline || !snapshot || !taskNamedCheck) {
    findings.push(finding('task_bounds_unresolved', 'verification baseline or task named check is unresolved'))
  }
  if (!sourceAtStart) {
    findings.push(finding('source_fingerprint_unavailable', 'current HEAD, authored tree, or reachable implementation baseline is unresolved'))
  }
  if (!context.dispatchTrustAnchor) {
    findings.push(finding('dispatch_trust_anchor_unavailable', 'external evaluator dispatch trust anchor is unavailable'))
  } else if (!dispatchTrust) {
    findings.push(finding('dispatch_trust_anchor_mismatch', 'external evaluator trust anchor differs from the baseline projection or policy digest'))
  }

  const expectedChecks = Object.freeze({
    existingVerification: baseline?.aggregateCheck ?? 'unresolved',
    taskNamedCheck: taskNamedCheck ?? 'unresolved',
  })
  const artifactRoot = baseline && dispatchTrust
    ? liveAttestedArtifactRoot(context, baseline, dispatchTrust.artifactSinkAuthority)
    : null
  if (dispatchTrust && !artifactRoot) {
    findings.push(finding('evidence_sink_untrusted', 'external evaluator has not attested exclusive stable evidence-sink ancestry'))
  }
  const loaded: LoadedSurface[] = []
  if (request && artifactRoot && baseline && sourceAtStart && dispatchTrust && trustedGit) {
    findings.push(...validateSurfaceCardinality(request.surfaces))
    for (const descriptor of request.surfaces) {
      const expected = descriptor.role === 'existing-verification'
        ? expectedChecks.existingVerification
        : expectedChecks.taskNamedCheck
      const outcome = loadSurface(
        descriptor,
        expected,
        request.taskId,
        request.performingMechanism,
        sourceAtStart,
        dispatchTrust.trustedIssuers,
        dispatchTrust.policyDigest,
        trustedGit,
        context.workspaceRoot,
        artifactRoot,
      )
      findings.push(...outcome.findings)
      if (outcome.loaded) loaded.push(outcome.loaded)
    }
    for (const unresolved of normalizedFindings(request.openFindings)) {
      findings.push(finding('unresolved_evidence', `open finding: ${unresolved}`))
    }
  }

  const distinctSurfaceCount = new Set(loaded.map(({ descriptor }) => descriptor.readableSurface)).size
  if (loaded.length === 2 && distinctSurfaceCount !== 2) {
    findings.push(finding('duplicate_evidence_surface', 'the two gates must use distinct readable surfaces'))
  }
  const performerIdentities = new Set(loaded.map(({ artifact }) => artifact.dispatchReceipt.performingMechanism))
  const dispatchReceiptDigests = new Set(loaded.map(({ artifact }) => artifact.dispatchReceipt.receiptDigest))
  if (loaded.length > 0 && (performerIdentities.size !== 1 || dispatchReceiptDigests.size !== 1)) {
    findings.push(finding('dispatch_receipt_invalid', 'surfaced checks do not share one authoritative dispatch receipt'))
  }
  const performingMechanism = performerIdentities.size === 1
    ? [...performerIdentities][0] ?? 'unresolved'
    : 'unresolved'
  const derivedFromSurfacedOutput = Boolean(request)
    && loaded.length === 2
    && distinctSurfaceCount === 2
    && performerIdentities.size === 1
    && dispatchReceiptDigests.size === 1
  const record = buildVerdictRecord({
    taskId,
    performingMechanism,
    verdictIssuingMechanism,
    derivedFromSurfacedOutput,
  })
  if (record.finding) findings.push(finding(record.finding, 'verdict is self-issued or relies on unsurfaced output'))

  const references = buildReferences(loaded)
  const sourceAtEnd = baseline && trustedGit
    ? computeAuthoredSourceFingerprint(context.workspaceRoot, baseline.implementationBaseline, trustedGit)
    : null
  if (sourceAtStart && trustedGit
    && !authoredSourceIsCurrent(sourceAtStart, sourceAtEnd, context.workspaceRoot, trustedGit)) {
    findings.push(finding('source_changed_during_evaluation', 'authored source changed while evidence was evaluated'))
  }
  const orderedFindings = uniqueSortedFindings(findings)
  const rung = deriveRung(references, orderedFindings.map(({ code, detail }) => `${code}:${detail}`))
  const dispatchReceiptDigest = dispatchReceiptDigests.size === 1
    ? [...dispatchReceiptDigests][0] ?? sha256('unresolved-dispatch-receipt')
    : sha256('unresolved-dispatch-receipt')
  const dispatchTrustPolicyDigest = dispatchTrust?.policyDigest ?? sha256('unresolved-dispatch-trust-policy')
  const orderedSurfaces = (request?.surfaces ?? [])
    .map(({ role, namedCheck, readableSurface, sha256: digest }) => ({ role, namedCheck, readableSurface, sha256: digest }))
    .sort((left, right) => left.role.localeCompare(right.role)
      || left.namedCheck.localeCompare(right.namedCheck)
      || left.readableSurface.localeCompare(right.readableSurface)
      || left.sha256.localeCompare(right.sha256))
  const evidenceDigest = sha256(canonicalJson({
    dispatchReceiptDigest,
    dispatchTrustPolicyDigest,
    sourceFingerprint: sourceAtStart,
    surfaces: orderedSurfaces,
  }))
  const body = Object.freeze({
    schema: EVIDENCE_VERDICT_SCHEMA,
    taskId,
    status: orderedFindings.length === 0 && references.length === 2 ? 'verified' as const : 'failed' as const,
    performingMechanism,
    verdictIssuingMechanism,
    derivedFromSurfacedOutput,
    expectedChecks,
    sourceFingerprint: sourceAtStart,
    dispatchReceiptDigest,
    dispatchTrustPolicyDigest,
    references,
    findings: orderedFindings,
    rung,
    evidenceDigest,
  })
  return Object.freeze({ ...body, verdictDigest: sha256(canonicalJson(body)) })
}

export function runEvidenceVerdict(value: unknown, context: EvidenceContext): Readonly<{
  verdict: EvidenceVerdict
  outputPath: string | null
}> {
  const verdict = evaluateEvidenceRequest(value, context)
  const baseline = readVerificationBaseline(context)
  if (!baseline || !verdict.sourceFingerprint || verdict.taskId === 'unresolved'
    || verdict.dispatchTrustPolicyDigest === sha256('unresolved-dispatch-trust-policy')) {
    return Object.freeze({ verdict, outputPath: null })
  }
  const artifactRoot = resolveAttestedEvidenceArtifactRoot(context, baseline)
  if (!artifactRoot) return Object.freeze({ verdict, outputPath: null })
  const verdictDirectory = path.join(artifactRoot, 'verdicts')
  const fileName = `task-${verdict.taskId.replace('.', '-')}.json`
  const outputPath = path.join(verdictDirectory, fileName)
  writeEvidenceJsonAtomically(context.workspaceRoot, artifactRoot, outputPath, verdict)
  return Object.freeze({ verdict, outputPath: path.posix.join(baseline.evidenceArtifactDirectory, 'verdicts', fileName) })
}

export function writeCheckArtifact(
  context: EvidenceContext,
  taskId: string,
  role: EvidenceRole,
  artifact: CheckArtifact,
): EvidenceSurface {
  const baseline = readVerificationBaseline(context)
  if (!baseline) throw new Error('verification_baseline_invalid')
  const artifactRoot = resolveAttestedEvidenceArtifactRoot(context, baseline)
  if (!artifactRoot || !/^\d+\.\d+$/u.test(taskId)) throw new Error('evidence_artifact_path_invalid')
  const checkDirectory = path.join(artifactRoot, 'checks')
  const fileName = `task-${taskId.replace('.', '-')}-${role}.json`
  const artifactPath = path.join(checkDirectory, fileName)
  const bytes = writeEvidenceJsonAtomically(context.workspaceRoot, artifactRoot, artifactPath, artifact)
  return Object.freeze({
    role,
    namedCheck: artifact.namedCheck,
    readableSurface: path.posix.join(baseline.evidenceArtifactDirectory, 'checks', fileName),
    sha256: sha256(bytes),
  })
}

export function readVerificationBaseline(context: EvidenceContext): VerificationBaseline | null {
  const requested = context.baselinePath ?? 'docs/verification-baseline.json'
  const bytes = readExactWorkspaceFile(
    context.workspaceRoot,
    requested,
    'docs/verification-baseline.json',
    MAXIMUM_BASELINE_BYTES,
  )
  if (!bytes) return null
  const value = readJsonBytes(bytes)
  if (!isRecord(value) || value.schema !== 'agentic-commerce-verification-baseline/v1') return null
  if (!/^[0-9a-f]{40}$/u.test(String(value.implementationBaseline))
    || value.aggregateCheck !== 'npm run check:implementation'
    || typeof value.evidenceArtifactDirectory !== 'string') return null
  const passingChecks = value.passingChecks
  const trustedDispatchIssuers = parseTrustedDispatchIssuers(value.trustedDispatchIssuers)
  if (!Array.isArray(passingChecks) || !passingChecks.every((check) => typeof check === 'string')) return null
  if (!trustedDispatchIssuers) return null
  if (!REQUIRED_BASELINE_CHECKS.every((required) => passingChecks.includes(required))) return null
  if (!validEvidenceArtifactDirectory(value.evidenceArtifactDirectory)) return null
  return Object.freeze({
    implementationBaseline: String(value.implementationBaseline),
    documentSha256: sha256(bytes),
    aggregateCheck: value.aggregateCheck,
    evidenceArtifactDirectory: value.evidenceArtifactDirectory,
    passingChecks: Object.freeze([...passingChecks] as string[]),
    trustedDispatchIssuers,
  })
}

export function resolveAttestedEvidenceArtifactRoot(
  context: EvidenceContext,
  baseline: VerificationBaseline,
): string | null {
  const trust = context.dispatchTrustAnchor
    ? resolveExternalDispatchTrust(context.dispatchTrustAnchor, {
      verificationBaselineSha256: baseline.documentSha256,
      implementationBaseline: baseline.implementationBaseline,
      projectedIssuers: baseline.trustedDispatchIssuers,
    })
    : null
  return trust ? liveAttestedArtifactRoot(context, baseline, trust.artifactSinkAuthority) : null
}

function liveAttestedArtifactRoot(
  context: EvidenceContext,
  baseline: VerificationBaseline,
  authority: Readonly<{ workspaceRootRealPath: string; artifactRootRealPath: string }>,
): string | null {
  const artifactRoot = resolveEvidenceArtifactRoot(
    context.workspaceRoot,
    baseline.evidenceArtifactDirectory,
    authority.artifactRootRealPath,
  )
  if (!artifactRoot) return null
  try {
    const workspace = fs.realpathSync(context.workspaceRoot)
    const rootStat = fs.lstatSync(artifactRoot)
    return workspace === authority.workspaceRootRealPath && artifactRoot === authority.artifactRootRealPath
      && rootStat.isDirectory() && !rootStat.isSymbolicLink()
      ? artifactRoot
      : null
  } catch {
    return null
  }
}

export function readTaskBoundsSnapshot(context: EvidenceContext): BoundsSnapshot | null {
  const requested = context.taskBoundsSnapshotPath ?? 'config/task-bounds.snapshot.json'
  const bytes = readExactWorkspaceFile(
    context.workspaceRoot,
    requested,
    'config/task-bounds.snapshot.json',
    MAXIMUM_TASK_BOUNDS_BYTES,
  )
  return bytes ? parseBoundsSnapshot(readJsonBytes(bytes)) : null
}

export function expectedCheckForRole(
  context: EvidenceContext,
  taskId: string,
  role: EvidenceRole,
): string | null {
  if (role === 'existing-verification') return readVerificationBaseline(context)?.aggregateCheck ?? null
  const snapshot = readTaskBoundsSnapshot(context)
  return snapshot ? namedCheckForTask(snapshot, taskId) : null
}

export function checkArtifactRelativePath(taskId: string, role: EvidenceRole): string {
  return `checks/task-${taskId.replace('.', '-')}-${role}.json`
}

export function validatePersistedVerdict(value: unknown): value is EvidenceVerdict {
  if (!isRecord(value) || value.schema !== EVIDENCE_VERDICT_SCHEMA || !/^\d+\.\d+$/u.test(String(value.taskId))) return false
  if (value.status !== 'verified' && value.status !== 'failed') return false
  if (!namedMechanism(value.performingMechanism) || !namedMechanism(value.verdictIssuingMechanism)
    || typeof value.derivedFromSurfacedOutput !== 'boolean') return false
  if (!Array.isArray(value.references) || !Array.isArray(value.findings) || !isRecord(value.rung)) return false
  if (!isRecord(value.expectedChecks) || typeof value.expectedChecks.existingVerification !== 'string'
    || typeof value.expectedChecks.taskNamedCheck !== 'string') return false
  if (!validAuthoredSourceFingerprint(value.sourceFingerprint)
    || !/^[0-9a-f]{64}$/u.test(String(value.dispatchReceiptDigest))
    || !/^[0-9a-f]{64}$/u.test(String(value.dispatchTrustPolicyDigest))) return false
  if (!/^[0-9a-f]{64}$/u.test(String(value.evidenceDigest)) || !/^[0-9a-f]{64}$/u.test(String(value.verdictDigest))) return false
  if (!value.references.every(validReference) || !value.findings.every(validFinding)) return false
  if (typeof value.rung.localRung !== 'string' || value.rung.deliveredRung !== 'not-delivered'
    || typeof value.rung.blocked !== 'boolean') return false
  const { verdictDigest, ...body } = value
  if (sha256(canonicalJson(body)) !== verdictDigest) return false
  if (value.status === 'verified' && (value.findings.length !== 0 || value.references.length !== 2
    || value.rung.blocked !== false || value.derivedFromSurfacedOutput !== true
    || value.dispatchReceiptDigest === sha256('unresolved-dispatch-receipt')
    || value.dispatchTrustPolicyDigest === sha256('unresolved-dispatch-trust-policy'))) return false
  if (value.status === 'failed' && (value.findings.length === 0 || value.rung.blocked !== true)) return false
  return true
}

function validReference(value: unknown): boolean {
  return isRecord(value) && (value.role === 'existing-verification' || value.role === 'task-named-check')
    && typeof value.namedCheck === 'string' && value.namedCheck.trim().length > 0
    && typeof value.recordedResult === 'string' && value.recordedResult.trim().length > 0
    && typeof value.readableSurface === 'string' && value.readableSurface.trim().length > 0
    && value.surface === 'authoring' && /^[0-9a-f]{64}$/u.test(String(value.artifactSha256))
}

function validFinding(value: unknown): boolean {
  return isRecord(value) && typeof value.code === 'string' && EVIDENCE_FINDING_CODES.has(value.code as EvidenceFindingCode)
    && typeof value.detail === 'string' && value.detail.trim().length > 0
}

function parseEvidenceRequest(value: unknown): Readonly<{
  request: EvidenceRequest | null
  findings: readonly EvidenceFinding[]
}> {
  if (!isRecord(value) || value.schema !== EVIDENCE_REQUEST_SCHEMA) {
    return Object.freeze({ request: null, findings: [finding('invalid_evidence_request', 'request schema is invalid')] })
  }
  if (!/^\d+\.\d+$/u.test(String(value.taskId)) || !namedMechanism(value.performingMechanism)
    || value.verdictIssuingMechanism !== VERDICT_ISSUING_MECHANISM || !Array.isArray(value.openFindings)
    || !value.openFindings.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 280)
    || !Array.isArray(value.surfaces)) {
    return Object.freeze({ request: null, findings: [finding('invalid_evidence_request', 'request fields are invalid')] })
  }
  const surfaces: EvidenceSurface[] = []
  for (const candidate of value.surfaces) {
    if (!isRecord(candidate) || (candidate.role !== 'existing-verification' && candidate.role !== 'task-named-check')
      || typeof candidate.namedCheck !== 'string' || !candidate.namedCheck.trim()
      || typeof candidate.readableSurface !== 'string' || !candidate.readableSurface.trim()
      || typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.sha256)) {
      return Object.freeze({ request: null, findings: [finding('invalid_evidence_request', 'surface descriptor is invalid')] })
    }
    surfaces.push(Object.freeze({
      role: candidate.role,
      namedCheck: candidate.namedCheck,
      readableSurface: candidate.readableSurface,
      sha256: candidate.sha256,
    }))
  }
  return Object.freeze({
    request: Object.freeze({
      schema: EVIDENCE_REQUEST_SCHEMA,
      taskId: String(value.taskId),
      performingMechanism: String(value.performingMechanism),
      verdictIssuingMechanism: String(value.verdictIssuingMechanism),
      openFindings: Object.freeze([...value.openFindings] as string[]),
      surfaces: Object.freeze(surfaces),
    }),
    findings: Object.freeze([]),
  })
}

function loadSurface(
  descriptor: EvidenceSurface,
  expectedCheck: string,
  taskId: string,
  expectedPerformingMechanism: string,
  currentSourceFingerprint: AuthoredSourceFingerprint,
  trustedDispatchIssuers: readonly TrustedDispatchIssuer[],
  dispatchTrustPolicyDigest: string,
  trustedGit: TrustedGitRuntime,
  workspaceRoot: string,
  artifactRoot: string,
): Readonly<{ loaded: LoadedSurface | null; findings: readonly EvidenceFinding[] }> {
  if (descriptor.namedCheck !== expectedCheck) return failedLoad('named_check_mismatch', `${descriptor.role} descriptor differs from its expected command`)
  const resolved = resolveEvidenceReadableSurface(workspaceRoot, artifactRoot, descriptor.readableSurface)
  if (!resolved) return failedLoad('evidence_path_forbidden', `${descriptor.role} surface is outside the evidence directory`)
  const evidenceFile = readEvidenceFile(workspaceRoot, artifactRoot, descriptor.readableSurface, MAX_CHECK_ARTIFACT_BYTES)
  if (!evidenceFile || evidenceFile.path !== resolved) {
    return failedLoad('evidence_unreadable', `${descriptor.role} surface is absent or unreadable`)
  }
  const { bytes } = evidenceFile
  if (sha256(bytes) !== descriptor.sha256) return failedLoad('evidence_digest_mismatch', `${descriptor.role} surface digest does not match`)
  const artifact = parseCheckArtifact(readJsonBytes(bytes))
  if (!artifact) return failedLoad('evidence_unreadable', `${descriptor.role} surface does not contain a check artifact`)
  if (artifact.namedCheck !== expectedCheck || artifact.namedCheck !== descriptor.namedCheck) {
    return failedLoad('named_check_mismatch', `${descriptor.role} artifact names a different command`)
  }
  if (!authoredSourceIsCurrent(artifact.sourceFingerprint, currentSourceFingerprint, workspaceRoot, trustedGit)) {
    return failedLoad('source_fingerprint_mismatch', `${descriptor.role} was captured from a different authored source`)
  }
  if (!artifact.sourceStable) {
    return failedLoad('source_changed_during_check', `${descriptor.role} observed authored-source drift while the check ran`)
  }
  if (artifact.dispatchTrustPolicyDigest !== dispatchTrustPolicyDigest) {
    return failedLoad('dispatch_trust_anchor_mismatch', `${descriptor.role} was captured under a different external trust policy`)
  }
  const dispatch = verifyEvidenceDispatchReceipt(artifact.dispatchReceipt, {
    taskId,
    sourceFingerprint: artifact.sourceFingerprint,
    trustedIssuers: trustedDispatchIssuers,
    expectedPerformingMechanism,
  })
  if (dispatch.findings.length > 0 || !dispatch.receipt) {
    const first = dispatch.findings[0]
    return failedLoad(first?.code ?? 'dispatch_receipt_invalid', `${descriptor.role}: ${first?.detail ?? 'dispatch receipt is invalid'}`)
  }
  if (artifact.performingMechanism !== dispatch.receipt.performingMechanism) {
    return failedLoad('performer_identity_mismatch', `${descriptor.role} performer differs from its authoritative dispatch receipt`)
  }
  if (artifact.outputTruncated || (!artifact.stdout.trim() && !artifact.stderr.trim())) {
    return failedLoad('evidence_unreadable', `${descriptor.role} output is empty or truncated`)
  }
  const passed = artifact.exitCode === 0 && !reportsFailure(artifact.stdout) && !reportsFailure(artifact.stderr)
  const result = Object.freeze({
    namedCheck: artifact.namedCheck,
    ran: artifact.ran,
    passed,
    recordedResult: summarizeResult(artifact),
    readableSurface: descriptor.readableSurface,
  })
  const loaded = Object.freeze({ role: descriptor.role, descriptor, artifact, result })
  if (!artifact.ran) {
    return Object.freeze({ loaded, findings: Object.freeze([finding('check_not_run', `${descriptor.role} did not run`)]) })
  }
  if (!passed) {
    return Object.freeze({ loaded, findings: Object.freeze([finding('check_failed', `${descriptor.role} recorded a failing result`)]) })
  }
  return Object.freeze({ loaded, findings: Object.freeze([]) })
}

function buildReferences(loaded: readonly LoadedSurface[]): readonly VerdictEvidenceReference[] {
  const references = emitReferences(loaded.map(({ result }) => result))
  return Object.freeze(references.map((reference) => {
    const source = loaded.find(({ result }) => result.namedCheck === reference.namedCheck
      && result.readableSurface === reference.readableSurface)
    if (!source) throw new Error('evidence_reference_source_missing')
    return Object.freeze({ ...reference, role: source.role, artifactSha256: source.descriptor.sha256 })
  }).sort((left, right) => left.role.localeCompare(right.role)))
}

function validateSurfaceCardinality(surfaces: readonly EvidenceSurface[]): readonly EvidenceFinding[] {
  const findings: EvidenceFinding[] = []
  for (const role of ['existing-verification', 'task-named-check'] as const) {
    if (surfaces.filter((surface) => surface.role === role).length !== 1) {
      findings.push(finding('invalid_evidence_request', `expected exactly one ${role} surface`))
    }
  }
  return Object.freeze(findings)
}

function summarizeResult(artifact: CheckArtifact): string {
  const lines = `${artifact.stdout}\n${artifact.stderr}`.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const finalOutput = (lines.at(-1) ?? '').slice(0, 1_024)
  return canonicalJson({
    exitCode: artifact.exitCode,
    finalOutput,
    outputSha256: sha256(`${artifact.stdout}\0${artifact.stderr}`),
  })
}

function reportsFailure(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => {
    try {
      const value: unknown = JSON.parse(line.trim())
      return isRecord(value) && value.ok === false
    } catch {
      return false
    }
  })
}

function failedLoad(code: EvidenceFindingCode, detail: string): Readonly<{
  loaded: null
  findings: readonly EvidenceFinding[]
}> {
  return Object.freeze({ loaded: null, findings: Object.freeze([finding(code, detail)]) })
}

function finding(code: EvidenceFindingCode, detail: string): EvidenceFinding {
  return Object.freeze({ code, detail })
}

function uniqueSortedFindings(findings: readonly EvidenceFinding[]): readonly EvidenceFinding[] {
  const byIdentity = new Map(findings.map((entry) => [`${entry.code}\0${entry.detail}`, entry]))
  return Object.freeze([...byIdentity.values()].sort((left, right) => left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail)))
}

function normalizedFindings(findings: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(findings.map((entry) => entry.trim()))].sort())
}

function namedMechanism(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)
}

function readJsonBytes(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
