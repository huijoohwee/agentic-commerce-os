import type {
  MergeOrchestrationLaneBinding,
  MergeOrchestrationPlan,
  MergeOrchestrationRequest,
  MergeRepair,
} from './orchestrator.ts'
import { validWriteSet } from './validation.ts'

const RUNTIME_SCHEMA = 'agentic-commerce-merge-agent-runtime/v1'
const MAXIMUM_PLAN_ENTRIES = 1_000

export type MergeAgentRuntimeInput = Readonly<{
  schema: typeof RUNTIME_SCHEMA
  lane: MergeOrchestrationLaneBinding
  request: MergeOrchestrationRequest
}>

export function readMergeAgentRuntimeInput(value: unknown): MergeAgentRuntimeInput | null {
  if (!exactRecord(value, ['schema', 'lane', 'request']) || value.schema !== RUNTIME_SCHEMA) return null
  const lane = readLane(value.lane)
  const request = readRequest(value.request)
  return lane && request ? Object.freeze({ schema: RUNTIME_SCHEMA, lane, request }) : null
}

function readLane(value: unknown): MergeOrchestrationLaneBinding | null {
  if (!exactRecord(value, [
    'lane', 'semanticScope', 'claimId', 'leaseEpoch', 'leaseExpiresAtMs',
    'fenceRevision', 'observedFenceRevision', 'declaredWriteSet',
  ])
    || !bounded(value.lane)
    || !bounded(value.semanticScope)
    || !bounded(value.claimId)
    || !positiveInteger(value.leaseEpoch)
    || !positiveInteger(value.leaseExpiresAtMs)
    || !revision(value.fenceRevision)
    || !revision(value.observedFenceRevision)
    || !Array.isArray(value.declaredWriteSet)
    || !value.declaredWriteSet.every((entry) => typeof entry === 'string')
    || !validWriteSet(value.declaredWriteSet)) return null
  return Object.freeze({
    lane: value.lane,
    semanticScope: value.semanticScope,
    claimId: value.claimId,
    leaseEpoch: value.leaseEpoch,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
    fenceRevision: value.fenceRevision,
    observedFenceRevision: value.observedFenceRevision,
    declaredWriteSet: Object.freeze([...value.declaredWriteSet]),
  })
}

function readRequest(value: unknown): MergeOrchestrationRequest | null {
  if (!exactRecord(value, ['actingIdentity', 'target', 'plan']) || !bounded(value.actingIdentity)) return null
  const target = readTarget(value.target)
  const plan = readPlan(value.plan)
  return target && plan ? Object.freeze({ actingIdentity: value.actingIdentity, target, plan }) : null
}

function readTarget(value: unknown): MergeOrchestrationRequest['target'] | null {
  if (!exactRecord(value, ['repository', 'pullRequest'])
    || typeof value.repository !== 'string'
    || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(value.repository)
    || !positiveInteger(value.pullRequest)) return null
  return Object.freeze({ repository: value.repository, pullRequest: value.pullRequest })
}

function readPlan(value: unknown): MergeOrchestrationPlan | null {
  if (!exactRecord(value, ['reviewComments', 'checks', 'conflicts'])
    || !record(value.reviewComments)
    || !record(value.checks)
    || !record(value.conflicts)
    || [value.reviewComments, value.checks, value.conflicts]
      .some((entries) => Object.keys(entries).length > MAXIMUM_PLAN_ENTRIES)) return null
  const reviewComments = readEntries(value.reviewComments, readReviewPlan)
  const checks = readEntries(value.checks, readCheckPlan)
  const conflicts = readEntries(value.conflicts, readRepair)
  return reviewComments && checks && conflicts
    ? Object.freeze({ reviewComments, checks, conflicts })
    : null
}

function readReviewPlan(value: unknown): MergeOrchestrationPlan['reviewComments'][string] | null {
  if (!exactRecord(value, ['withinRequirements', 'requiresOperatorDecision', 'repair'])
    || typeof value.withinRequirements !== 'boolean'
    || typeof value.requiresOperatorDecision !== 'boolean') return null
  const repair = readRepair(value.repair)
  return repair ? Object.freeze({
    withinRequirements: value.withinRequirements,
    requiresOperatorDecision: value.requiresOperatorDecision,
    repair,
  }) : null
}

function readCheckPlan(value: unknown): MergeOrchestrationPlan['checks'][string] | null {
  if (!record(value)
    || !['args', 'approaches', 'script'].every((field) => field in value || field === 'args')
    || Object.keys(value).some((field) => !['args', 'approaches', 'script'].includes(field))
    || !bounded(value.script)
    || (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(bounded)))
    || !Array.isArray(value.approaches)
    || value.approaches.length < 1
    || value.approaches.length > 2) return null
  const approaches = value.approaches.map(readRepair)
  if (approaches.some((entry) => entry === null)) return null
  return Object.freeze({
    script: value.script,
    ...(value.args === undefined ? {} : { args: Object.freeze([...value.args]) }),
    approaches: Object.freeze(approaches as MergeRepair[]),
  })
}

function readRepair(value: unknown): MergeRepair | null {
  if (!exactRecord(value, ['approach', 'patch', 'tokens'])
    || !bounded(value.approach)
    || typeof value.patch !== 'string'
    || value.patch.length < 1
    || value.patch.length > 1_000_000
    || !positiveInteger(value.tokens)) return null
  return Object.freeze({ approach: value.approach, patch: value.patch, tokens: value.tokens })
}

function readEntries<T>(
  value: Record<string, unknown>,
  read: (entry: unknown) => T | null,
): Readonly<Record<string, T>> | null {
  const entries: Array<readonly [string, T]> = []
  for (const [key, entry] of Object.entries(value)) {
    if (!bounded(key)) return null
    const parsed = read(entry)
    if (!parsed) return null
    entries.push(Object.freeze([key, parsed]))
  }
  return Object.freeze(Object.fromEntries(entries))
}

function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((field) => fields.includes(field))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bounded(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function revision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
}
