import { pathCovered } from './conflict.ts'
import {
  buildMergeAgentEvidence,
  recordCheckFailureEvidence,
  recordCommandEvidence,
  type CheckFailureEvidence,
  type CommandEvidence,
  type LaneAdmissionEvidence,
  type LaneAuthorityObservation,
  type LaneMutationAdmission,
  type LaneMutationAdmissionRequest,
  type MergeAgentEvidenceArtifact,
} from './evidence.ts'
import { validMergeBounds } from './index.ts'
import { Halt } from './halt.ts'
import {
  observationCommands,
  localConflictCommand,
  localCheckoutCommands,
  parseConflictPaths,
  parseLocalCheckout,
  parseMergeObservation,
  type GitHubTarget,
  type LocalCheckoutObservation,
  type MergeObservation,
} from './observation.ts'
import { parsePatchNumstat, patchPaths } from './patch.ts'
import { validateMergePlan } from './plan-validation.ts'
import {
  actionAllowed,
  boundCheckInvocation,
  commandAllowed,
  type MergeCommandPolicy,
} from './policy.ts'
import type { CommandExecution, CommandInvocation, CommandRunner } from './runner.ts'
import type { LaneBinding, MergeAction, MergeBounds, MergeReason } from './types.ts'
import { bounded, boundedCode, sameStrings, validAuthorityObservation, validWriteSet } from './validation.ts'

const PATCH_COMMAND = Object.freeze(['apply', '--whitespace=nowarn', '-'])
const PATCH_NUMSTAT_COMMAND = Object.freeze(['apply', '--numstat', '-z', '-'])
const PATCH_CHECK_COMMAND = Object.freeze(['apply', '--check', '--whitespace=nowarn', '-'])

export type MergeRepair = Readonly<{
  approach: string
  patch: string
  tokens: number
}>

export type MergeOrchestrationPlan = Readonly<{
  reviewComments: Readonly<Record<string, Readonly<{
    withinRequirements: boolean
    requiresOperatorDecision: boolean
    repair: MergeRepair
  }>>>
  checks: Readonly<Record<string, Readonly<{
    script: string
    args?: readonly string[]
    approaches: readonly MergeRepair[]
  }>>>
  conflicts: Readonly<Record<string, MergeRepair>>
}>

export type MergeOrchestrationRequest = Readonly<{
  actingIdentity: string
  target: GitHubTarget
  plan: MergeOrchestrationPlan
}>

export type MergeOrchestrationLaneBinding = LaneBinding & Readonly<{
  semanticScope: string
}>

export type {
  LaneAuthorityObservation,
  LaneMutationAdmission,
  LaneMutationAdmissionRequest,
  MergeAgentEvidenceArtifact,
} from './evidence.ts'

export type MergeOrchestrationDependencies = Readonly<{
  runner: CommandRunner
  readAuthority(): Promise<LaneAuthorityObservation>
  admitMutation(request: LaneMutationAdmissionRequest): Promise<LaneMutationAdmission>
  nowMs?: () => number
  circuitBreakerObserved?: () => Promise<boolean>
}>

type MutableRun = {
  bounds: MergeBounds
  lane: MergeOrchestrationLaneBinding
  request: MergeOrchestrationRequest
  policy: MergeCommandPolicy
  dependencies: MergeOrchestrationDependencies
  nowMs: () => number
  startedAtMs: number
  actions: MergeAction[]
  changedPaths: Set<string>
  commands: CommandEvidence[]
  rawExecutions: Map<string, CommandExecution>
  observation: MergeObservation | null
  checkFailureEvidence: CheckFailureEvidence[]
  authorityChecks: LaneAuthorityObservation[]
  admissionChecks: LaneAdmissionEvidence[]
  mutationCount: number
  consumedTokens: number
  detail: string | null
}

export async function orchestrateMergeAgent(
  bounds: MergeBounds,
  lane: MergeOrchestrationLaneBinding,
  policy: MergeCommandPolicy,
  request: MergeOrchestrationRequest,
  dependencies: MergeOrchestrationDependencies,
): Promise<MergeAgentEvidenceArtifact> {
  const nowMs = dependencies.nowMs ?? Date.now
  const state: MutableRun = {
    bounds,
    lane,
    request,
    policy,
    dependencies,
    nowMs,
    startedAtMs: nowMs(),
    actions: [],
    changedPaths: new Set(),
    commands: [],
    rawExecutions: new Map(),
    observation: null,
    checkFailureEvidence: [],
    authorityChecks: [],
    admissionChecks: [],
    mutationCount: 0,
    consumedTokens: 0,
    detail: null,
  }
  let observation: MergeObservation | null = null
  let reason: MergeReason | null = initialFailure(state)
  if (!reason) {
    try {
      observation = await observe(state)
      state.observation = observation
      const preflight = validateMergePlan({
        observation,
        plan: state.request.plan,
        declaredWriteSet: state.lane.declaredWriteSet,
        policy: state.policy,
        commandCount: state.commands.length,
      })
      if (preflight) throw new Halt(preflight.reason, preflight.detail)
      await captureFailingCheckEvidence(observation, state)
      await applyConflictRepairs(observation, state)
      await applyReviewRepairs(observation, state)
      await applyCheckRepairs(observation, state)
    } catch (error) {
      const halt = error instanceof Halt
        ? error
        : new Halt('circuit-breaker', error instanceof Error ? error.message : 'merge_agent_failed')
      reason = halt.reason
      state.detail = halt.detail
    }
  }
  return buildMergeAgentEvidence({
    lane: state.lane.lane,
    claimId: state.lane.claimId,
    leaseEpoch: state.lane.leaseEpoch,
    fenceRevision: state.lane.fenceRevision,
    bounds: state.bounds,
    recordedAtMs: state.startedAtMs,
    observation,
    checkFailureEvidence: state.checkFailureEvidence,
    authorityChecks: state.authorityChecks,
    admissionChecks: state.admissionChecks,
    actions: state.actions,
    changedPaths: [...state.changedPaths],
    commands: state.commands,
    reason,
    detail: state.detail,
  })
}

async function observe(state: MutableRun): Promise<MergeObservation> {
  for (const invocation of observationCommands(state.request.target)) {
    const execution = await runCommand(state, invocation)
    state.rawExecutions.set(invocation.id, execution)
    if (execution.exitCode !== 0 || execution.outputTruncated) {
      throw new Halt('observation-failed', `Observation ${invocation.id} did not complete cleanly.`)
    }
  }
  const observation = parseMergeObservation(state.rawExecutions)
  if (!observation) throw new Halt('observation-failed', 'GitHub or conflict observation was malformed.')
  return observation
}

async function applyConflictRepairs(observation: MergeObservation, state: MutableRun): Promise<void> {
  for (const path of observation.conflictPaths) {
    await applyRepair(state, 'conflict-resolution', path, state.request.plan.conflicts[path]!, null)
    await stageResolvedConflict(state, path, observation.conflictPaths)
  }
}

async function stageResolvedConflict(
  state: MutableRun,
  path: string,
  originallyUnmerged: readonly string[],
): Promise<void> {
  await assertLaneIdentity(state)
  await authorizeMutation(state, 0, [path])
  const invocation: CommandInvocation = Object.freeze({
    id: `mutation-${state.mutationCount + 1}-stage-conflict`,
    kind: 'mutation',
    executable: 'git',
    args: Object.freeze(['add', '--', path]),
    timeoutMs: remainingTimeoutMs(state),
  })
  if (!actionAllowed('conflict-resolution', state.policy) || !commandAllowed(invocation, state.policy)) {
    throw new Halt('circuit-breaker', `Conflict staging for ${path} is not allowlisted.`)
  }
  state.mutationCount += 1
  const execution = await runCommand(state, invocation)
  state.actions.push(Object.freeze({
    sequence: state.actions.length + 1,
    actingIdentity: state.request.actingIdentity,
    lane: state.lane.lane,
    action: 'conflict-resolution',
    boundConsumed: boundConsumed(state),
    checkOutcome: execution.exitCode === 0 ? 'not-run' : 'fail',
    subject: path,
    approach: 'stage-resolved-path',
    changedPaths: Object.freeze([path]),
    commandId: invocation.id,
  }))
  if (execution.exitCode !== 0) throw new Halt('mutation-failed', `Conflict staging for ${path} failed.`)
  const unresolvedExecution = await runCommand(
    state,
    localConflictCommand(`post-stage-conflicts-${state.commands.length + 1}`),
  )
  const unresolved = parseConflictPaths(unresolvedExecution)
  if (!unresolved || unresolved.includes(path) || unresolved.some((entry) => !originallyUnmerged.includes(entry))) {
    throw new Halt('circuit-breaker', `Conflict staging for ${path} did not clear exactly the admitted index path.`)
  }
}

async function applyReviewRepairs(observation: MergeObservation, state: MutableRun): Promise<void> {
  for (const comment of observation.reviewComments) {
    await applyRepair(state, 'comment-change', comment.id, state.request.plan.reviewComments[comment.id]!.repair, null)
  }
}

async function captureFailingCheckEvidence(observation: MergeObservation, state: MutableRun): Promise<void> {
  for (const check of observation.checks.filter(({ outcome }) => outcome === 'fail')) {
    const invocation = boundCheckInvocation(
      check.identity,
      `preflight-check-${state.commands.length + 1}`,
      state.policy,
    )
    if (!invocation) throw new Halt('scope-gap', `Check ${check.identity} has no checked-in command binding.`)
    const execution = await runCommand(state, invocation)
    appendCheckFailureEvidence(state, {
      identity: check.identity,
      remoteObservedOutput: check.observedOutput,
      attempt: 0,
      invocation,
    }, execution, 'preflight')
    if (execution.exitCode === 0 || execution.outputTruncated) {
      throw new Halt(
        'observation-failed',
        execution.exitCode === 0
          ? `The exact checked-in command did not reproduce ${check.identity}.`
          : `The exact checked-in command output for ${check.identity} was truncated.`,
      )
    }
  }
}

function appendCheckFailureEvidence(
  state: MutableRun,
  check: Readonly<{
    identity: string
    remoteObservedOutput: string
    attempt: number
    invocation: CommandInvocation
  }>,
  execution: CommandExecution,
  phase: CheckFailureEvidence['phase'],
): void {
  state.checkFailureEvidence.push(recordCheckFailureEvidence({
    sequence: state.checkFailureEvidence.length + 1,
    checkIdentity: check.identity,
    phase,
    attempt: check.attempt,
    commandId: check.invocation.id,
    commandSequence: state.commands.length,
    remoteObservedOutput: check.remoteObservedOutput,
    execution,
  }))
}

async function applyCheckRepairs(observation: MergeObservation, state: MutableRun): Promise<void> {
  for (const check of observation.checks.filter(({ outcome }) => outcome === 'fail')) {
    const plan = state.request.plan.checks[check.identity]!
    let passed = false
    for (const [index, repair] of plan.approaches.entries()) {
      const invocation = boundCheckInvocation(
        check.identity,
        `rerun-check-${state.commands.length + 1}-${index + 1}`,
        state.policy,
      )
      if (!invocation) throw new Halt('scope-gap', `Check ${check.identity} has no checked-in command binding.`)
      passed = await applyRepair(state, 'check-repair', check.identity, repair, {
        identity: check.identity,
        remoteObservedOutput: check.observedOutput,
        attempt: index + 1,
        invocation,
      })
      if (passed) break
    }
    if (!passed) {
      appendEscalation(state, check.identity, plan.approaches)
      const repeated = plan.approaches.length === 2
        && plan.approaches[0]?.approach === plan.approaches[1]?.approach
      const rootCause = [...state.checkFailureEvidence].reverse()
        .find(({ checkIdentity }) => checkIdentity === check.identity)?.diagnosedRootCause
        ?? 'No bounded local root cause was recorded.'
      throw new Halt(
        'repair_approach_exhausted',
        repeated
          ? `The repeated approach did not clear ${check.identity}. Root cause: ${rootCause}`
          : `The bounded approaches did not clear ${check.identity}. Root cause: ${rootCause}`,
      )
    }
  }
}

async function applyRepair(
  state: MutableRun,
  action: Extract<MergeAction['action'], 'comment-change' | 'check-repair' | 'conflict-resolution'>,
  subject: string,
  repair: MergeRepair,
  check: Readonly<{
    identity: string
    remoteObservedOutput: string
    attempt: number
    invocation: CommandInvocation
  }> | null,
): Promise<boolean> {
  const paths = patchPaths(repair.patch)
  if (!paths) throw new Halt('scope-gap', `Repair ${subject} has no valid bounded patch.`)
  await assertLaneIdentity(state)
  const effectivePaths = await inspectPatch(state, repair.patch, paths, subject)
  await authorizeMutation(state, repair.tokens, effectivePaths)
  const invocation: CommandInvocation = Object.freeze({
    id: `mutation-${state.mutationCount + 1}-${action}`,
    kind: 'mutation',
    executable: 'git',
    args: PATCH_COMMAND,
    stdin: repair.patch,
    timeoutMs: remainingTimeoutMs(state),
  })
  if (!actionAllowed(action, state.policy) || !commandAllowed(invocation, state.policy)) {
    throw new Halt('circuit-breaker', `Mutation ${action} is not allowlisted.`)
  }
  state.mutationCount += 1
  state.consumedTokens += repair.tokens
  const execution = await runCommand(state, invocation)
  let checkOutcome: MergeAction['checkOutcome'] = execution.exitCode === 0 ? 'not-run' : 'fail'
  if (execution.exitCode === 0) effectivePaths.forEach((path) => state.changedPaths.add(path))
  let passed = execution.exitCode === 0
  if (passed && check) {
    const checkExecution = await runCommand(state, check.invocation)
    checkOutcome = checkExecution.exitCode === 0 ? 'pass' : 'fail'
    passed = checkExecution.exitCode === 0
    if (!passed) appendCheckFailureEvidence(state, check, checkExecution, 'rerun')
  }
  state.actions.push(Object.freeze({
    sequence: state.actions.length + 1,
    actingIdentity: state.request.actingIdentity,
    lane: state.lane.lane,
    action,
    boundConsumed: boundConsumed(state),
    checkOutcome,
    subject,
    approach: repair.approach,
    changedPaths: Object.freeze([...effectivePaths]),
    commandId: invocation.id,
  }))
  if (execution.exitCode !== 0) throw new Halt('mutation-failed', `Mutation ${invocation.id} failed.`)
  if (remainingMs(state) <= 0) throw new Halt('bound-reached', 'The wall-clock bound was reached.')
  return passed
}

async function inspectPatch(
  state: MutableRun,
  patch: string,
  declaredPaths: readonly string[],
  subject: string,
): Promise<readonly string[]> {
  const sequence = state.commands.length + 1
  const inspect = await runCommand(state, Object.freeze({
    id: `patch-numstat-${sequence}`,
    kind: 'observation',
    executable: 'git',
    args: PATCH_NUMSTAT_COMMAND,
    stdin: patch,
    timeoutMs: 30_000,
  }))
  const applicability = await runCommand(state, Object.freeze({
    id: `patch-check-${sequence}`,
    kind: 'observation',
    executable: 'git',
    args: PATCH_CHECK_COMMAND,
    stdin: patch,
    timeoutMs: 30_000,
  }))
  const effectivePaths = inspect.exitCode === 0 && !inspect.outputTruncated
    ? parsePatchNumstat(inspect.stdout)
    : null
  if (!effectivePaths
    || applicability.exitCode !== 0
    || applicability.outputTruncated
    || !sameStrings(effectivePaths, declaredPaths)
    || effectivePaths.some((path) => !pathCovered(path, state.lane.declaredWriteSet))) {
    throw new Halt('circuit-breaker', `Repair ${subject} failed the no-write Git patch preflight.`)
  }
  return effectivePaths
}

async function authorizeMutation(
  state: MutableRun,
  tokens: number,
  effectivePaths: readonly string[],
): Promise<void> {
  if (state.mutationCount >= state.bounds.iterationCeiling
    || state.mutationCount >= 10
    || state.consumedTokens + tokens > state.bounds.tokenCeiling
    || remainingMs(state) <= 0) throw new Halt('bound-reached', 'A recorded merge-agent bound was reached.')
  if (await state.dependencies.circuitBreakerObserved?.()) {
    throw new Halt('circuit-breaker', 'The configured circuit-breaker signal was observed.')
  }
  let authority: LaneAuthorityObservation
  try {
    authority = await state.dependencies.readAuthority()
  } catch {
    throw new Halt('circuit-breaker', 'Lane authority could not be read before mutation.')
  }
  if (!validAuthorityObservation(authority)) {
    throw new Halt('circuit-breaker', 'Lane authority returned a malformed binding.')
  }
  state.authorityChecks.push(Object.freeze({
    ...authority,
    declaredWriteSet: Object.freeze([...authority.declaredWriteSet]),
  }))
  const checkout = await observeLocalCheckout(state)
  if (!laneAuthorityMatches(state, authority, checkout) || remainingMs(state) <= 0) {
    throw new Halt('circuit-breaker', 'Lane lease or fence is no longer current.')
  }
  for (const requiredWriteTarget of effectivePaths) {
    const request = Object.freeze({
      semanticScope: state.lane.semanticScope,
      claimId: state.lane.claimId,
      leaseEpoch: state.lane.leaseEpoch,
      fenceRevision: state.lane.fenceRevision,
      requiredWriteTarget,
      nowMs: state.nowMs(),
    })
    let admission: LaneMutationAdmission
    try {
      admission = await state.dependencies.admitMutation(request)
    } catch {
      admission = Object.freeze({ ok: false, code: 'claim_admission_unavailable' })
    }
    const admitted = admission.ok === true
    const code = admitted ? null : boundedCode('code' in admission ? admission.code : null)
    state.admissionChecks.push(Object.freeze({ request, admitted, code }))
    if (!admitted || remainingMs(state) <= 0) {
      throw new Halt('circuit-breaker', code ?? 'Authoritative claim admission refused the mutation.')
    }
  }
}

async function assertLaneIdentity(state: MutableRun): Promise<void> {
  let authority: LaneAuthorityObservation
  try {
    authority = await state.dependencies.readAuthority()
  } catch {
    throw new Halt('circuit-breaker', 'Lane authority could not be read before patch preflight.')
  }
  if (!validAuthorityObservation(authority)) {
    throw new Halt('circuit-breaker', 'Lane authority returned a malformed checkout binding.')
  }
  state.authorityChecks.push(Object.freeze({ ...authority, declaredWriteSet: Object.freeze([...authority.declaredWriteSet]) }))
  const checkout = await observeLocalCheckout(state)
  if (!laneAuthorityMatches(state, authority, checkout)) {
    throw new Halt('circuit-breaker', 'Authoritative checkout, actor, branch, or PR head binding differs from the lane.')
  }
}

function laneAuthorityMatches(
  state: MutableRun,
  authority: LaneAuthorityObservation,
  checkout: LocalCheckoutObservation,
): boolean {
  return authority.branch === state.lane.lane
    && authority.actorId === state.request.actingIdentity
    && authority.worktree === checkout.topLevel
    && authority.branch === checkout.branch
    && checkout.headRevision === state.observation?.pullRequest.headRevision
    && authority.semanticScope === state.lane.semanticScope
    && authority.claimId === state.lane.claimId
    && authority.leaseEpoch === state.lane.leaseEpoch
    && authority.fenceRevision === state.lane.fenceRevision
    && authority.leaseExpiresAtMs > state.nowMs()
    && sameStrings(authority.declaredWriteSet, state.lane.declaredWriteSet)
}

async function observeLocalCheckout(state: MutableRun) {
  const executions = new Map<string, CommandExecution>()
  for (const invocation of localCheckoutCommands()) executions.set(invocation.id, await runCommand(state, invocation))
  const checkout = parseLocalCheckout(executions)
  if (!checkout) throw new Halt('observation-failed', 'Local Git checkout identity could not be observed.')
  return checkout
}

async function runCommand(state: MutableRun, invocation: CommandInvocation): Promise<CommandExecution> {
  const availableMs = remainingMs(state)
  if (availableMs <= 0) throw new Halt('bound-reached', 'The wall-clock bound was reached before a command.')
  const boundedInvocation = Object.freeze({
    ...invocation,
    timeoutMs: Math.max(1, Math.min(invocation.timeoutMs, availableMs)),
  })
  if (!commandAllowed(boundedInvocation, state.policy)) {
    throw new Halt('circuit-breaker', `Command ${invocation.id} is not allowlisted.`)
  }
  let execution: CommandExecution
  try {
    execution = await state.dependencies.runner.run(boundedInvocation)
  } catch (error) {
    execution = Object.freeze({
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message.slice(0, 4_096) : 'command_runner_failed',
      durationMs: 0,
      outputTruncated: false,
    })
  }
  state.commands.push(recordCommandEvidence(state.commands.length + 1, boundedInvocation, execution))
  return execution
}

function initialFailure(state: MutableRun): MergeReason | null {
  if (!validMergeBounds(state.bounds)
    || !bounded(state.request.actingIdentity)
    || !bounded(state.lane.lane)
    || !bounded(state.lane.semanticScope)
    || !bounded(state.lane.claimId)
    || !Number.isSafeInteger(state.lane.leaseEpoch)
    || state.lane.leaseEpoch < 1
    || !/^[0-9a-f]{40}$/u.test(state.lane.fenceRevision)
    || !validWriteSet(state.lane.declaredWriteSet)
    || state.lane.observedFenceRevision !== state.lane.fenceRevision
    || state.lane.leaseExpiresAtMs <= state.startedAtMs) return 'circuit-breaker'
  return null
}

function appendEscalation(state: MutableRun, subject: string, approaches: readonly MergeRepair[]): void {
  state.actions.push(Object.freeze({
    sequence: state.actions.length + 1,
    actingIdentity: state.request.actingIdentity,
    lane: state.lane.lane,
    action: 'escalation',
    boundConsumed: boundConsumed(state),
    checkOutcome: 'fail',
    subject,
    approach: approaches.map(({ approach }) => approach).join(' -> '),
  }))
}

function boundConsumed(state: MutableRun): MergeAction['boundConsumed'] {
  return Object.freeze({
    iterations: state.mutationCount,
    wallClockMinutes: Math.ceil(Math.max(0, state.nowMs() - state.startedAtMs) / 60_000),
    tokens: state.consumedTokens,
  })
}

function remainingMs(state: MutableRun): number {
  return state.bounds.wallClockMinutes * 60_000 - (state.nowMs() - state.startedAtMs)
}

function remainingTimeoutMs(state: MutableRun): number {
  return Math.max(1, Math.min(30_000, remainingMs(state)))
}
