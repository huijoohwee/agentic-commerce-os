import { canonicalJson } from '../evidence-integrity.ts'
import {
  sameContainerDeployment,
  sandboxContainerApplicationAbsent,
  validateSandboxContainerDeployment,
  type SandboxContainerProof,
} from './container-release.ts'
import {
  revalidateWorkerVersionProof,
  validateProductionSandboxTopology,
  validateProductionTopology,
  validateWorkerVersion,
  type WorkerDeploymentProof,
} from './contracts.ts'
import type { ProductionHumanAuthorization } from './human-authorization.ts'
import {
  selectExistingCandidateVersion,
  selectUploadedVersion,
  type CandidateIdentity,
} from './lifecycle.ts'
import {
  buildDeploymentReceipt,
  buildPreserveRequiredReceipt,
  evidenceDigest,
  type CandidateVersions,
  type DeploymentProofs,
  type DeploymentReceipt,
  type ObservedWorkerVersions,
  type PreserveRequiredReceipt,
  type ProductionReleaseMode,
  type WorkerKind,
  type WorkerVersions,
} from './controller-receipts.ts'
import type { PriorReleaseAuthorityProof, RecoveryReleaseAuthorityProof } from './prior-release-authority.ts'
import {
  validateRecoveryRouteAuthorityProof,
  validateProductionRouteAuthorityProof,
  type ProductionRouteAuthority,
} from './route-authority.ts'

const WORKERS = Object.freeze(['sandbox', 'core', 'edge'] as const)
const VERSIONED_WORKERS = Object.freeze(['core', 'edge'] as const)
type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] }
export type ProductionOperatorPins = Readonly<{
  acosSourceRevision: string
  acosCandidateDigest: string
  discoveryProviderEvidencePinJson: string
  checkoutProviderEvidencePinJson: string
  marketplaceProviderEvidencePinJson: string
  humanPresenceTrustAnchorJson: string
}>

export type UploadInput = Readonly<{
  candidateSha: string
  variables: Readonly<Record<string, string>>
  secrets: Readonly<Record<string, string>>
}>

export type ProductionReleaseAdapter = Readonly<{
  activeVersion(kind: WorkerKind): Promise<string | null>
  listVersions(kind: WorkerKind): Promise<unknown>
  uploadInactive(kind: 'core' | 'edge', input: UploadInput): Promise<void>
  deploySandbox(input: UploadInput): Promise<void>
  viewVersion(kind: WorkerKind, versionId: string): Promise<unknown>
  activate(kind: 'core' | 'edge', versionId: string): Promise<void>
  waitForSandboxContainer(): Promise<unknown>
  containerInventory(): Promise<unknown>
  readRouteAuthority(authority: ProductionRouteAuthority, phase: 'before' | 'after' | 'recovery'): Promise<unknown>
  activateBootstrapRoute(authority: ProductionRouteAuthority): Promise<void>
  proveLiveRoute(input: Readonly<{
    candidateSha: string
    candidateDigest: string
    edgeVersionId: string
    coreVersionId: string
  }>): Promise<unknown>
}>

export type ProductionControllerInput = Readonly<{
  releaseMode: ProductionReleaseMode
  identity: CandidateIdentity
  runId: number
  humanAuthorization: ProductionHumanAuthorization
  operatorPins: ProductionOperatorPins
  routeAuthority: ProductionRouteAuthority
  secrets: Readonly<Record<string, string>>
  priorReceipt: DeploymentReceipt | null
  priorAuthorityProof: PriorReleaseAuthorityProof | RecoveryReleaseAuthorityProof | null
  recoveryReceipt: PreserveRequiredReceipt | null
  configs: Readonly<Record<WorkerKind, unknown>>
  adapter: ProductionReleaseAdapter
}>

export type ProductionControllerOutcome =
  | Readonly<{ ok: true; receipt: DeploymentReceipt }>
  | Readonly<{ ok: false; receipt: PreserveRequiredReceipt; cause: string }>

export async function executeProductionRelease(
  input: ProductionControllerInput,
): Promise<ProductionControllerOutcome> {
  validateStaticContracts(input)
  if (input.releaseMode === 'recovery') return executeRecoveryRelease(input)
  const routeBefore = validateProductionRouteAuthorityProof(
    input.routeAuthority,
    await input.adapter.readRouteAuthority(input.routeAuthority, 'before'),
    'before',
  )
  const predecessors = await readActiveTuple(input.adapter)
  const containerBefore = await input.adapter.containerInventory()
  await validateStartingState(input, predecessors, containerBefore)
  const listedBefore = await listAllVersions(input.adapter)
  const candidates: MutablePartial<CandidateVersions> = {}
  const proofs: MutablePartial<DeploymentProofs> = {}
  let sandboxMutationStarted = false
  let stage = 'upload-inactive-core-edge'
  try {
    await Promise.all(VERSIONED_WORKERS.map(async (kind) => {
      await input.adapter.uploadInactive(kind, uploadInput(input, kind))
    }))
    const listedAfterInactive = await listAllVersions(input.adapter)
    for (const kind of VERSIONED_WORKERS) {
      candidates[kind] = selectUploadedVersion(
        listedBefore[kind],
        listedAfterInactive[kind],
        input.identity.candidateSha,
      )
      const version = await input.adapter.viewVersion(kind, candidates[kind] as string)
      proofs[kind] = validateUploadedVersion(input, kind, candidates[kind] as string, version)
    }
    stage = 'compare-and-swap-before-sandbox'
    await requireActiveTuple(input.adapter, predecessors)
    stage = 'deploy-sandbox-worker-and-container-immediate'
    sandboxMutationStarted = true
    await input.adapter.deploySandbox(uploadInput(input, 'sandbox'))
    const listedAfterSandbox = await listAllVersions(input.adapter)
    candidates.sandbox = selectUploadedVersion(
      listedBefore.sandbox,
      listedAfterSandbox.sandbox,
      input.identity.candidateSha,
    )
    const sandboxVersion = await input.adapter.viewVersion('sandbox', candidates.sandbox)
    proofs.sandbox = validateUploadedVersion(input, 'sandbox', candidates.sandbox, sandboxVersion)
    await requireActiveTuple(input.adapter, Object.freeze({
      sandbox: candidates.sandbox,
      core: predecessors.core,
      edge: predecessors.edge,
    }))
    stage = 'prove-sandbox-container-rollout'
    const sandboxContainer = validateSandboxContainerDeployment(
      await input.adapter.waitForSandboxContainer(),
      input.identity.sandboxContainerBuildInputDigest,
    )
    requireContainerProgression(input.priorReceipt, containerBefore, sandboxContainer)
    const exactCandidates = completeCandidates(candidates)
    const exactProofs = completeProofs(proofs)
    for (const kind of VERSIONED_WORKERS) {
      stage = `compare-and-swap-before-${kind}`
      await requireActiveTuple(input.adapter, expectedTuple(predecessors, exactCandidates, kind))
      stage = `activate-${kind}`
      await input.adapter.activate(kind, exactCandidates[kind])
      stage = `verify-active-${kind}`
      await requireActiveTuple(input.adapter, expectedTuple(
        predecessors,
        exactCandidates,
        kind === 'core' ? 'edge' : 'complete',
      ))
    }
    stage = 'activate-or-revalidate-route-authority'
    if (input.releaseMode === 'bootstrap') {
      await input.adapter.activateBootstrapRoute(input.routeAuthority)
    }
    const routeAfter = validateProductionRouteAuthorityProof(
      input.routeAuthority,
      await input.adapter.readRouteAuthority(input.routeAuthority, 'after'),
      'after',
    )
    if (input.releaseMode === 'steady-state') {
      requireController(routeAfter.routeId === routeBefore.routeId, 'route_authority_changed')
    }
    stage = 'verify-live-route'
    const routeProof = await input.adapter.proveLiveRoute({
      candidateSha: input.identity.candidateSha,
      candidateDigest: input.identity.candidateDigest,
      edgeVersionId: exactCandidates.edge,
      coreVersionId: exactCandidates.core,
    })
    return Object.freeze({
      ok: true,
      receipt: buildDeploymentReceipt({
        releaseMode: input.releaseMode,
        identity: input.identity,
        runId: input.runId,
        humanAuthorization: input.humanAuthorization,
        operatorPins: input.operatorPins,
        priorArtifactAuthorityProof: input.priorAuthorityProof,
        predecessors,
        candidates: exactCandidates,
        deploymentProofs: exactProofs,
        sandboxContainer,
        routeAuthorityBefore: routeBefore,
        routeAuthorityAfter: routeAfter,
        routeProof,
      }),
    })
  } catch (error) {
    return preserve(
      input,
      stage,
      failureReason(stage, input.releaseMode, sandboxMutationStarted),
      predecessors,
      candidates,
      await readActiveTupleBestEffort(input.adapter),
      sandboxMutationStarted,
      safeCause(error),
    )
  }
}

async function executeRecoveryRelease(input: ProductionControllerInput): Promise<ProductionControllerOutcome> {
  const receipt = input.recoveryReceipt as PreserveRequiredReceipt
  const predecessors = receipt.predecessors
  const routeBefore = validateRecoveryRouteAuthorityProof(
    input.routeAuthority,
    await input.adapter.readRouteAuthority(input.routeAuthority, 'recovery'),
  )
  let active = await readActiveTuple(input.adapter)
  const containerBefore = await input.adapter.containerInventory()
  await validateRecoveryStartingState(input, active, containerBefore)
  let listed = await listAllVersions(input.adapter)
  const candidates: MutablePartial<CandidateVersions> = { ...receipt.candidates }
  const proofs: MutablePartial<DeploymentProofs> = {}
  let sandboxMutationStarted = receipt.sandboxMutationStarted
  let stage = 'recovery-prepare-candidates'
  try {
    for (const kind of VERSIONED_WORKERS) {
      let versionId = selectExistingCandidateVersion(
        listed[kind], input.identity.candidateSha, candidates[kind],
      )
      if (versionId === null) {
        await input.adapter.uploadInactive(kind, uploadInput(input, kind))
        const after = await input.adapter.listVersions(kind)
        versionId = selectUploadedVersion(listed[kind], after, input.identity.candidateSha)
        listed[kind] = after
      }
      candidates[kind] = versionId
      proofs[kind] = validateUploadedVersion(
        input, kind, versionId, await input.adapter.viewVersion(kind, versionId),
      )
    }
    let sandboxId = selectExistingCandidateVersion(
      listed.sandbox,
      input.identity.candidateSha,
      candidates.sandbox ?? (active.sandbox !== predecessors.sandbox ? active.sandbox ?? undefined : undefined),
    )
    let sandboxContainer: SandboxContainerProof
    if (sandboxId !== null && active.sandbox === sandboxId) {
      requireController(sandboxMutationStarted, 'recovery_unproven_sandbox_activation')
      candidates.sandbox = sandboxId
      proofs.sandbox = validateUploadedVersion(
        input, 'sandbox', sandboxId, await input.adapter.viewVersion('sandbox', sandboxId),
      )
      sandboxContainer = validateSandboxContainerDeployment(
        await input.adapter.waitForSandboxContainer(), input.identity.sandboxContainerBuildInputDigest,
      )
      if (input.priorReceipt) requireContainerProgression(input.priorReceipt, containerBefore, sandboxContainer)
    } else {
      requireController(active.sandbox === predecessors.sandbox, 'recovery_sandbox_baseline_changed')
      stage = 'recovery-deploy-sandbox-worker-and-container-immediate'
      sandboxMutationStarted = true
      await input.adapter.deploySandbox(uploadInput(input, 'sandbox'))
      const after = await input.adapter.listVersions('sandbox')
      sandboxId = selectUploadedVersion(listed.sandbox, after, input.identity.candidateSha)
      candidates.sandbox = sandboxId
      proofs.sandbox = validateUploadedVersion(
        input, 'sandbox', sandboxId, await input.adapter.viewVersion('sandbox', sandboxId),
      )
      active = await readActiveTuple(input.adapter)
      requireController(active.sandbox === sandboxId, 'recovery_sandbox_activation_unconfirmed')
      sandboxContainer = validateSandboxContainerDeployment(
        await input.adapter.waitForSandboxContainer(), input.identity.sandboxContainerBuildInputDigest,
      )
      requireContainerProgression(input.priorReceipt, containerBefore, sandboxContainer)
    }
    const exactCandidates = completeCandidates(candidates)
    const exactProofs = completeProofs(proofs)
    for (const kind of VERSIONED_WORKERS) {
      active = await readActiveTuple(input.adapter)
      if (active[kind] === exactCandidates[kind]) continue
      requireController(active[kind] === predecessors[kind], `recovery_${kind}_baseline_changed`)
      stage = `recovery-activate-${kind}`
      await input.adapter.activate(kind, exactCandidates[kind])
      const after = await readActiveTuple(input.adapter)
      requireController(after[kind] === exactCandidates[kind], `recovery_${kind}_activation_unconfirmed`)
    }
    stage = 'recovery-activate-or-revalidate-route-authority'
    if (routeBefore.state === 'absent') await input.adapter.activateBootstrapRoute(input.routeAuthority)
    const routeAfter = validateProductionRouteAuthorityProof(
      input.routeAuthority, await input.adapter.readRouteAuthority(input.routeAuthority, 'after'), 'after',
    )
    stage = 'recovery-verify-live-route'
    const routeProof = await input.adapter.proveLiveRoute({
      candidateSha: input.identity.candidateSha,
      candidateDigest: input.identity.candidateDigest,
      edgeVersionId: exactCandidates.edge,
      coreVersionId: exactCandidates.core,
    })
    return Object.freeze({ ok: true, receipt: buildDeploymentReceipt({
      releaseMode: 'recovery', identity: input.identity, runId: input.runId,
      humanAuthorization: input.humanAuthorization, operatorPins: input.operatorPins,
      priorArtifactAuthorityProof: input.priorAuthorityProof, predecessors, candidates: exactCandidates,
      deploymentProofs: exactProofs, sandboxContainer, routeAuthorityBefore: routeBefore,
      routeAuthorityAfter: routeAfter, routeProof,
    }) })
  } catch (error) {
    return preserve(input, stage, failureReason(stage, 'recovery', sandboxMutationStarted), predecessors,
      candidates, await readActiveTupleBestEffort(input.adapter), sandboxMutationStarted, safeCause(error))
  }
}

function validateStaticContracts(input: ProductionControllerInput): void {
  validateProductionTopology(input.configs.core, input.configs.edge)
  validateProductionSandboxTopology(input.configs.sandbox)
  const expectedRouteMode = input.releaseMode === 'steady-state' ? 'steady-state' : 'bootstrap'
  requireController(input.routeAuthority.mode === expectedRouteMode, 'route_authority_mode_mismatch')
  requireController(input.humanAuthorization.candidateSha === input.identity.candidateSha
    && input.humanAuthorization.releaseMode === input.releaseMode
    && input.humanAuthorization.runId === input.runId
    && input.humanAuthorization.runAttempt === 1, 'human_authorization_identity_mismatch')
  if (input.releaseMode === 'recovery') {
    requireController(input.recoveryReceipt !== null && input.priorAuthorityProof !== null,
      'recovery_authenticated_preserve_receipt_required')
    requireController(input.recoveryReceipt.candidateSha === input.identity.candidateSha
      && input.recoveryReceipt.candidateDigest === input.identity.candidateDigest
      && input.recoveryReceipt.evidence.candidateIdentityDigest === evidenceDigest(input.identity)
      && input.recoveryReceipt.evidence.operatorPinsDigest === evidenceDigest(input.operatorPins)
      && input.recoveryReceipt.evidence.routeAuthorityDigest === evidenceDigest(input.routeAuthority)
      && input.priorAuthorityProof.workflowHeadSha === input.identity.candidateSha
      && input.priorAuthorityProof.receiptDigest === evidenceDigest(input.recoveryReceipt),
    'recovery_preserve_receipt_identity_mismatch')
  } else {
    requireController(input.recoveryReceipt === null, 'recovery_receipt_forbidden')
  }
}

async function validateRecoveryStartingState(
  input: ProductionControllerInput,
  active: WorkerVersions,
  containerInventory: unknown,
): Promise<void> {
  const receipt = input.recoveryReceipt as PreserveRequiredReceipt
  const prior = receipt.priorDeploymentReceipt
  requireController(canonicalJson(prior) === canonicalJson(input.priorReceipt),
    'recovery_prior_receipt_mismatch')
  if (prior === null) {
    requireController(WORKERS.every((kind) => receipt.predecessors[kind] === null),
      'recovery_bootstrap_predecessors_invalid')
  } else {
    requireController(canonicalJson(prior.workerVersions.candidates)
      === canonicalJson(receipt.predecessors), 'recovery_predecessors_not_prior_candidates')
  }
  for (const kind of WORKERS) {
    const candidate = receipt.candidates[kind]
    const ambiguousSandboxCandidate = kind === 'sandbox'
      && receipt.sandboxMutationStarted
      && candidate === undefined
      && typeof active.sandbox === 'string'
      && receipt.observedActive.sandbox === active.sandbox
    requireController(active[kind] === receipt.predecessors[kind]
      || (candidate !== undefined && active[kind] === candidate)
      || ambiguousSandboxCandidate, `recovery_${kind}_state_unowned`)
    if (ambiguousSandboxCandidate) {
      validateUploadedVersion(
        input, 'sandbox', active.sandbox as string,
        await input.adapter.viewVersion('sandbox', active.sandbox as string),
      )
    }
    if (prior && active[kind] === receipt.predecessors[kind]) {
      revalidateWorkerVersionProof(
        await input.adapter.viewVersion(kind, active[kind] as string),
        prior.evidence.deploymentProofs[kind],
      )
    }
  }
  if (active.sandbox === receipt.predecessors.sandbox) {
    if (prior === null) {
      requireController(sandboxContainerApplicationAbsent(containerInventory),
        'recovery_bootstrap_container_not_absent')
    } else {
      const observed = validateSandboxContainerDeployment(
        containerInventory, prior.sandboxContainer.buildInputDigest,
      )
      requireController(sameContainerDeployment(observed, prior.sandboxContainer),
        'recovery_container_predecessor_mismatch')
    }
  }
}

async function validateStartingState(
  input: ProductionControllerInput,
  active: WorkerVersions,
  containerInventory: unknown,
): Promise<void> {
  if (input.releaseMode === 'bootstrap') {
    requireController(WORKERS.every((kind) => active[kind] === null), 'bootstrap_active_worker_present')
    requireController(input.priorReceipt === null && input.priorAuthorityProof === null,
      'bootstrap_prior_evidence_forbidden')
    requireController(sandboxContainerApplicationAbsent(containerInventory),
      'bootstrap_container_application_present')
    return
  }
  requireController(input.priorReceipt !== null && input.priorAuthorityProof !== null,
    'steady_state_authenticated_prior_receipt_required')
  requireController(canonicalJson(input.priorReceipt.workerVersions.candidates) === canonicalJson(active),
    'steady_state_baseline_receipt_mismatch')
  requireController(input.priorReceipt.candidateSha !== input.identity.candidateSha, 'candidate_already_active')
  for (const kind of WORKERS) {
    const version = await input.adapter.viewVersion(kind, active[kind] as string)
    revalidateWorkerVersionProof(version, input.priorReceipt.evidence.deploymentProofs[kind])
  }
  const observedContainer = validateSandboxContainerDeployment(
    containerInventory,
    input.priorReceipt.sandboxContainer.buildInputDigest,
  )
  requireController(sameContainerDeployment(observedContainer, input.priorReceipt.sandboxContainer),
    'steady_state_container_baseline_mismatch')
}

function uploadInput(input: ProductionControllerInput, kind: WorkerKind): UploadInput {
  const variables: Record<string, string> = {
    RELEASE_CANDIDATE_SHA: input.identity.candidateSha,
    RELEASE_CANDIDATE_DIGEST: input.identity.candidateDigest,
  }
  if (kind === 'core') Object.assign(variables, coreOverrides(input.operatorPins))
  if (kind === 'edge') variables.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON = input.operatorPins.humanPresenceTrustAnchorJson
  return Object.freeze({
    candidateSha: input.identity.candidateSha,
    variables: Object.freeze(variables),
    secrets: Object.freeze(kind === 'sandbox' ? {} : requiredSecrets(input.secrets, kind)),
  })
}

function validateUploadedVersion(
  input: ProductionControllerInput,
  kind: WorkerKind,
  versionId: string,
  version: unknown,
): WorkerDeploymentProof {
  return validateWorkerVersion(input.configs[kind], version, {
    kind,
    candidateSha: input.identity.candidateSha,
    candidateDigest: input.identity.candidateDigest,
    versionId,
    ...(kind === 'core' ? {
      acosSourceRevision: input.operatorPins.acosSourceRevision,
      acosCandidateDigest: input.operatorPins.acosCandidateDigest,
      variableOverrides: coreOverrides(input.operatorPins),
    } : {}),
    ...(kind === 'edge' ? {
      humanPresenceTrustAnchorBinding: input.operatorPins.humanPresenceTrustAnchorJson,
    } : {}),
  })
}

function coreOverrides(pins: ProductionOperatorPins): Readonly<Record<string, string>> {
  return Object.freeze({
    ACOS_RUNTIME_SOURCE_REVISION: pins.acosSourceRevision,
    ACOS_RUNTIME_CANDIDATE_DIGEST: pins.acosCandidateDigest,
    DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON: pins.discoveryProviderEvidencePinJson,
    CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON: pins.checkoutProviderEvidencePinJson,
    MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON: pins.marketplaceProviderEvidencePinJson,
  })
}

function requiredSecrets(values: Readonly<Record<string, string>>, kind: 'core' | 'edge'): Record<string, string> {
  const names = kind === 'core'
    ? [
        'DISCOVERY_PROVIDER_BEARER_TOKEN',
        'AGENTIC_OS_ADMISSION_AUTH_SECRET',
        'CHECKOUT_PROVIDER_AUTH_SECRET',
        'MARKETPLACE_PROVIDER_AUTH_SECRET',
      ]
    : ['MCP_BEARER_TOKEN', 'OPERATOR_BEARER_TOKEN', 'STOREFRONT_SESSION_SECRET']
  return Object.fromEntries(names.map((name) => [name, values[name] as string]))
}

async function readActiveTuple(adapter: ProductionReleaseAdapter): Promise<WorkerVersions> {
  const [sandbox, core, edge] = await Promise.all([
    adapter.activeVersion('sandbox'), adapter.activeVersion('core'), adapter.activeVersion('edge'),
  ])
  return Object.freeze({ sandbox, core, edge })
}
async function readActiveTupleBestEffort(adapter: ProductionReleaseAdapter): Promise<ObservedWorkerVersions> {
  const read = async (kind: WorkerKind): Promise<string | null | 'unknown'> => {
    try { return await adapter.activeVersion(kind) } catch { return 'unknown' as const }
  }
  const [sandbox, core, edge] = await Promise.all([read('sandbox'), read('core'), read('edge')])
  return Object.freeze({ sandbox, core, edge })
}
async function listAllVersions(adapter: ProductionReleaseAdapter): Promise<Record<WorkerKind, unknown>> {
  const [sandbox, core, edge] = await Promise.all(WORKERS.map((kind) => adapter.listVersions(kind)))
  return { sandbox, core, edge }
}
async function requireActiveTuple(adapter: ProductionReleaseAdapter, expected: WorkerVersions): Promise<void> {
  const observed = await readActiveTuple(adapter)
  requireController(canonicalJson(observed) === canonicalJson(expected), 'active_baseline_compare_and_swap_lost')
}
function expectedTuple(
  predecessors: WorkerVersions,
  candidates: CandidateVersions,
  before: 'core' | 'edge' | 'complete',
): WorkerVersions {
  return Object.freeze({
    sandbox: candidates.sandbox,
    core: before === 'core' ? predecessors.core : candidates.core,
    edge: before === 'complete' ? candidates.edge : predecessors.edge,
  })
}

function completeCandidates(value: MutablePartial<CandidateVersions>): CandidateVersions {
  requireController(WORKERS.every((kind) => typeof value[kind] === 'string'), 'candidate_version_incomplete')
  return Object.freeze({ sandbox: value.sandbox as string, core: value.core as string, edge: value.edge as string })
}

function completeProofs(value: MutablePartial<DeploymentProofs>): DeploymentProofs {
  requireController(WORKERS.every((kind) => value[kind] !== undefined), 'deployment_proof_incomplete')
  return Object.freeze({
    sandbox: value.sandbox as WorkerDeploymentProof,
    core: value.core as WorkerDeploymentProof,
    edge: value.edge as WorkerDeploymentProof,
  })
}

function requireContainerProgression(
  prior: DeploymentReceipt | null,
  before: unknown,
  current: SandboxContainerProof,
): void {
  if (prior === null) {
    requireController(sandboxContainerApplicationAbsent(before), 'bootstrap_container_baseline_not_absent')
    return
  }
  requireController(current.applicationId === prior.sandboxContainer.applicationId,
    'container_application_identity_changed')
  requireController(current.applicationVersion > prior.sandboxContainer.applicationVersion,
    'authorized_container_build_version_not_advanced')
}

function failureReason(
  stage: string,
  mode: ProductionReleaseMode,
  sandboxMutationStarted: boolean,
): PreserveRequiredReceipt['reason'] {
  if (stage.includes('route-authority')) return 'route_authority_changed'
  if (stage.includes('compare-and-swap')) return 'compare_and_swap_lost'
  if (stage === 'prove-sandbox-container-rollout') return 'container_rollout_unproven'
  if (sandboxMutationStarted) return 'container_rollout_not_transactional'
  return mode === 'bootstrap' ? 'bootstrap_has_no_predecessor' : 'release_stage_failed'
}

function preserve(
  input: ProductionControllerInput,
  stage: string,
  reason: PreserveRequiredReceipt['reason'],
  predecessors: WorkerVersions,
  candidates: MutablePartial<CandidateVersions>,
  observedActive: ObservedWorkerVersions,
  sandboxMutationStarted: boolean,
  cause: string,
): ProductionControllerOutcome {
  return Object.freeze({
    ok: false,
    cause,
    receipt: buildPreserveRequiredReceipt({
      identity: input.identity,
      releaseMode: input.releaseMode,
      runId: input.runId,
      humanAuthorization: input.humanAuthorization,
      operatorPins: input.operatorPins,
      routeAuthority: input.routeAuthority,
      priorArtifactAuthorityProof: input.priorAuthorityProof,
      priorDeploymentReceipt: input.priorReceipt,
      failedStage: stage,
      reason,
      predecessors,
      candidates: Object.freeze({ ...candidates }),
      observedActive,
      sandboxMutationStarted,
    }),
  })
}

function safeCause(value: unknown): string {
  const raw = value instanceof Error ? value.message : 'unknown_release_error'
  return raw.replace(/[\r\n]/gu, ' ').slice(0, 256)
}

function requireController(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_controller:${code}`)
}
