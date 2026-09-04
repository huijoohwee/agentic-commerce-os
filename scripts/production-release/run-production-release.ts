import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readUpstreamEvidencePin } from '../../src/core/upstream-evidence.ts'
import { canonicalJson } from '../evidence-integrity.ts'
import { parseHumanAuthorizationReceipt } from './human-authorization.ts'
import { buildHumanPresenceAnchorProof } from './human-presence-anchor.ts'
import { buildCandidateIdentity } from './lifecycle.ts'
import {
  executeProductionRelease,
  type ProductionOperatorPins,
} from './production-controller.ts'
import { createWranglerReleaseAdapter } from './wrangler-release-adapter.ts'
import {
  fetchAuthenticatedPriorReceipt,
  fetchAuthenticatedRecoveryReceipt,
  parsePriorReleaseAuthority,
  parseRecoveryReleaseAuthority,
} from './prior-release-authority.ts'
import { parseProductionRouteAuthority } from './route-authority.ts'

const MAXIMUM_JSON_BYTES = 1_048_576
const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const PLACEHOLDER_PATTERN = /(?:change[-_ ]?me|example|placeholder|required|unreleased)/iu

async function main(): Promise<void> {
  const [command, mode, candidateSha, runIdText, runAttemptText, humanPath, outputPath, priorPath, ...extra] =
    process.argv.slice(2)
  requireRelease(command === 'execute'
    && (mode === 'bootstrap' || mode === 'steady-state' || mode === 'recovery')
    && Boolean(candidateSha && runIdText && runAttemptText && humanPath && outputPath)
    && extra.length === 0, 'arguments_invalid')
  const runId = Number(runIdText)
  const runAttempt = Number(runAttemptText)
  requireRelease(SHA1_PATTERN.test(candidateSha as string), 'candidate_sha_invalid')
  requireRelease(Number.isSafeInteger(runId) && runId > 0 && runAttempt === 1, 'run_identity_invalid')
  verifyProtectedMain(candidateSha as string)
  validateCloudflareAuthority()
  const root = process.cwd()
  const identity = buildCandidateIdentity(candidateSha as string)
  const humanAuthorization = parseHumanAuthorizationReceipt(readJson(humanPath as string), {
    releaseMode: mode,
    candidateSha: candidateSha as string,
    runId,
    runAttempt,
  })
  const operatorPins = readOperatorPins()
  const prior = mode === 'steady-state' && priorPath && priorPath !== '-'
    ? await fetchAuthenticatedPriorReceipt({
        authority: parsePriorReleaseAuthority(readJson(priorPath)),
        repository: environment('GITHUB_REPOSITORY'),
        token: credential('GITHUB_TOKEN'),
      })
    : null
  const recovery = mode === 'recovery' && priorPath && priorPath !== '-'
    ? await fetchAuthenticatedRecoveryReceipt({
        authority: parseRecoveryReleaseAuthority(readJson(priorPath)),
        repository: environment('GITHUB_REPOSITORY'),
        token: credential('GITHUB_TOKEN'),
      })
    : null
  requireRelease(mode === 'steady-state' ? prior !== null && recovery === null
    : mode === 'recovery' ? recovery !== null && prior === null
      : prior === null && recovery === null, 'prior_release_authority_mode_invalid')
  if (prior) verifyPriorAncestry(prior.receipt.candidateSha, candidateSha as string)
  const outcome = await executeProductionRelease({
    releaseMode: mode,
    identity,
    runId,
    humanAuthorization,
    operatorPins,
    routeAuthority: parseProductionRouteAuthority(JSON.parse(environment('PRODUCTION_ROUTE_AUTHORITY_JSON'))),
    secrets: readWorkerSecrets(),
    priorReceipt: prior?.receipt ?? recovery?.receipt.priorDeploymentReceipt ?? null,
    priorAuthorityProof: prior?.proof ?? recovery?.proof ?? null,
    recoveryReceipt: recovery?.receipt ?? null,
    configs: Object.freeze({
      sandbox: readJson(path.join(root, 'wrangler.sandbox.jsonc')),
      core: readJson(path.join(root, 'wrangler.core.jsonc')),
      edge: readJson(path.join(root, 'wrangler.edge.jsonc')),
    }),
    adapter: createWranglerReleaseAdapter(root),
  })
  writeJson(outputPath as string, outcome.receipt)
  if (!outcome.ok) throw new Error(`production_release:${outcome.receipt.disposition}:${outcome.cause}`)
  process.stdout.write(`${canonicalJson({
    ok: true,
    schema: outcome.receipt.schema,
    candidateSha: outcome.receipt.candidateSha,
    candidateDigest: outcome.receipt.candidateDigest,
  })}\n`)
}

function verifyProtectedMain(candidateSha: string): void {
  requireRelease(process.env.GITHUB_REF === 'refs/heads/main', 'protected_ref_invalid')
  requireRelease(process.env.GITHUB_SHA === candidateSha, 'github_candidate_mismatch')
  requireRelease(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'github_event_invalid')
  requireRelease(process.env.GITHUB_RUN_ATTEMPT === '1', 'github_attempt_invalid')
  requireRelease(git(['rev-parse', 'HEAD']) === candidateSha, 'checkout_candidate_mismatch')
  const remote = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/u)[0] ?? ''
  requireRelease(remote === candidateSha, 'protected_main_advanced')
  requireRelease(git(['status', '--porcelain', '--untracked-files=all']) === '', 'checkout_dirty')
}

function readOperatorPins(): ProductionOperatorPins {
  const acosSourceRevision = environment('ACOS_RUNTIME_SOURCE_REVISION')
  const acosCandidateDigest = environment('ACOS_RUNTIME_CANDIDATE_DIGEST')
  requireRelease(SHA1_PATTERN.test(acosSourceRevision), 'acos_source_revision_invalid')
  requireRelease(SHA256_PATTERN.test(acosCandidateDigest), 'acos_candidate_digest_invalid')
  const discoveryProviderEvidencePinJson = evidencePin('DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON')
  const checkoutProviderEvidencePinJson = evidencePin('CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON')
  const marketplaceProviderEvidencePinJson = evidencePin('MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON')
  const humanPresenceTrustAnchorJson = buildHumanPresenceAnchorProof(
    environment('HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON'),
  ).bindingValue
  return Object.freeze({
    acosSourceRevision,
    acosCandidateDigest,
    discoveryProviderEvidencePinJson,
    checkoutProviderEvidencePinJson,
    marketplaceProviderEvidencePinJson,
    humanPresenceTrustAnchorJson,
  })
}

function evidencePin(name: string): string {
  const value = environment(name)
  const pin = readUpstreamEvidencePin(value)
  requireRelease(pin !== null && !Object.values(pin).some((entry) => PLACEHOLDER_PATTERN.test(entry)),
    `${name.toLowerCase()}_invalid`)
  return canonicalJson(pin)
}

function validateCloudflareAuthority(): void {
  const accountId = environment('CLOUDFLARE_ACCOUNT_ID')
  requireRelease(/^[0-9a-f]{32}$/u.test(accountId), 'cloudflare_account_id_invalid')
  credential('CLOUDFLARE_API_TOKEN')
}

function readWorkerSecrets(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries([
    'DISCOVERY_PROVIDER_BEARER_TOKEN',
    'AGENTIC_OS_ADMISSION_AUTH_SECRET',
    'CHECKOUT_PROVIDER_AUTH_SECRET',
    'MARKETPLACE_PROVIDER_AUTH_SECRET',
    'MCP_BEARER_TOKEN',
    'OPERATOR_BEARER_TOKEN',
    'STOREFRONT_SESSION_SECRET',
  ].map((name) => [name, credential(name)])))
}

function credential(name: string): string {
  const value = environment(name)
  const maximum = name === 'AGENTIC_OS_ADMISSION_AUTH_SECRET' ? 256 : 4096
  requireRelease(value.length >= 32 && value.length <= maximum && !PLACEHOLDER_PATTERN.test(value),
    `${name.toLowerCase()}_invalid`)
  return value
}

function environment(name: string): string {
  const value = process.env[name]
  requireRelease(typeof value === 'string' && value === value.trim() && value.length > 0,
    `${name.toLowerCase()}_missing`)
  return value
}

function readJson(filePath: string): unknown {
  const descriptor = fs.openSync(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    requireRelease(stat.isFile() && stat.size > 0 && stat.size <= MAXIMUM_JSON_BYTES, 'json_file_invalid')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor))) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(path.resolve(filePath), `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx' })
}

function git(arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, { encoding: 'utf8', maxBuffer: MAXIMUM_JSON_BYTES }).trim()
}

function verifyPriorAncestry(priorSha: string, candidateSha: string): void {
  let ancestor = false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', priorSha, candidateSha], {
      encoding: 'utf8', maxBuffer: MAXIMUM_JSON_BYTES, stdio: ['ignore', 'ignore', 'ignore'],
    })
    ancestor = true
  } catch {
    ancestor = false
  }
  requireRelease(ancestor, 'prior_release_candidate_not_ancestor')
}

function requireRelease(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_release:${code}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_release:unknown_error'}\n`)
    process.exitCode = 1
  })
}
