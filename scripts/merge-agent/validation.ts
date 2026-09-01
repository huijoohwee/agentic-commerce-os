import path from 'node:path'

import type { LaneAuthorityObservation } from './evidence.ts'

export function bounded(value: string): boolean {
  return value === value.trim() && value.length > 0 && value.length <= 1_024
}

export function boundedCode(value: unknown): string {
  return typeof value === 'string' && bounded(value) ? value : 'claim_admission_refused'
}

export function validWriteSet(writeSet: readonly string[]): boolean {
  return writeSet.length > 0
    && writeSet.length <= 1_000
    && new Set(writeSet).size === writeSet.length
    && writeSet.every((entry) => {
      const path = entry.endsWith('/') ? entry.slice(0, -1) : entry
      return bounded(path)
        && !path.startsWith('/')
        && !path.includes('\\')
        && !/[\u0000-\u001f\u007f]/u.test(path)
        && !path.split('/').some((part) => part === '' || part === '.' || part === '..')
    })
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

export function validAuthorityObservation(authority: LaneAuthorityObservation): boolean {
  return Boolean(authority)
    && typeof authority === 'object'
    && bounded(authority.semanticScope)
    && bounded(authority.claimId)
    && bounded(authority.actorId)
    && bounded(authority.branch)
    && authority.worktree === authority.worktree.trim()
    && authority.worktree.length <= 1_024
    && path.isAbsolute(authority.worktree)
    && !authority.worktree.includes('\0')
    && Number.isSafeInteger(authority.leaseEpoch)
    && authority.leaseEpoch > 0
    && Number.isSafeInteger(authority.leaseExpiresAtMs)
    && /^[0-9a-f]{40}$/u.test(authority.fenceRevision)
    && Array.isArray(authority.declaredWriteSet)
    && validWriteSet(authority.declaredWriteSet)
}
