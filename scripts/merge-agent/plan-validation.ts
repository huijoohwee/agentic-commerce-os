import { pathCovered } from './conflict.ts'
import type { MergeOrchestrationPlan, MergeRepair } from './orchestrator.ts'
import { patchPaths } from './patch.ts'
import {
  boundCheckInvocation,
  checkPlanMatches,
  commandAllowed,
  type MergeCommandPolicy,
} from './policy.ts'
import type { MergeObservation } from './observation.ts'
import type { MergeReason } from './types.ts'
import { bounded } from './validation.ts'

const MAXIMUM_REPAIR_ATTEMPTS = 2

export type PlanFailure = Readonly<{ reason: MergeReason; detail: string }>

export function validateMergePlan(input: Readonly<{
  observation: MergeObservation
  plan: MergeOrchestrationPlan
  declaredWriteSet: readonly string[]
  policy: MergeCommandPolicy
  commandCount: number
}>): PlanFailure | null {
  const { observation, plan, declaredWriteSet, policy } = input
  if (observation.checks.some(({ outcome }) => outcome === 'pending')) {
    return failure('checks-pending', 'At least one required check is still pending.')
  }
  if (observation.pullRequest.mergeable === 'CONFLICTING' && observation.conflictPaths.length === 0) {
    return failure('scope-gap', 'Remote conflicts exist without a local conflict projection.')
  }
  if (observation.pullRequest.reviewDecision === 'CHANGES_REQUESTED' && observation.reviewComments.length === 0) {
    return failure('scope-gap', 'A requested review change has no bounded comment projection.')
  }
  for (const conflictPath of observation.conflictPaths) {
    if (!pathCovered(conflictPath, declaredWriteSet)) {
      return failure('out-of-write-set', `Conflict path ${conflictPath} is outside the lane.`)
    }
    const invalid = repairFailure(plan.conflicts[conflictPath], declaredWriteSet, conflictPath)
    if (invalid) return invalid
  }
  for (const comment of observation.reviewComments) {
    const commentPlan = plan.reviewComments[comment.id]
    if (!commentPlan || !commentPlan.withinRequirements) {
      return failure('scope-gap', `Review comment ${comment.id} lacks specified behavior.`)
    }
    if (commentPlan.requiresOperatorDecision) {
      return failure('requires-operator-decision', `Review comment ${comment.id} requires an operator decision.`)
    }
    if (!pathCovered(comment.path, declaredWriteSet)) {
      return failure('out-of-write-set', `Review path ${comment.path} is outside the lane.`)
    }
    const invalid = repairFailure(commentPlan.repair, declaredWriteSet, comment.path)
    if (invalid) return invalid
  }
  for (const check of observation.checks.filter(({ outcome }) => outcome === 'fail')) {
    const checkPlan = plan.checks[check.identity]
    if (!checkPlan || checkPlan.approaches.length < 1 || checkPlan.approaches.length > MAXIMUM_REPAIR_ATTEMPTS) {
      return failure('scope-gap', `Check ${check.identity} lacks a bounded repair plan.`)
    }
    const invocation = boundCheckInvocation(check.identity, `preflight-check-${input.commandCount + 1}`, policy)
    if (!invocation || !commandAllowed(invocation, policy)) {
      return failure('scope-gap', `Check ${check.identity} has no checked-in command binding.`)
    }
    if (!checkPlanMatches(check.identity, checkPlan.script, checkPlan.args ?? [], policy)) {
      return failure('circuit-breaker', `Check plan for ${check.identity} differs from its checked-in command binding.`)
    }
    for (const repair of checkPlan.approaches) {
      const invalid = repairFailure(repair, declaredWriteSet)
      if (invalid) return invalid
    }
  }
  return null
}

function repairFailure(
  repair: MergeRepair | undefined,
  declaredWriteSet: readonly string[],
  requiredPath?: string,
): PlanFailure | null {
  const paths = repair ? patchPaths(repair.patch) : null
  if (!repair || !bounded(repair.approach) || !Number.isSafeInteger(repair.tokens) || repair.tokens < 1 || !paths) {
    return failure('scope-gap', 'A repair plan is absent or malformed.')
  }
  if ((requiredPath && !paths.includes(requiredPath))
    || paths.some((path) => !pathCovered(path, declaredWriteSet))) {
    return failure('out-of-write-set', 'A repair patch reaches outside its declared path.')
  }
  return null
}

function failure(reason: MergeReason, detail: string): PlanFailure {
  return Object.freeze({ reason, detail })
}
