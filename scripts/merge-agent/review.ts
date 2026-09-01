import type { MergeReason } from './types.ts'

export type ReviewComment = Readonly<{
  id: string
  path: string
  requestedBehavior: string
  withinRequirements: boolean
  withinWriteSet: boolean
  requiresOperatorDecision: boolean
}>

export type ReviewOutcome = Readonly<{
  commentId: string
  change: Readonly<{ path: string; requestedBehavior: string }> | null
  reason: Extract<MergeReason, 'requires-operator-decision' | 'out-of-write-set' | 'scope-gap'> | null
}>

export function handleReviewComment(
  comment: ReviewComment,
  alreadyChangedCommentIds: ReadonlySet<string>,
): ReviewOutcome {
  if (!bounded(comment.id) || !bounded(comment.path) || !bounded(comment.requestedBehavior)) {
    return refusal(comment.id, 'scope-gap')
  }
  if (alreadyChangedCommentIds.has(comment.id)) return refusal(comment.id, 'scope-gap')
  if (!comment.withinRequirements) return refusal(comment.id, 'scope-gap')
  if (!comment.withinWriteSet) return refusal(comment.id, 'out-of-write-set')
  if (comment.requiresOperatorDecision) return refusal(comment.id, 'requires-operator-decision')
  return Object.freeze({
    commentId: comment.id,
    change: Object.freeze({ path: comment.path, requestedBehavior: comment.requestedBehavior }),
    reason: null,
  })
}

function refusal(commentId: string, reason: NonNullable<ReviewOutcome['reason']>): ReviewOutcome {
  return Object.freeze({ commentId, change: null, reason })
}

function bounded(value: string): boolean {
  return value === value.trim() && value.length > 0 && value.length <= 1_024
}
