import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson, sha256 } from '../evidence-integrity.ts'

export const PRODUCTION_RELEASE_AUTHORITY_REFUSAL_SCHEMA =
  'agentic-commerce-production-release-authority-refusal/v2'

const SHA1 = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u

type ReleaseMode = 'bootstrap' | 'steady-state'
type RefusalReason =
  | 'external-transition-cas-unavailable'
  | 'externally-attested-evidence-unavailable'
  | 'mixed-worker-version-compatibility-unproven'
  | 'remote-migration-identity-unavailable'

export type ReleaseAuthorityRefusal = Readonly<{
  schema: typeof PRODUCTION_RELEASE_AUTHORITY_REFUSAL_SCHEMA
  disposition: 'blocked-before-cloudflare-mutation'
  releaseMode: ReleaseMode
  candidateSha: string
  runId: number
  runAttempt: 1
  humanAuthorizationDigest: string
  coreBundleProofDigest: string
  edgeBundleProofDigest: string
  reasons: readonly RefusalReason[]
  requiredExternalContract: 'controller-issued-lease-fence-cas/v1'
  mutationCredentialExposed: false
  mutationAttempted: false
}>

export function buildReleaseAuthorityRefusal(input: Readonly<{
  releaseMode: ReleaseMode
  candidateSha: string
  runId: number
  runAttempt: number
  humanAuthorization: Uint8Array
  coreBundleProof: Uint8Array
  edgeBundleProof: Uint8Array
}>): ReleaseAuthorityRefusal {
  exact(SHA1.test(input.candidateSha), 'candidate_sha_invalid')
  exact(Number.isSafeInteger(input.runId) && input.runId > 0, 'run_id_invalid')
  exact(input.runAttempt === 1, 'run_attempt_not_authorizable')
  const reasons: RefusalReason[] = [
    'external-transition-cas-unavailable',
    'externally-attested-evidence-unavailable',
    'remote-migration-identity-unavailable',
  ]
  if (input.releaseMode === 'steady-state') reasons.push('mixed-worker-version-compatibility-unproven')
  return Object.freeze({
    schema: PRODUCTION_RELEASE_AUTHORITY_REFUSAL_SCHEMA,
    disposition: 'blocked-before-cloudflare-mutation',
    releaseMode: input.releaseMode,
    candidateSha: input.candidateSha,
    runId: input.runId,
    runAttempt: 1,
    humanAuthorizationDigest: digestBytes(input.humanAuthorization),
    coreBundleProofDigest: digestBytes(input.coreBundleProof),
    edgeBundleProofDigest: digestBytes(input.edgeBundleProof),
    reasons: Object.freeze(reasons),
    requiredExternalContract: 'controller-issued-lease-fence-cas/v1',
    mutationCredentialExposed: false,
    mutationAttempted: false,
  })
}

function read(filePath: string): Uint8Array {
  const resolved = path.resolve(filePath)
  const bytes = fs.readFileSync(resolved)
  exact(bytes.byteLength > 0 && bytes.byteLength <= 1_048_576, 'evidence_file_size_invalid')
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  return bytes
}

function digestBytes(value: Uint8Array): string {
  const digest = sha256(value)
  exact(SHA256.test(digest), 'evidence_digest_invalid')
  return digest
}

function exact(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_release_authority:${code}`)
}

async function main(): Promise<void> {
  const [mode, candidate, runId, runAttempt, human, coreBundle, edgeBundle, output, ...extra] =
    process.argv.slice(2)
  exact(extra.length === 0 && (mode === 'bootstrap' || mode === 'steady-state')
    && Boolean(candidate && runId && runAttempt && human && coreBundle && edgeBundle && output),
  'arguments_invalid')
  const refusal = buildReleaseAuthorityRefusal({
    releaseMode: mode,
    candidateSha: candidate as string,
    runId: Number(runId),
    runAttempt: Number(runAttempt),
    humanAuthorization: read(human as string),
    coreBundleProof: read(coreBundle as string),
    edgeBundleProof: read(edgeBundle as string),
  })
  fs.writeFileSync(path.resolve(output as string), `${canonicalJson(refusal)}\n`, { encoding: 'utf8', flag: 'wx' })
  throw new Error(`production_release_authority:${refusal.reasons.join(',')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_release_authority:unknown_error'}\n`)
    process.exitCode = 1
  })
}
