import type { CheckArtifact } from './evidence-check-artifact.ts'
import type { GovernedCheckInvocation } from './evidence-command-policy.ts'
import type {
  EvidenceDispatchReceipt,
  EvidenceDispatchTrustAnchor,
  TrustedDispatchIssuer,
} from './evidence-dispatch-receipt.ts'
import type { EvidenceReference } from './evidence-reference.ts'
import type { AuthoredSourceFingerprint } from './evidence-source-fingerprint.ts'

export const EVIDENCE_VERDICT_SCHEMA = 'agentic-commerce-evidence-verdict/v2'
export const EVIDENCE_REQUEST_SCHEMA = 'agentic-commerce-evidence-request/v2'
export const VERDICT_ISSUING_MECHANISM = 'evidence-verdict-runner'

export type EvidenceRole = 'existing-verification' | 'task-named-check'

export type EvidenceSurface = Readonly<{
  role: EvidenceRole
  namedCheck: string
  readableSurface: string
  sha256: string
}>

export type EvidenceRequest = Readonly<{
  schema: typeof EVIDENCE_REQUEST_SCHEMA
  taskId: string
  performingMechanism: string
  verdictIssuingMechanism: string
  openFindings: readonly string[]
  surfaces: readonly EvidenceSurface[]
}>

export type EvidenceFindingCode =
  | 'check_failed'
  | 'check_not_run'
  | 'duplicate_evidence_surface'
  | 'evidence_digest_mismatch'
  | 'evidence_sink_untrusted'
  | 'evidence_path_forbidden'
  | 'evidence_unreadable'
  | 'dispatch_receipt_invalid'
  | 'dispatch_receipt_source_mismatch'
  | 'dispatch_receipt_task_mismatch'
  | 'dispatch_receipt_untrusted'
  | 'dispatch_trust_anchor_mismatch'
  | 'dispatch_trust_anchor_unavailable'
  | 'invalid_evidence_request'
  | 'named_check_mismatch'
  | 'performer_identity_mismatch'
  | 'self_graded_verdict'
  | 'source_changed_during_check'
  | 'source_changed_during_evaluation'
  | 'source_fingerprint_mismatch'
  | 'source_fingerprint_unavailable'
  | 'task_bounds_unresolved'
  | 'unresolved_evidence'

export type EvidenceFinding = Readonly<{
  code: EvidenceFindingCode
  detail: string
}>

export type VerdictEvidenceReference = EvidenceReference & Readonly<{
  role: EvidenceRole
  artifactSha256: string
}>

export type EvidenceVerdict = Readonly<{
  schema: typeof EVIDENCE_VERDICT_SCHEMA
  taskId: string
  status: 'verified' | 'failed'
  performingMechanism: string
  verdictIssuingMechanism: string
  derivedFromSurfacedOutput: boolean
  expectedChecks: Readonly<{
    existingVerification: string
    taskNamedCheck: string
  }>
  sourceFingerprint: AuthoredSourceFingerprint | null
  dispatchReceiptDigest: string
  dispatchTrustPolicyDigest: string
  references: readonly VerdictEvidenceReference[]
  findings: readonly EvidenceFinding[]
  rung: Readonly<{ localRung: string; deliveredRung: string; blocked: boolean }>
  evidenceDigest: string
  verdictDigest: string
}>

export type IsolatedCheckExecutionRequest = Readonly<{
  taskId: string
  role: EvidenceRole
  namedCheck: string
  invocation: GovernedCheckInvocation
  workspaceRoot: string
  maxOutputBytes: number
  sourceFingerprint: AuthoredSourceFingerprint
  dispatchReceipt: EvidenceDispatchReceipt
  dispatchTrustPolicyDigest: string
}>

export type EvidenceContext = Readonly<{
  workspaceRoot: string
  baselinePath?: string
  taskBoundsSnapshotPath?: string
  dispatchTrustAnchor?: EvidenceDispatchTrustAnchor
  trustedGitExecutable?: string
  agenticCanvasOsRoot?: string
  isolatedCheckExecutor?: (request: IsolatedCheckExecutionRequest) => unknown
}>

export type VerificationBaseline = Readonly<{
  implementationBaseline: string
  documentSha256: string
  aggregateCheck: string
  evidenceArtifactDirectory: string
  passingChecks: readonly string[]
  trustedDispatchIssuers: readonly TrustedDispatchIssuer[]
}>

export type LoadedSurface = Readonly<{
  role: EvidenceRole
  descriptor: EvidenceSurface
  artifact: CheckArtifact
  result: Readonly<{
    namedCheck: string
    ran: boolean
    passed: boolean
    recordedResult: string
    readableSurface: string
  }>
}>

export const EVIDENCE_FINDING_CODES: ReadonlySet<EvidenceFindingCode> = new Set<EvidenceFindingCode>([
  'check_failed', 'check_not_run', 'duplicate_evidence_surface', 'evidence_digest_mismatch',
  'evidence_path_forbidden', 'evidence_sink_untrusted', 'evidence_unreadable', 'dispatch_receipt_invalid',
  'dispatch_receipt_source_mismatch', 'dispatch_receipt_task_mismatch', 'dispatch_receipt_untrusted',
  'dispatch_trust_anchor_mismatch', 'dispatch_trust_anchor_unavailable', 'invalid_evidence_request',
  'named_check_mismatch', 'performer_identity_mismatch', 'self_graded_verdict', 'source_changed_during_check',
  'source_changed_during_evaluation', 'source_fingerprint_mismatch', 'source_fingerprint_unavailable',
  'task_bounds_unresolved', 'unresolved_evidence',
])
