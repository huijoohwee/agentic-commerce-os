import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson } from '../evidence-integrity.ts'

export const PRODUCTION_HUMAN_AUTHORIZATION_SCHEMA = 'agentic-commerce-production-human-authorization/v1'

const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u
const MAXIMUM_JSON_BYTES = 1_048_576

type JsonObject = Record<string, unknown>
type ReleaseMode = 'bootstrap' | 'steady-state' | 'recovery'

export type ProductionHumanAuthorization = Readonly<{
  schema: typeof PRODUCTION_HUMAN_AUTHORIZATION_SCHEMA
  decision: 'approved'
  environment: 'production'
  releaseMode: ReleaseMode
  candidateSha: string
  runId: number
  runAttempt: number
  approver: Readonly<{ login: string; id: number; type: 'User' }>
  observedAt: string
  source: 'github-actions-run-approval-history'
}>

export function parseHumanAuthorizationReceipt(
  value: unknown,
  expected: Readonly<{
    candidateSha: string
    releaseMode?: ReleaseMode
    runId?: number
    runAttempt?: number
  }>,
): ProductionHumanAuthorization {
  const receipt = object(value, 'receipt_invalid')
  exactKeys(receipt, [
    'approver', 'candidateSha', 'decision', 'environment', 'observedAt', 'releaseMode',
    'runAttempt', 'runId', 'schema', 'source',
  ], 'receipt_shape_invalid')
  exact(receipt.schema === PRODUCTION_HUMAN_AUTHORIZATION_SCHEMA && receipt.decision === 'approved'
    && receipt.environment === 'production' && receipt.source === 'github-actions-run-approval-history',
  'receipt_contract_invalid')
  exact(['bootstrap', 'steady-state', 'recovery'].includes(String(receipt.releaseMode)), 'receipt_mode_invalid')
  exact(receipt.releaseMode === (expected.releaseMode ?? receipt.releaseMode), 'receipt_mode_mismatch')
  exact(receipt.candidateSha === expected.candidateSha && SHA1_PATTERN.test(expected.candidateSha),
    'receipt_candidate_mismatch')
  const runId = Number(receipt.runId)
  const runAttempt = Number(receipt.runAttempt)
  exact(Number.isSafeInteger(runId) && runId > 0 && (expected.runId === undefined || runId === expected.runId),
    'receipt_run_id_invalid')
  exact(runAttempt === 1
    && (expected.runAttempt === undefined || runAttempt === expected.runAttempt), 'receipt_run_attempt_invalid')
  const approver = object(receipt.approver, 'receipt_approver_invalid')
  exactKeys(approver, ['id', 'login', 'type'], 'receipt_approver_shape_invalid')
  exact(approver.type === 'User' && typeof approver.login === 'string' && LOGIN_PATTERN.test(approver.login)
    && !approver.login.toLowerCase().endsWith('[bot]'), 'receipt_approver_not_human')
  exact(Number.isSafeInteger(approver.id) && Number(approver.id) > 0, 'receipt_approver_id_invalid')
  exact(typeof receipt.observedAt === 'string', 'receipt_observation_time_invalid')
  const observedAt = Date.parse(receipt.observedAt)
  exact(Number.isFinite(observedAt) && new Date(observedAt).toISOString() === receipt.observedAt,
    'receipt_observation_time_invalid')
  return Object.freeze({
    schema: PRODUCTION_HUMAN_AUTHORIZATION_SCHEMA,
    decision: 'approved',
    environment: 'production',
    releaseMode: receipt.releaseMode as ReleaseMode,
    candidateSha: receipt.candidateSha,
    runId,
    runAttempt,
    approver: Object.freeze({ login: approver.login, id: Number(approver.id), type: 'User' }),
    observedAt: receipt.observedAt,
    source: 'github-actions-run-approval-history',
  })
}

export function validateHumanAuthorization(
  reviewsValue: unknown,
  environmentValue: unknown,
  input: Readonly<{
    releaseMode: ReleaseMode
    candidateSha: string
    runId: number
    runAttempt: number
    observedAt?: Date
  }>,
): ProductionHumanAuthorization {
  exact(SHA1_PATTERN.test(input.candidateSha), 'candidate_sha_invalid')
  exact(Number.isSafeInteger(input.runId) && input.runId > 0, 'run_id_invalid')
  // GitHub's run-approval history has neither an approval timestamp nor an attempt number.
  // A rerun therefore cannot be safely bound to the prior approval.
  exact(input.runAttempt === 1, 'run_attempt_not_authorizable')
  const observedAt = input.observedAt ?? new Date()
  exact(Number.isFinite(observedAt.getTime()), 'observation_time_invalid')
  const configuredReviewerIds = validateProductionEnvironment(environmentValue)
  const matches = array(reviewsValue, 'review_history_invalid').map((entry) => object(entry,
    'review_invalid')).filter((review) => review.state === 'approved'
      && array(review.environments, 'review_environments_invalid').some((entry) => object(entry,
        'review_environment_invalid').name === 'production'))
  exact(matches.length === 1, 'production_approval_cardinality_invalid')
  const reviewer = object(matches[0]?.user, 'approver_invalid')
  exact(reviewer.type === 'User', 'approver_not_human_user')
  exact(typeof reviewer.login === 'string' && LOGIN_PATTERN.test(reviewer.login)
    && !reviewer.login.toLowerCase().endsWith('[bot]'), 'approver_login_invalid')
  exact(Number.isSafeInteger(reviewer.id) && Number(reviewer.id) > 0, 'approver_id_invalid')
  exact(configuredReviewerIds.has(Number(reviewer.id)), 'approver_not_configured_reviewer')
  return Object.freeze({
    schema: PRODUCTION_HUMAN_AUTHORIZATION_SCHEMA,
    decision: 'approved',
    environment: 'production',
    releaseMode: input.releaseMode,
    candidateSha: input.candidateSha,
    runId: input.runId,
    runAttempt: input.runAttempt,
    approver: Object.freeze({ login: reviewer.login, id: Number(reviewer.id), type: 'User' }),
    observedAt: observedAt.toISOString(),
    source: 'github-actions-run-approval-history',
  })
}

export function validateProductionEnvironment(value: unknown): ReadonlySet<number> {
  const environment = object(value, 'production_environment_invalid')
  exact(environment.name === 'production', 'production_environment_name_invalid')
  const reviewerRules = array(environment.protection_rules, 'production_protection_rules_invalid')
    .map((entry) => object(entry, 'production_protection_rule_invalid'))
    .filter((rule) => rule.type === 'required_reviewers')
  exact(reviewerRules.length === 1, 'required_reviewer_rule_missing')
  const rule = reviewerRules[0] as JsonObject
  const reviewers = array(rule.reviewers, 'required_reviewers_invalid')
  exact(reviewers.length > 0, 'required_reviewers_empty')
  exact(rule.prevent_self_review === true, 'self_review_not_prevented')
  const configuredUserIds = new Set<number>()
  for (const entryValue of reviewers) {
    const entry = object(entryValue, 'required_reviewer_invalid')
    if (entry.type !== 'User') continue
    const reviewer = object(entry.reviewer, 'required_reviewer_user_invalid')
    exact(Number.isSafeInteger(reviewer.id) && Number(reviewer.id) > 0, 'required_reviewer_user_invalid')
    configuredUserIds.add(Number(reviewer.id))
  }
  exact(configuredUserIds.size > 0, 'required_reviewer_user_missing')
  return configuredUserIds
}

function readJson(filePath: string): unknown {
  const descriptor = fs.openSync(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    exact(stat.isFile() && stat.size > 0 && stat.size <= MAXIMUM_JSON_BYTES, 'review_file_size_invalid')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor))) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

function object(value: unknown, code: string): JsonObject {
  exact(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as JsonObject
}

function array(value: unknown, code: string): unknown[] {
  exact(Array.isArray(value), code)
  return value
}

function exactKeys(value: JsonObject, expected: readonly string[], code: string): void {
  exact(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), code)
}

function exact(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_human_authorization:${code}`)
}

async function fetchGitHubJson(endpoint: string, token: string): Promise<unknown> {
  exact(token === token.trim() && token.length >= 16 && token.length <= 4096, 'github_token_invalid')
  const response = await fetch(new Request(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2026-03-10',
    },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }))
  exact(response.status === 200 && !response.redirected && response.url === endpoint,
    'github_response_identity_invalid')
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  exact(/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType), 'github_content_type_invalid')
  exact(response.body !== null, 'github_body_missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      exact(length <= MAXIMUM_JSON_BYTES, 'github_body_too_large')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

function writeReceipt(outputPath: string, receipt: ProductionHumanAuthorization): void {
  fs.writeFileSync(path.resolve(outputPath), `${canonicalJson(receipt)}\n`, { encoding: 'utf8', flag: 'wx' })
}

async function main(): Promise<void> {
  const [command, reviewPath, environmentPath, mode, candidateSha, runId, runAttempt, outputPath,
    ...extra] = process.argv.slice(2)
  if (command === 'fetch') {
    const [releaseMode, fetchCandidate, fetchRunId, fetchRunAttempt, fetchOutput, ...fetchExtra] = process.argv.slice(3)
    exact(fetchExtra.length === 0 && ['bootstrap', 'steady-state', 'recovery'].includes(String(releaseMode))
      && Boolean(fetchCandidate && fetchRunId && fetchRunAttempt && fetchOutput), 'fetch_arguments_invalid')
    const repository = process.env.GITHUB_REPOSITORY ?? ''
    const apiOrigin = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    const token = process.env.GH_TOKEN ?? ''
    exact(REPOSITORY_PATTERN.test(repository) && apiOrigin === 'https://api.github.com', 'github_origin_invalid')
    const [reviews, environment] = await Promise.all([
      fetchGitHubJson(`${apiOrigin}/repos/${repository}/actions/runs/${fetchRunId}/approvals`, token),
      fetchGitHubJson(`${apiOrigin}/repos/${repository}/environments/production`, token),
    ])
    writeReceipt(fetchOutput as string, validateHumanAuthorization(reviews, environment, {
      releaseMode: releaseMode as ReleaseMode,
      candidateSha: fetchCandidate as string,
      runId: Number(fetchRunId),
      runAttempt: Number(fetchRunAttempt),
    }))
    return
  }
  if (command === 'receipt') {
    const [receiptPath, receiptCandidate, receiptRunId, receiptRunAttempt, ...receiptExtra] = process.argv.slice(3)
    exact(receiptExtra.length === 0 && Boolean(receiptPath && receiptCandidate && receiptRunId && receiptRunAttempt),
      'receipt_arguments_invalid')
    const receipt = parseHumanAuthorizationReceipt(readJson(receiptPath as string), {
      candidateSha: receiptCandidate as string,
      runId: Number(receiptRunId),
      runAttempt: Number(receiptRunAttempt),
    })
    process.stdout.write(`${canonicalJson(receipt)}\n`)
    return
  }
  if (command !== 'verify' || extra.length > 0 || !reviewPath || !environmentPath || !candidateSha
    || !runId || !runAttempt || !outputPath
    || !['bootstrap', 'steady-state', 'recovery'].includes(String(mode))) {
    throw new Error('usage: human-authorization.ts verify <reviews> <environment> <mode> <candidate> <run-id> <attempt> <output>')
  }
  const receipt = validateHumanAuthorization(readJson(reviewPath), readJson(environmentPath), {
    releaseMode: mode as ReleaseMode,
    candidateSha,
    runId: Number(runId),
    runAttempt: Number(runAttempt),
  })
  writeReceipt(outputPath, receipt)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_human_authorization:unknown_error'}\n`)
    process.exitCode = 1
  })
}
