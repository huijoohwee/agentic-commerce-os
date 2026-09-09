import { canonicalJson, sha256 } from '../evidence-integrity.ts'
import { parseDeviceHostProof, type DeviceHostProof } from './device-host-release.ts'
import type { WorkerDeploymentProof } from './contracts.ts'
import type { CandidateIdentity } from './lifecycle.ts'

export const PRODUCTION_DEPLOYMENT_RECEIPT_SCHEMA =
  'agentic-commerce-production-deployment-receipt/v3' as const
export const PRODUCTION_ROLLBACK_RECEIPT_SCHEMA =
  'agentic-commerce-production-rollback-receipt/v2' as const
export const PRODUCTION_PRESERVE_RECEIPT_SCHEMA =
  'agentic-commerce-production-preserve-required/v3' as const

export type WorkerKind = 'sandbox' | 'core' | 'edge'
export type ProductionReleaseMode = 'bootstrap' | 'steady-state' | 'recovery'
export type WorkerVersions = Readonly<Record<WorkerKind, string | null>>
export type ObservedWorkerVersions = Readonly<Record<WorkerKind, string | null | 'unknown'>>
export type CandidateVersions = Readonly<Record<WorkerKind, string>>
export type DeploymentProofs = Readonly<Record<WorkerKind, WorkerDeploymentProof>>

export type DeploymentReceipt = Readonly<{
  schema: typeof PRODUCTION_DEPLOYMENT_RECEIPT_SCHEMA
  disposition: 'deployed-and-live-verified'
  releaseMode: ProductionReleaseMode
  candidateSha: string
  candidateDigest: string
  protectedMainVerified: true
  runId: number
  runAttempt: 1
  evidence: Readonly<{
    candidateIdentityDigest: string
    humanAuthorizationDigest: string
    operatorPinsDigest: string
    priorArtifactAuthorityProofDigest: string | null
    routeAuthorityBeforeDigest: string
    routeAuthorityAfterDigest: string
    deploymentProofs: DeploymentProofs
    deploymentProofDigests: Readonly<Record<WorkerKind, string>>
    executionHostProofDigest: string
    executionHostAuthorizationDigest: string
    routeProofDigest: string
  }>
  workerVersions: Readonly<{
    predecessors: WorkerVersions
    candidates: CandidateVersions
    activationOrder: readonly ['sandbox-full-deploy', 'core-version', 'edge-version']
  }>
  executionHost: DeviceHostProof
  releaseSemantics: Readonly<{
    atomic: false
    sandboxWorkerActivatesBeforeHostVerification: true
    hostAvailability: 'device-session'
    postSandboxFailureRecovery: 'preserve-and-forward-recover'
  }>
  storageCompatibility: Readonly<{ coreRevision: string; sandboxRevision: string }>
  rollback: Readonly<{ supported: false; reason: 'device_host_and_storage_rollback_unproven' }>
}>

export type RollbackReceipt = Readonly<{
  schema: typeof PRODUCTION_ROLLBACK_RECEIPT_SCHEMA
  disposition: 'exact-core-edge-predecessors-restored-sandbox-preserved'
  candidateSha: string
  candidateDigest: string
  failedStage: string
  restoredPredecessors: Readonly<{ core: string; edge: string }>
  sandboxDisposition: 'preserve-and-forward-recover'
  storageCompatibilityVerified: true
}>

export type PreserveRequiredReceipt = Readonly<{
  schema: typeof PRODUCTION_PRESERVE_RECEIPT_SCHEMA
  disposition: 'preserve-and-forward-recover'
  candidateSha: string
  candidateDigest: string
  releaseMode: ProductionReleaseMode
  runId: number
  runAttempt: 1
  evidence: Readonly<{
    candidateIdentityDigest: string
    humanAuthorizationDigest: string
    operatorPinsDigest: string
    routeAuthorityDigest: string
    priorArtifactAuthorityProofDigest: string | null
  }>
  failedStage: string
  reason: 'bootstrap_has_no_predecessor' | 'compare_and_swap_lost'
    | 'worker_activation_not_transactional' | 'execution_host_unproven'
    | 'route_authority_changed' | 'prior_release_evidence_invalid' | 'release_stage_failed'
  predecessors: WorkerVersions
  priorDeploymentReceipt: DeploymentReceipt | null
  candidates: Readonly<Partial<CandidateVersions>>
  observedActive: ObservedWorkerVersions
  sandboxMutationStarted: boolean
  rollbackAttempted: false
  recovery: 'authenticated-artifact-required-then-roll-forward'
}>

export function evidenceDigest(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function buildDeploymentReceipt(input: Readonly<{
  releaseMode: ProductionReleaseMode
  identity: CandidateIdentity
  runId: number
  humanAuthorization: unknown
  operatorPins: unknown
  priorArtifactAuthorityProof: unknown | null
  predecessors: WorkerVersions
  candidates: CandidateVersions
  deploymentProofs: DeploymentProofs
  executionHost: DeviceHostProof
  routeAuthorityBefore: unknown
  routeAuthorityAfter: unknown
  routeProof: unknown
}>): DeploymentReceipt {
  return Object.freeze({
    schema: PRODUCTION_DEPLOYMENT_RECEIPT_SCHEMA,
    disposition: 'deployed-and-live-verified',
    releaseMode: input.releaseMode,
    candidateSha: input.identity.candidateSha,
    candidateDigest: input.identity.candidateDigest,
    protectedMainVerified: true,
    runId: input.runId,
    runAttempt: 1,
    evidence: Object.freeze({
      candidateIdentityDigest: evidenceDigest(input.identity),
      humanAuthorizationDigest: evidenceDigest(input.humanAuthorization),
      operatorPinsDigest: evidenceDigest(input.operatorPins),
      priorArtifactAuthorityProofDigest: input.priorArtifactAuthorityProof === null
        ? null : evidenceDigest(input.priorArtifactAuthorityProof),
      routeAuthorityBeforeDigest: evidenceDigest(input.routeAuthorityBefore),
      routeAuthorityAfterDigest: evidenceDigest(input.routeAuthorityAfter),
      deploymentProofs: input.deploymentProofs,
      deploymentProofDigests: Object.freeze({
        sandbox: evidenceDigest(input.deploymentProofs.sandbox),
        core: evidenceDigest(input.deploymentProofs.core),
        edge: evidenceDigest(input.deploymentProofs.edge),
      }),
      executionHostProofDigest: evidenceDigest(input.executionHost),
      executionHostAuthorizationDigest: evidenceDigest({
        candidateIdentityDigest: evidenceDigest(input.identity),
        humanAuthorizationDigest: evidenceDigest(input.humanAuthorization),
        origin: input.executionHost.origin,
        bundleSha256: input.executionHost.bundleSha256,
        imageId: input.executionHost.imageId,
      }),
      routeProofDigest: evidenceDigest(input.routeProof),
    }),
    workerVersions: Object.freeze({
      predecessors: input.predecessors,
      candidates: input.candidates,
      activationOrder: Object.freeze(['sandbox-full-deploy', 'core-version', 'edge-version'] as const),
    }),
    executionHost: input.executionHost,
    releaseSemantics: Object.freeze({
      atomic: false,
      sandboxWorkerActivatesBeforeHostVerification: true,
      hostAvailability: 'device-session',
      postSandboxFailureRecovery: 'preserve-and-forward-recover',
    }),
    storageCompatibility: Object.freeze({
      coreRevision: input.identity.durableObjectStorageCompatibilityRevision,
      sandboxRevision: input.identity.sandboxStorageCompatibilityRevision,
    }),
    rollback: Object.freeze({ supported: false, reason: 'device_host_and_storage_rollback_unproven' }),
  })
}

export function parseDeploymentReceipt(value: unknown): DeploymentReceipt {
  const receipt = record(value, 'prior_receipt_invalid')
  exactKeys(receipt, [
    'candidateDigest', 'candidateSha', 'disposition', 'evidence', 'protectedMainVerified', 'releaseMode',
    'releaseSemantics', 'rollback', 'runAttempt', 'runId', 'executionHost', 'schema',
    'storageCompatibility', 'workerVersions',
  ], 'prior_receipt_shape_invalid')
  requireReceipt(receipt.schema === PRODUCTION_DEPLOYMENT_RECEIPT_SCHEMA
    && receipt.disposition === 'deployed-and-live-verified'
    && receipt.protectedMainVerified === true
    && ['bootstrap', 'steady-state', 'recovery'].includes(String(receipt.releaseMode))
    && sha1(receipt.candidateSha) && digest(receipt.candidateDigest)
    && receipt.runAttempt === 1 && Number.isSafeInteger(receipt.runId) && Number(receipt.runId) > 0,
  'prior_receipt_identity_invalid')
  const versions = record(receipt.workerVersions, 'prior_receipt_versions_invalid')
  exactKeys(versions, ['activationOrder', 'candidates', 'predecessors'], 'prior_receipt_versions_shape_invalid')
  requireReceipt(canonicalJson(versions.activationOrder)
    === canonicalJson(['sandbox-full-deploy', 'core-version', 'edge-version']), 'prior_receipt_order_invalid')
  exactVersions(versions.candidates, false)
  exactVersions(versions.predecessors, true)
  const evidence = record(receipt.evidence, 'prior_receipt_evidence_invalid')
  exactKeys(evidence, [
    'candidateIdentityDigest', 'deploymentProofDigests', 'deploymentProofs', 'humanAuthorizationDigest',
    'operatorPinsDigest', 'priorArtifactAuthorityProofDigest', 'routeAuthorityAfterDigest',
    'routeAuthorityBeforeDigest', 'routeProofDigest', 'executionHostAuthorizationDigest',
    'executionHostProofDigest',
  ], 'prior_receipt_evidence_shape_invalid')
  for (const key of ['candidateIdentityDigest', 'humanAuthorizationDigest', 'operatorPinsDigest',
    'routeAuthorityAfterDigest', 'routeAuthorityBeforeDigest', 'routeProofDigest',
    'executionHostAuthorizationDigest', 'executionHostProofDigest']) {
    requireReceipt(digest(evidence[key]), 'prior_receipt_evidence_digest_invalid')
  }
  requireReceipt(evidence.priorArtifactAuthorityProofDigest === null
    || digest(evidence.priorArtifactAuthorityProofDigest), 'prior_receipt_authority_digest_invalid')
  const proofs = record(evidence.deploymentProofs, 'prior_receipt_deployment_proofs_invalid')
  exactKeys(proofs, ['core', 'edge', 'sandbox'], 'prior_receipt_deployment_proofs_shape_invalid')
  for (const kind of ['sandbox', 'core', 'edge'] as const) validateProof(proofs[kind], kind)
  const proofDigests = record(evidence.deploymentProofDigests, 'prior_receipt_deployment_digests_invalid')
  exactKeys(proofDigests, ['core', 'edge', 'sandbox'], 'prior_receipt_deployment_digests_shape_invalid')
  for (const kind of ['sandbox', 'core', 'edge'] as const) {
    requireReceipt(proofDigests[kind] === evidenceDigest(proofs[kind]), 'prior_receipt_proof_digest_mismatch')
    const proof = proofs[kind] as Record<string, unknown>
    const candidates = record(versions.candidates, 'prior_receipt_candidates_invalid')
    requireReceipt(proof.candidateSha === receipt.candidateSha
      && proof.candidateDigest === receipt.candidateDigest
      && proof.versionId === candidates[kind], 'prior_receipt_worker_candidate_join_invalid')
  }
  parseDeviceHostProof(receipt.executionHost)
  requireReceipt(evidence.executionHostProofDigest === evidenceDigest(receipt.executionHost),
    'prior_receipt_host_digest_mismatch')
  const host = receipt.executionHost as Record<string, unknown>
  requireReceipt(evidence.executionHostAuthorizationDigest === evidenceDigest({
    candidateIdentityDigest: evidence.candidateIdentityDigest,
    humanAuthorizationDigest: evidence.humanAuthorizationDigest,
    origin: host.origin,
    bundleSha256: host.bundleSha256,
    imageId: host.imageId,
  }), 'prior_receipt_host_authorization_mismatch')
  validateSemantics(receipt.releaseSemantics, receipt.rollback)
  const storage = record(receipt.storageCompatibility, 'prior_receipt_storage_invalid')
  exactKeys(storage, ['coreRevision', 'sandboxRevision'], 'prior_receipt_storage_shape_invalid')
  requireReceipt(digest(storage.coreRevision) && digest(storage.sandboxRevision), 'prior_receipt_storage_invalid')
  return receipt as unknown as DeploymentReceipt
}

export function buildRollbackReceipt(input: Readonly<{
  identity: CandidateIdentity
  failedStage: string
  predecessors: Readonly<{ core: string; edge: string }>
}>): RollbackReceipt {
  return Object.freeze({
    schema: PRODUCTION_ROLLBACK_RECEIPT_SCHEMA,
    disposition: 'exact-core-edge-predecessors-restored-sandbox-preserved',
    candidateSha: input.identity.candidateSha,
    candidateDigest: input.identity.candidateDigest,
    failedStage: boundedStage(input.failedStage),
    restoredPredecessors: input.predecessors,
    sandboxDisposition: 'preserve-and-forward-recover',
    storageCompatibilityVerified: true,
  })
}

export function buildPreserveRequiredReceipt(input: Readonly<{
  identity: CandidateIdentity
  releaseMode: ProductionReleaseMode
  runId: number
  humanAuthorization: unknown
  operatorPins: unknown
  routeAuthority: unknown
  priorArtifactAuthorityProof: unknown | null
  priorDeploymentReceipt: DeploymentReceipt | null
  failedStage: string
  reason: PreserveRequiredReceipt['reason']
  predecessors: WorkerVersions
  candidates: Readonly<Partial<CandidateVersions>>
  observedActive: ObservedWorkerVersions
  sandboxMutationStarted: boolean
}>): PreserveRequiredReceipt {
  return Object.freeze({
    schema: PRODUCTION_PRESERVE_RECEIPT_SCHEMA,
    disposition: 'preserve-and-forward-recover',
    candidateSha: input.identity.candidateSha,
    candidateDigest: input.identity.candidateDigest,
    releaseMode: input.releaseMode,
    runId: input.runId,
    runAttempt: 1,
    evidence: Object.freeze({
      candidateIdentityDigest: evidenceDigest(input.identity),
      humanAuthorizationDigest: evidenceDigest(input.humanAuthorization),
      operatorPinsDigest: evidenceDigest(input.operatorPins),
      routeAuthorityDigest: evidenceDigest(input.routeAuthority),
      priorArtifactAuthorityProofDigest: input.priorArtifactAuthorityProof === null
        ? null : evidenceDigest(input.priorArtifactAuthorityProof),
    }),
    failedStage: boundedStage(input.failedStage),
    reason: input.reason,
    predecessors: input.predecessors,
    priorDeploymentReceipt: input.priorDeploymentReceipt,
    candidates: input.candidates,
    observedActive: input.observedActive,
    sandboxMutationStarted: input.sandboxMutationStarted,
    rollbackAttempted: false,
    recovery: 'authenticated-artifact-required-then-roll-forward',
  })
}

export function parsePreserveRequiredReceipt(value: unknown): PreserveRequiredReceipt {
  const receipt = record(value, 'preserve_receipt_invalid')
  exactKeys(receipt, [
    'candidateDigest', 'candidateSha', 'candidates', 'disposition', 'evidence', 'failedStage',
    'observedActive', 'predecessors', 'priorDeploymentReceipt', 'reason', 'recovery', 'releaseMode', 'rollbackAttempted',
    'runAttempt', 'runId', 'sandboxMutationStarted', 'schema',
  ], 'preserve_receipt_shape_invalid')
  requireReceipt(receipt.schema === PRODUCTION_PRESERVE_RECEIPT_SCHEMA
    && receipt.disposition === 'preserve-and-forward-recover'
    && sha1(receipt.candidateSha) && digest(receipt.candidateDigest)
    && ['bootstrap', 'steady-state', 'recovery'].includes(String(receipt.releaseMode))
    && Number.isSafeInteger(receipt.runId) && Number(receipt.runId) > 0 && receipt.runAttempt === 1
    && typeof receipt.failedStage === 'string' && receipt.failedStage.length > 0
    && receipt.rollbackAttempted === false
    && receipt.recovery === 'authenticated-artifact-required-then-roll-forward'
    && typeof receipt.sandboxMutationStarted === 'boolean', 'preserve_receipt_identity_invalid')
  exactVersions(receipt.predecessors, true)
  if (receipt.priorDeploymentReceipt !== null) parseDeploymentReceipt(receipt.priorDeploymentReceipt)
  const candidates = record(receipt.candidates, 'preserve_receipt_candidates_invalid')
  requireReceipt(Object.keys(candidates).every((kind) => ['sandbox', 'core', 'edge'].includes(kind)),
    'preserve_receipt_candidates_shape_invalid')
  for (const value of Object.values(candidates)) requireReceipt(versionId(value), 'preserve_receipt_candidate_invalid')
  const observed = record(receipt.observedActive, 'preserve_receipt_observed_invalid')
  exactKeys(observed, ['core', 'edge', 'sandbox'], 'preserve_receipt_observed_shape_invalid')
  for (const value of Object.values(observed)) {
    requireReceipt(value === null || value === 'unknown' || versionId(value), 'preserve_receipt_observed_invalid')
  }
  const evidence = record(receipt.evidence, 'preserve_receipt_evidence_invalid')
  exactKeys(evidence, [
    'candidateIdentityDigest', 'humanAuthorizationDigest', 'operatorPinsDigest',
    'priorArtifactAuthorityProofDigest', 'routeAuthorityDigest',
  ], 'preserve_receipt_evidence_shape_invalid')
  for (const key of ['candidateIdentityDigest', 'humanAuthorizationDigest', 'operatorPinsDigest',
    'routeAuthorityDigest']) requireReceipt(digest(evidence[key]), 'preserve_receipt_evidence_invalid')
  requireReceipt(evidence.priorArtifactAuthorityProofDigest === null
    || digest(evidence.priorArtifactAuthorityProofDigest), 'preserve_receipt_authority_invalid')
  return receipt as unknown as PreserveRequiredReceipt
}

function validateProof(value: unknown, kind: WorkerKind): void {
  const proof = record(value, 'prior_receipt_worker_proof_invalid')
  exactKeys(proof, [
    'bindingDigest', 'candidateDigest', 'candidateSha', 'migrationConfigDigest', 'percentage',
    'remoteRuntimeDigest', 'remoteScriptDigest', 'schema', 'versionId', 'worker',
  ], 'prior_receipt_worker_proof_shape_invalid')
  requireReceipt(proof.schema === 'agentic-commerce-worker-deployment/v3' && proof.worker === kind
    && proof.percentage === 100 && sha1(proof.candidateSha) && digest(proof.candidateDigest)
    && typeof proof.versionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(proof.versionId),
  'prior_receipt_worker_proof_identity_invalid')
  for (const key of ['bindingDigest', 'migrationConfigDigest', 'remoteRuntimeDigest', 'remoteScriptDigest']) {
    requireReceipt(digest(proof[key]), 'prior_receipt_worker_proof_digest_invalid')
  }
}

function validateSemantics(value: unknown, rollbackValue: unknown): void {
  const semantics = record(value, 'prior_receipt_semantics_invalid')
  exactKeys(semantics, [
    'atomic', 'hostAvailability', 'postSandboxFailureRecovery',
    'sandboxWorkerActivatesBeforeHostVerification',
  ], 'prior_receipt_semantics_shape_invalid')
  requireReceipt(semantics.atomic === false && semantics.hostAvailability === 'device-session'
    && semantics.sandboxWorkerActivatesBeforeHostVerification === true
    && semantics.postSandboxFailureRecovery === 'preserve-and-forward-recover',
  'prior_receipt_semantics_invalid')
  const rollback = record(rollbackValue, 'prior_receipt_rollback_invalid')
  exactKeys(rollback, ['reason', 'supported'], 'prior_receipt_rollback_shape_invalid')
  requireReceipt(rollback.supported === false
    && rollback.reason === 'device_host_and_storage_rollback_unproven', 'prior_receipt_rollback_invalid')
}

function exactVersions(value: unknown, nullable: boolean): void {
  const versions = record(value, 'prior_receipt_worker_versions_invalid')
  exactKeys(versions, ['core', 'edge', 'sandbox'], 'prior_receipt_worker_versions_shape_invalid')
  requireReceipt(Object.values(versions).every((version) => (nullable && version === null)
    || (typeof version === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(version))),
  'prior_receipt_worker_version_invalid')
}

function sha1(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
}

function digest(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function versionId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}

function boundedStage(value: string): string {
  requireReceipt(value === value.trim() && value.length > 0 && value.length <= 128, 'failed_stage_invalid')
  return value
}

function record(value: unknown, code: string): Record<string, unknown> {
  requireReceipt(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  requireReceipt(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()), code)
}

function requireReceipt(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_release_receipt:${code}`)
}
