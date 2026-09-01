import { createHash } from 'node:crypto'

import { publicObservation, type MergeObservation } from './observation.ts'
import { formatCommand } from './policy.ts'
import type { CommandExecution, CommandInvocation } from './runner.ts'
import type { MergeAction, MergeBounds, MergeReason } from './types.ts'

export type LaneAuthorityObservation = Readonly<{
  semanticScope: string
  claimId: string
  actorId: string
  worktree: string
  branch: string
  leaseEpoch: number
  leaseExpiresAtMs: number
  fenceRevision: string
  declaredWriteSet: readonly string[]
}>

export type LaneMutationAdmissionRequest = Readonly<{
  semanticScope: string
  claimId: string
  leaseEpoch: number
  fenceRevision: string
  requiredWriteTarget: string
  nowMs: number
}>

export type LaneMutationAdmission =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: string }>

export type LaneAdmissionEvidence = Readonly<{
  request: LaneMutationAdmissionRequest
  admitted: boolean
  code: string | null
}>

export type CheckFailureEvidence = Readonly<{
  sequence: number
  checkIdentity: string
  phase: 'preflight' | 'rerun'
  attempt: number
  commandId: string
  commandSequence: number
  remoteObservedOutput: string
  localExitCode: number
  localOutcome: 'pass' | 'fail'
  observedOutput: string
  outputDigest: string
  outputTruncated: boolean
  diagnosedRootCause: string
}>

export type CommandEvidence = Readonly<{
  sequence: number
  id: string
  kind: CommandInvocation['kind']
  executable: string
  args: readonly string[]
  exitCode: number
  stdoutDigest: string
  stderrDigest: string
  stdinDigest: string | null
  durationMs: number
  outputTruncated: boolean
}>

export type MergeAgentEvidenceArtifact = Readonly<{
  schema: 'agentic-commerce-merge-agent-evidence/v1'
  lane: string
  claimId: string
  leaseEpoch: number
  fenceRevision: string
  bounds: MergeBounds & Readonly<{ recordedAtMs: number }>
  observation: ReturnType<typeof publicObservation> | null
  checkFailureEvidence: readonly CheckFailureEvidence[]
  authorityChecks: readonly LaneAuthorityObservation[]
  admissionChecks: readonly LaneAdmissionEvidence[]
  actions: readonly MergeAction[]
  changedPaths: readonly string[]
  issuedCommands: readonly string[]
  commandEvidence: readonly CommandEvidence[]
  endedBecause: MergeReason | 'completed'
  verdict: Readonly<{
    status: 'local-repairs-complete' | 'blocked' | 'escalated'
    reason: MergeReason | null
    detail: string | null
    githubMutationPerformed: false
    canonicalMutationPerformed: false
    deploymentPerformed: false
    releaseControllerRequired: true
  }>
  artifactDigest: string
}>

export function recordCommandEvidence(
  sequence: number,
  invocation: CommandInvocation,
  execution: CommandExecution,
): CommandEvidence {
  return Object.freeze({
    sequence,
    id: invocation.id,
    kind: invocation.kind,
    executable: invocation.executable,
    args: Object.freeze([...invocation.args]),
    exitCode: execution.exitCode,
    stdoutDigest: digest(execution.stdout),
    stderrDigest: digest(execution.stderr),
    stdinDigest: invocation.stdin === undefined ? null : digest(invocation.stdin),
    durationMs: execution.durationMs,
    outputTruncated: execution.outputTruncated,
  })
}

export function buildMergeAgentEvidence(input: Readonly<{
  lane: string
  claimId: string
  leaseEpoch: number
  fenceRevision: string
  bounds: MergeBounds
  recordedAtMs: number
  observation: MergeObservation | null
  checkFailureEvidence: readonly CheckFailureEvidence[]
  authorityChecks: readonly LaneAuthorityObservation[]
  admissionChecks: readonly LaneAdmissionEvidence[]
  actions: readonly MergeAction[]
  changedPaths: readonly string[]
  commands: readonly CommandEvidence[]
  reason: MergeReason | null
  detail: string | null
}>): MergeAgentEvidenceArtifact {
  const status = input.reason === null
    ? 'local-repairs-complete'
    : input.reason === 'requires-operator-decision' || input.reason === 'repair_approach_exhausted'
      ? 'escalated'
      : 'blocked'
  const value = Object.freeze({
    schema: 'agentic-commerce-merge-agent-evidence/v1' as const,
    lane: input.lane,
    claimId: input.claimId,
    leaseEpoch: input.leaseEpoch,
    fenceRevision: input.fenceRevision,
    bounds: Object.freeze({ ...input.bounds, recordedAtMs: input.recordedAtMs }),
    observation: input.observation ? publicObservation(input.observation) : null,
    checkFailureEvidence: Object.freeze([...input.checkFailureEvidence]),
    authorityChecks: Object.freeze([...input.authorityChecks]),
    admissionChecks: Object.freeze([...input.admissionChecks]),
    actions: Object.freeze(input.actions.map((action) => Object.freeze({
      ...action,
      ...(action.subject ? { subject: sanitizeEvidenceText(action.subject) } : {}),
      ...(action.approach ? { approach: sanitizeEvidenceText(action.approach) } : {}),
    }))),
    changedPaths: Object.freeze([...input.changedPaths].sort()),
    issuedCommands: Object.freeze(input.commands.map(({ executable, args }) => formatCommand({ executable, args }))),
    commandEvidence: Object.freeze([...input.commands]),
    endedBecause: input.reason ?? 'completed',
    verdict: Object.freeze({
      status,
      reason: input.reason,
      detail: input.detail === null ? null : sanitizeEvidenceText(input.detail),
      githubMutationPerformed: false as const,
      canonicalMutationPerformed: false as const,
      deploymentPerformed: false as const,
      releaseControllerRequired: true as const,
    }),
  })
  return Object.freeze({ ...value, artifactDigest: digest(canonicalJson(value)) })
}

export function recordCheckFailureEvidence(input: Readonly<{
  sequence: number
  checkIdentity: string
  phase: CheckFailureEvidence['phase']
  attempt: number
  commandId: string
  commandSequence: number
  remoteObservedOutput: string
  execution: CommandExecution
}>): CheckFailureEvidence {
  const combinedOutput = [input.execution.stdout, input.execution.stderr].filter(Boolean).join('\n')
  const observedOutput = sanitizeEvidenceText(combinedOutput || '(no local output)')
  const firstLine = observedOutput.split(/\r?\n/u).find((line) => line.trim().length > 0)
  const diagnosedRootCause = input.execution.exitCode === 0
    ? 'Remote failure was not reproduced by the exact checked-in command.'
    : combinedOutput
      ? sanitizeEvidenceText(firstLine ?? `Exact checked-in command exited ${input.execution.exitCode}.`).slice(0, 512)
      : `Exact checked-in command exited ${input.execution.exitCode} with no output.`
  return Object.freeze({
    sequence: input.sequence,
    checkIdentity: sanitizeEvidenceText(input.checkIdentity),
    phase: input.phase,
    attempt: input.attempt,
    commandId: input.commandId,
    commandSequence: input.commandSequence,
    remoteObservedOutput: sanitizeEvidenceText(input.remoteObservedOutput),
    localExitCode: input.execution.exitCode,
    localOutcome: input.execution.exitCode === 0 ? 'pass' : 'fail',
    observedOutput,
    outputDigest: digest(`${input.execution.stdout}\0${input.execution.stderr}`),
    outputTruncated: input.execution.outputTruncated,
    diagnosedRootCause,
  })
}

export function sanitizeEvidenceText(value: string): string {
  return value
    .replace(/\b(bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?')
    .slice(0, 4_096)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, entry]) => [key, sortValue(entry)]))
  }
  return value
}
