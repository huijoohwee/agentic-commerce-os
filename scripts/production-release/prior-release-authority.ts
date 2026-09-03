import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { canonicalJson, sha256 } from '../evidence-integrity.ts'
import {
  evidenceDigest,
  parseDeploymentReceipt,
  parsePreserveRequiredReceipt,
  type DeploymentReceipt,
  type PreserveRequiredReceipt,
} from './controller-receipts.ts'
import { readBoundedJsonResponse, readBoundedResponseBytes } from './bounded-response.ts'
import { parseHumanAuthorizationReceipt } from './human-authorization.ts'

export const PRIOR_RELEASE_AUTHORITY_SCHEMA =
  'agentic-commerce-prior-release-artifact-authority/v1' as const
export const PRIOR_RELEASE_AUTHORITY_PROOF_SCHEMA =
  'agentic-commerce-prior-release-artifact-proof/v1' as const
export const RECOVERY_RELEASE_AUTHORITY_SCHEMA =
  'agentic-commerce-recovery-release-artifact-authority/v1' as const
export const RECOVERY_RELEASE_AUTHORITY_PROOF_SCHEMA =
  'agentic-commerce-recovery-release-artifact-proof/v1' as const

export type PriorReleaseAuthority = Readonly<{
  schema: typeof PRIOR_RELEASE_AUTHORITY_SCHEMA
  repository: string
  workflowRunId: number
  artifactId: number
  artifactName: string
  artifactDigest: string
}>

export type PriorReleaseAuthorityProof = Readonly<{
  schema: typeof PRIOR_RELEASE_AUTHORITY_PROOF_SCHEMA
  repository: string
  workflowRunId: number
  workflowRunAttempt: 1
  workflowHeadSha: string
  artifactId: number
  artifactName: string
  artifactDigest: string
  receiptDigest: string
}>

export type RecoveryReleaseAuthority = Readonly<{
  schema: typeof RECOVERY_RELEASE_AUTHORITY_SCHEMA
  repository: string
  workflowRunId: number
  artifactId: number
  artifactName: string
  artifactDigest: string
}>

export type RecoveryReleaseAuthorityProof = Readonly<{
  schema: typeof RECOVERY_RELEASE_AUTHORITY_PROOF_SCHEMA
  repository: string
  workflowRunId: number
  workflowRunAttempt: 1
  workflowHeadSha: string
  artifactId: number
  artifactName: string
  artifactDigest: string
  receiptDigest: string
  humanAuthorizationDigest: string
}>

export async function fetchAuthenticatedPriorReceipt(input: Readonly<{
  authority: PriorReleaseAuthority
  repository: string
  token: string
}>): Promise<Readonly<{ receipt: DeploymentReceipt; proof: PriorReleaseAuthorityProof }>> {
  requirePrior(input.authority.repository === input.repository, 'repository_mismatch')
  const artifact = record(await githubJson(
    `https://api.github.com/repos/${input.repository}/actions/artifacts/${input.authority.artifactId}`,
    input.token,
  ), 'artifact_metadata_invalid')
  const workflow = record(artifact.workflow_run, 'artifact_workflow_run_missing')
  requirePrior(artifact.id === input.authority.artifactId
    && artifact.name === input.authority.artifactName
    && artifact.expired === false
    && artifact.digest === `sha256:${input.authority.artifactDigest}`
    && workflow.id === input.authority.workflowRunId
    && typeof artifact.archive_download_url === 'string', 'artifact_identity_invalid')
  const run = record(await githubJson(
    `https://api.github.com/repos/${input.repository}/actions/runs/${input.authority.workflowRunId}`,
    input.token,
  ), 'workflow_run_invalid')
  requirePrior(run.id === input.authority.workflowRunId
    && run.run_attempt === 1
    && run.event === 'workflow_dispatch'
    && run.status === 'completed'
    && run.conclusion === 'success'
    && run.head_branch === 'main'
    && run.path === '.github/workflows/production-release.yml'
    && typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/u.test(run.head_sha),
  'workflow_run_not_authoritative')
  const archive = await githubBytes(artifact.archive_download_url, input.token)
  requirePrior(sha256(archive) === input.authority.artifactDigest, 'artifact_archive_digest_mismatch')
  const receipt = parseDeploymentReceipt(extractReceipt(archive))
  requirePrior(receipt.candidateSha === run.head_sha
    && input.authority.artifactName === `production-release-${receipt.releaseMode}-${receipt.candidateSha}`,
  'artifact_receipt_provenance_mismatch')
  return Object.freeze({
    receipt,
    proof: Object.freeze({
      schema: PRIOR_RELEASE_AUTHORITY_PROOF_SCHEMA,
      repository: input.repository,
      workflowRunId: input.authority.workflowRunId,
      workflowRunAttempt: 1,
      workflowHeadSha: run.head_sha,
      artifactId: input.authority.artifactId,
      artifactName: input.authority.artifactName,
      artifactDigest: input.authority.artifactDigest,
      receiptDigest: sha256(canonicalJson(receipt)),
    }),
  })
}

export function parsePriorReleaseAuthority(value: unknown): PriorReleaseAuthority {
  const authority = record(value, 'authority_invalid')
  exactKeys(authority, [
    'artifactDigest', 'artifactId', 'artifactName', 'repository', 'schema', 'workflowRunId',
  ])
  requirePrior(authority.schema === PRIOR_RELEASE_AUTHORITY_SCHEMA
    && typeof authority.repository === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(authority.repository)
    && Number.isSafeInteger(authority.workflowRunId) && Number(authority.workflowRunId) > 0
    && Number.isSafeInteger(authority.artifactId) && Number(authority.artifactId) > 0
    && typeof authority.artifactName === 'string'
    && /^production-release-(?:bootstrap|steady-state|recovery)-[0-9a-f]{40}$/u.test(authority.artifactName)
    && typeof authority.artifactDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(authority.artifactDigest), 'authority_identity_invalid')
  return Object.freeze(authority as unknown as PriorReleaseAuthority)
}

export function parseRecoveryReleaseAuthority(value: unknown): RecoveryReleaseAuthority {
  const authority = record(value, 'recovery_authority_invalid')
  exactKeys(authority, [
    'artifactDigest', 'artifactId', 'artifactName', 'repository', 'schema', 'workflowRunId',
  ])
  requirePrior(authority.schema === RECOVERY_RELEASE_AUTHORITY_SCHEMA
    && typeof authority.repository === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(authority.repository)
    && Number.isSafeInteger(authority.workflowRunId) && Number(authority.workflowRunId) > 0
    && Number.isSafeInteger(authority.artifactId) && Number(authority.artifactId) > 0
    && typeof authority.artifactName === 'string'
    && /^production-release-failed-(?:bootstrap|steady-state|recovery)-[0-9a-f]{40}-\d+$/u
      .test(authority.artifactName)
    && typeof authority.artifactDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(authority.artifactDigest), 'recovery_authority_identity_invalid')
  return Object.freeze(authority as unknown as RecoveryReleaseAuthority)
}

export async function fetchAuthenticatedRecoveryReceipt(input: Readonly<{
  authority: RecoveryReleaseAuthority
  repository: string
  token: string
}>): Promise<Readonly<{
  receipt: PreserveRequiredReceipt
  proof: RecoveryReleaseAuthorityProof
}>> {
  requirePrior(input.authority.repository === input.repository, 'recovery_repository_mismatch')
  const artifact = record(await githubJson(
    `https://api.github.com/repos/${input.repository}/actions/artifacts/${input.authority.artifactId}`,
    input.token,
  ), 'recovery_artifact_metadata_invalid')
  const workflow = record(artifact.workflow_run, 'recovery_artifact_workflow_run_missing')
  requirePrior(artifact.id === input.authority.artifactId
    && artifact.name === input.authority.artifactName && artifact.expired === false
    && artifact.digest === `sha256:${input.authority.artifactDigest}`
    && workflow.id === input.authority.workflowRunId
    && typeof artifact.archive_download_url === 'string', 'recovery_artifact_identity_invalid')
  const run = record(await githubJson(
    `https://api.github.com/repos/${input.repository}/actions/runs/${input.authority.workflowRunId}`,
    input.token,
  ), 'recovery_workflow_run_invalid')
  requirePrior(run.id === input.authority.workflowRunId && run.run_attempt === 1
    && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'failure'
    && run.head_branch === 'main' && run.path === '.github/workflows/production-release.yml'
    && typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/u.test(run.head_sha),
  'recovery_workflow_run_not_authoritative')
  const archive = await githubBytes(artifact.archive_download_url, input.token)
  requirePrior(sha256(archive) === input.authority.artifactDigest, 'recovery_artifact_digest_mismatch')
  const receipt = parsePreserveRequiredReceipt(extractJson(archive, 'release-receipt.json'))
  requirePrior(receipt.candidateSha === run.head_sha && receipt.runId === run.id
    && input.authority.artifactName
      === `production-release-failed-${receipt.releaseMode}-${receipt.candidateSha}-${receipt.runId}`,
  'recovery_artifact_receipt_provenance_mismatch')
  const humanAuthorization = parseHumanAuthorizationReceipt(
    extractJson(archive, 'human-authorization.json'),
    { candidateSha: receipt.candidateSha, releaseMode: receipt.releaseMode, runId: receipt.runId, runAttempt: 1 },
  )
  const humanAuthorizationDigest = evidenceDigest(humanAuthorization)
  requirePrior(receipt.evidence.humanAuthorizationDigest === humanAuthorizationDigest,
    'recovery_human_authorization_digest_mismatch')
  return Object.freeze({
    receipt,
    proof: Object.freeze({
      schema: RECOVERY_RELEASE_AUTHORITY_PROOF_SCHEMA,
      repository: input.repository,
      workflowRunId: input.authority.workflowRunId,
      workflowRunAttempt: 1,
      workflowHeadSha: run.head_sha,
      artifactId: input.authority.artifactId,
      artifactName: input.authority.artifactName,
      artifactDigest: input.authority.artifactDigest,
      receiptDigest: evidenceDigest(receipt),
      humanAuthorizationDigest,
    }),
  })
}

async function githubJson(url: string, token: string): Promise<unknown> {
  const response = await githubFetch(url, token)
  requirePrior(response.status === 200, 'github_api_status_invalid')
  return readBoundedJsonResponse(response, 1_048_576)
}

async function githubBytes(url: string, token: string): Promise<Uint8Array> {
  const response = await githubFetch(url, token)
  requirePrior(response.status === 200, 'artifact_download_status_invalid')
  const bytes = await readBoundedResponseBytes(response, 20 * 1_048_576)
  requirePrior(bytes.byteLength > 0, 'artifact_archive_size_invalid')
  return bytes
}

function githubFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  })
}

function extractReceipt(archive: Uint8Array): unknown {
  return extractJson(archive, 'release-receipt.json')
}

function extractJson(archive: Uint8Array, fileName: string): unknown {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-prior-artifact-'))
  const archivePath = path.join(temporary, 'release.zip')
  try {
    fs.writeFileSync(archivePath, archive, { mode: 0o600, flag: 'wx' })
    const entries = execFileSync('unzip', ['-Z1', archivePath], commandOptions()).trim().split('\n').filter(Boolean)
    requirePrior(entries.every((entry) => !entry.startsWith('/') && !entry.split('/').includes('..')),
      'artifact_archive_path_invalid')
    const matches = entries.filter((entry) => entry === fileName || entry.endsWith(`/${fileName}`))
    requirePrior(matches.length === 1, 'artifact_receipt_cardinality_invalid')
    const text = execFileSync('unzip', ['-p', archivePath, matches[0] as string], commandOptions())
    requirePrior(text.length > 0 && text.length <= 1_048_576, 'artifact_receipt_size_invalid')
    return JSON.parse(text) as unknown
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function commandOptions() {
  return Object.freeze({ encoding: 'utf8' as const, maxBuffer: 1_048_576, timeout: 30_000 })
}

function record(value: unknown, code: string): Record<string, unknown> {
  requirePrior(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  requirePrior(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    'authority_shape_invalid')
}

function requirePrior(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`prior_release_authority:${code}`)
}
