export type MergeReason =
  | 'requires-operator-decision'
  | 'out-of-write-set'
  | 'scope-gap'
  | 'repair_approach_exhausted'
  | 'bound-reached'
  | 'circuit-breaker'
  | 'observation-failed'
  | 'mutation-failed'
  | 'checks-pending'

export type MergeBounds = Readonly<{
  tokenCeiling: number
  iterationCeiling: number
  wallClockMinutes: number
  circuitBreaker: string
}>

export type LaneBinding = Readonly<{
  lane: string
  claimId: string
  leaseEpoch: number
  leaseExpiresAtMs: number
  fenceRevision: string
  observedFenceRevision: string
  declaredWriteSet: readonly string[]
}>

export type MergeAction = Readonly<{
  sequence: number
  actingIdentity: string
  lane: string
  action: 'comment-change' | 'check-repair' | 'conflict-resolution' | 'escalation'
  boundConsumed: Readonly<{ iterations: number; wallClockMinutes: number; tokens: number }>
  checkOutcome: 'pass' | 'fail' | 'not-run'
  subject?: string
  approach?: string
  changedPaths?: readonly string[]
  commandId?: string
}>
