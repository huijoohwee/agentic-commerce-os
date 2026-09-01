import { createHash } from 'node:crypto'
import path from 'node:path'

import type { CommandExecution, CommandInvocation } from './runner.ts'

const COMMAND_TIMEOUT_MS = 30_000
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/u

export type GitHubTarget = Readonly<{
  repository: string
  pullRequest: number
}>

export type ReviewObservation = Readonly<{
  id: string
  path: string
  body: string
}>

export type CheckObservation = Readonly<{
  identity: string
  outcome: 'pass' | 'fail' | 'pending'
  observedOutput: string
}>

export type MergeObservation = Readonly<{
  pullRequest: Readonly<{
    number: number
    url: string
    headRevision: string
    reviewDecision: string
    mergeable: string
    mergeStateStatus: string
  }>
  reviewComments: readonly ReviewObservation[]
  checks: readonly CheckObservation[]
  conflictPaths: readonly string[]
  localCheckout: LocalCheckoutObservation
}>

export type LocalCheckoutObservation = Readonly<{
  topLevel: string
  branch: string
  headRevision: string
}>

export function observationCommands(target: GitHubTarget): readonly CommandInvocation[] {
  if (!validTarget(target)) throw new Error('merge_agent_github_target_invalid')
  return Object.freeze([
    command('github-pull-state', 'gh', [
      'pr', 'view', String(target.pullRequest), '--repo', target.repository,
      '--json', 'number,url,headRefOid,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup',
    ]),
    command('github-review-comments', 'gh', [
      'api', `repos/${target.repository}/pulls/${target.pullRequest}/comments`,
      '--method', 'GET', '--paginate', '--slurp',
    ]),
    localConflictCommand(),
    ...localCheckoutCommands(),
  ])
}

export function localConflictCommand(id = 'local-conflicts'): CommandInvocation {
  return command(id, 'git', ['diff', '--name-only', '--diff-filter=U', '--'])
}

export function parseConflictPaths(execution: CommandExecution): readonly string[] | null {
  if (execution.exitCode !== 0 || execution.outputTruncated) return null
  const paths = execution.stdout.split(/\r?\n/u).filter(Boolean)
  return paths.some((entry) => !validPath(entry)) ? null : Object.freeze([...new Set(paths)].sort())
}

export function localCheckoutCommands(): readonly CommandInvocation[] {
  return Object.freeze([
    command('local-top-level', 'git', ['rev-parse', '--show-toplevel']),
    command('local-branch', 'git', ['branch', '--show-current']),
    command('local-head', 'git', ['rev-parse', 'HEAD']),
  ])
}

export function parseMergeObservation(executions: ReadonlyMap<string, CommandExecution>): MergeObservation | null {
  const pullExecution = executions.get('github-pull-state')
  const commentsExecution = executions.get('github-review-comments')
  const conflictsExecution = executions.get('local-conflicts')
  const localCheckout = parseLocalCheckout(executions)
  if (!pullExecution || !commentsExecution || !conflictsExecution
    || !localCheckout
    || [pullExecution, commentsExecution, conflictsExecution].some(({ exitCode, outputTruncated }) => (
      exitCode !== 0 || outputTruncated
    ))) return null

  const pull = parseRecord(pullExecution.stdout)
  const comments = parseJson(commentsExecution.stdout)
  if (!pull
    || !Number.isSafeInteger(pull.number)
    || typeof pull.url !== 'string'
    || !/^https:\/\/github\.com\//u.test(pull.url)
    || typeof pull.headRefOid !== 'string'
    || !/^[0-9a-f]{40}$/u.test(pull.headRefOid)
    || typeof pull.reviewDecision !== 'string'
    || typeof pull.mergeable !== 'string'
    || typeof pull.mergeStateStatus !== 'string'
    || !Array.isArray(pull.statusCheckRollup)
    || !Array.isArray(comments)) return null

  const reviewComments = flattenPages(comments).map(readReviewComment)
  const checks = pull.statusCheckRollup.map(readCheck)
  const conflictPaths = parseConflictPaths(conflictsExecution)
  if (reviewComments.some((entry) => entry === null)
    || checks.some((entry) => entry === null)
    || !conflictPaths) return null
  const uniqueCommentIds = new Set((reviewComments as ReviewObservation[]).map(({ id }) => id))
  const uniqueCheckIds = new Set((checks as CheckObservation[]).map(({ identity }) => identity))
  if (uniqueCommentIds.size !== reviewComments.length || uniqueCheckIds.size !== checks.length) return null

  return Object.freeze({
    pullRequest: Object.freeze({
      number: Number(pull.number),
      url: pull.url,
      headRevision: pull.headRefOid,
      reviewDecision: pull.reviewDecision,
      mergeable: pull.mergeable,
      mergeStateStatus: pull.mergeStateStatus,
    }),
    reviewComments: Object.freeze((reviewComments as ReviewObservation[]).sort(compareId)),
    checks: Object.freeze((checks as CheckObservation[]).sort(compareId)),
    conflictPaths,
    localCheckout,
  })
}

export function parseLocalCheckout(
  executions: ReadonlyMap<string, CommandExecution>,
): LocalCheckoutObservation | null {
  const topLevelExecution = executions.get('local-top-level')
  const branchExecution = executions.get('local-branch')
  const headExecution = executions.get('local-head')
  if (!topLevelExecution || !branchExecution || !headExecution
    || [topLevelExecution, branchExecution, headExecution].some(({ exitCode, outputTruncated }) => (
      exitCode !== 0 || outputTruncated
    ))) return null
  const topLevel = topLevelExecution.stdout.trim()
  const branch = branchExecution.stdout.trim()
  const headRevision = headExecution.stdout.trim()
  if (!path.isAbsolute(topLevel)
    || topLevel.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(topLevel)
    || !validBranch(branch)
    || !/^[0-9a-f]{40}$/u.test(headRevision)) return null
  return Object.freeze({ topLevel, branch, headRevision })
}

export function publicObservation(observation: MergeObservation) {
  return Object.freeze({
    pullRequest: observation.pullRequest,
    reviewComments: Object.freeze(observation.reviewComments.map(({ id, path, body }) => Object.freeze({
      id,
      path,
      bodyDigest: createHash('sha256').update(body).digest('hex'),
    }))),
    checks: observation.checks,
    conflictPaths: observation.conflictPaths,
    localCheckout: Object.freeze({
      topLevelDigest: createHash('sha256').update(observation.localCheckout.topLevel).digest('hex'),
      branch: observation.localCheckout.branch,
      headRevision: observation.localCheckout.headRevision,
    }),
  })
}

function command(id: string, executable: string, args: readonly string[]): CommandInvocation {
  return Object.freeze({ id, kind: 'observation', executable, args: Object.freeze([...args]), timeoutMs: COMMAND_TIMEOUT_MS })
}

function readReviewComment(value: unknown): ReviewObservation | null {
  if (!isRecord(value)
    || (typeof value.id !== 'number' && typeof value.id !== 'string')
    || typeof value.path !== 'string'
    || !validPath(value.path)
    || typeof value.body !== 'string'
    || value.body.length > 65_536) return null
  return Object.freeze({ id: String(value.id), path: value.path, body: value.body })
}

function readCheck(value: unknown): CheckObservation | null {
  if (!isRecord(value)) return null
  const identity = typeof value.name === 'string'
    ? value.name
    : typeof value.context === 'string' ? value.context : ''
  if (!identity || identity.length > 256) return null
  const state = String(value.conclusion ?? value.state ?? value.status ?? '').toUpperCase()
  const outcome: CheckObservation['outcome'] = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)
    ? 'pass'
    : ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(state)
      ? 'pending'
      : 'fail'
  return Object.freeze({ identity, outcome, observedOutput: state || 'UNKNOWN' })
}

function flattenPages(value: readonly unknown[]): readonly unknown[] {
  return value.every(Array.isArray) ? value.flatMap((page) => page as unknown[]) : value
}

function validTarget(target: GitHubTarget): boolean {
  return REPOSITORY_PATTERN.test(target.repository)
    && Number.isSafeInteger(target.pullRequest)
    && target.pullRequest > 0
}

export function validPath(path: string): boolean {
  return path === path.trim()
    && path.length > 0
    && path.length <= 1_024
    && !path.startsWith('/')
    && !path.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && !path.split('/').some((part) => part === '..' || part === '' || part === '.')
}

function compareId(left: { id?: string; identity?: string }, right: { id?: string; identity?: string }): number {
  return (left.id ?? left.identity ?? '').localeCompare(right.id ?? right.identity ?? '', 'en')
}

function validBranch(value: string): boolean {
  return value === value.trim()
    && value.length > 0
    && value.length <= 512
    && !value.startsWith('-')
    && !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(value)
    && !value.includes('..')
    && !value.endsWith('.')
    && !value.endsWith('/')
}

function parseRecord(value: string): Record<string, unknown> | null {
  const parsed = parseJson(value)
  return isRecord(parsed) ? parsed : null
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
