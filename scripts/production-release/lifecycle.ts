import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson, sha256 } from '../evidence-integrity.ts'
import {
  assertProductionCoreServicesManifestCurrent,
  PRODUCTION_CORE_SERVICES_SNAPSHOT,
} from './core-services-manifest.ts'

export const PRODUCTION_BOOTSTRAP_FAILURE_SCHEMA = 'agentic-commerce-production-bootstrap-failure/v2'

const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const MAXIMUM_JSON_BYTES = 1_048_576
const MAXIMUM_JAVASCRIPT_CHUNK_BYTES = 500_000

type JsonObject = Record<string, unknown>

export type CandidateIdentity = Readonly<{
  candidateSha: string
  candidateTree: string
  packageLockDigest: string
  coreConfigDigest: string
  coreServicesManifestDigest: string
  edgeConfigDigest: string
  sandboxConfigDigest: string
  executionHostContractDigest: string
  durableObjectStorageCompatibilityRevision: string
  sandboxStorageCompatibilityRevision: string
  candidateDigest: string
}>
export type CandidateIdentityInput = Readonly<Omit<CandidateIdentity, 'candidateDigest'>>

export function parseActiveVersion(value: unknown): string {
  const deployment = object(value, 'deployment_status_invalid')
  const versions = array(deployment.versions, 'deployment_versions_invalid')
  exact(versions.length === 1, 'active_version_cardinality_invalid')
  const active = object(versions[0], 'active_version_invalid')
  exact(active.percentage === 100, 'active_version_percentage_invalid')
  return versionId(active.version_id)
}

export function selectUploadedVersion(beforeValue: unknown, afterValue: unknown, candidateSha: string): string {
  sha1(candidateSha)
  const before = new Set(array(beforeValue, 'before_versions_invalid').map((entry) => versionId(object(entry,
    'before_version_invalid').id)))
  const matches = array(afterValue, 'after_versions_invalid').map((entry) => object(entry, 'after_version_invalid'))
    .filter((entry) => !before.has(versionId(entry.id)))
    .filter((entry) => object(entry.annotations, 'version_annotations_invalid')['workers/tag'] === candidateSha)
  exact(matches.length === 1, 'uploaded_version_cardinality_invalid')
  return versionId(matches[0]?.id)
}

export function selectExistingCandidateVersion(
  value: unknown,
  candidateSha: string,
  preferredVersionId?: string,
): string | null {
  sha1(candidateSha)
  const matches = array(value, 'candidate_versions_invalid')
    .map((entry) => object(entry, 'candidate_version_invalid'))
    .filter((entry) => object(entry.annotations, 'version_annotations_invalid')['workers/tag'] === candidateSha)
  if (preferredVersionId !== undefined) {
    const preferred = matches.filter((entry) => versionId(entry.id) === preferredVersionId)
    exact(preferred.length === 1, 'preferred_candidate_version_missing')
    return preferredVersionId
  }
  exact(matches.length <= 1, 'candidate_version_cardinality_invalid')
  return matches.length === 0 ? null : versionId(matches[0]?.id)
}

export function buildPrivateEdgeConfig(value: unknown): JsonObject {
  const config = structuredClone(object(value, 'edge_config_invalid'))
  const environment = object(config.env, 'edge_environments_invalid')
  const production = object(environment.production, 'edge_production_invalid')
  production.routes = []
  return config
}

export function proveBundleSize(directoryPath: string): JsonObject {
  const root = path.resolve(directoryPath)
  exact(fs.statSync(root).isDirectory(), 'bundle_directory_invalid')
  const chunks: Readonly<{ path: string; bytes: number; sha256: string }>[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      exact(!entry.isSymbolicLink(), 'bundle_symlink_forbidden')
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const bytes = fs.statSync(absolute).size
        exact(bytes > 0 && bytes < MAXIMUM_JAVASCRIPT_CHUNK_BYTES, 'javascript_chunk_size_invalid')
        chunks.push(Object.freeze({ path: path.relative(root, absolute), bytes, sha256: fileDigest(absolute) }))
      }
    }
  }
  exact(chunks.length > 0, 'javascript_chunk_missing')
  chunks.sort((left, right) => left.path.localeCompare(right.path))
  return Object.freeze({
    schema: 'agentic-commerce-production-bundle-size/v1',
    maximumExclusiveBytes: MAXIMUM_JAVASCRIPT_CHUNK_BYTES,
    chunks: Object.freeze(chunks),
  })
}

export function buildBootstrapFailure(input: Readonly<{
  candidateSha: string
  failedStage: string
  routeDisposition: 'absent' | 'detached' | 'unknown'
  coreVersionId: string | null
  edgeVersionId: string | null
  humanAuthorizationDigest: string
  zoneIdentityDigest: string
  coreBundleProofDigest: string
  edgeBundleProofDigest: string
}>): JsonObject {
  return Object.freeze({
    schema: PRODUCTION_BOOTSTRAP_FAILURE_SCHEMA,
    mode: 'forward-only',
    disposition: 'failed',
    candidateSha: sha1(input.candidateSha),
    failedStage: boundedText(input.failedStage, 'failed_stage_invalid'),
    routeDisposition: input.routeDisposition,
    humanAuthorizationDigest: digest(input.humanAuthorizationDigest),
    zoneIdentityDigest: digest(input.zoneIdentityDigest),
    coreBundleProofDigest: digest(input.coreBundleProofDigest),
    edgeBundleProofDigest: digest(input.edgeBundleProofDigest),
    workerVersions: Object.freeze({
      core: input.coreVersionId === null ? null : versionId(input.coreVersionId),
      edge: input.edgeVersionId === null ? null : versionId(input.edgeVersionId),
    }),
    durableObjectLifecycle: 'preserved-for-roll-forward',
    workerState: 'preserved-for-roll-forward',
    rollback: Object.freeze({ attempted: false, supported: false }),
    recovery: 'inspect-receipt-then-roll-forward',
  })
}

export function parseBootstrapResumeReceipt(value: unknown, candidateSha: string): Readonly<{
  coreVersionId: string | null
  edgeVersionId: string | null
  humanAuthorizationDigest: string
  zoneIdentityDigest: string
  coreBundleProofDigest: string
  edgeBundleProofDigest: string
}> {
  const receipt = object(value, 'bootstrap_resume_receipt_invalid')
  const keys = Object.keys(receipt).sort()
  exact(canonicalJson(keys) === canonicalJson([
    'candidateSha', 'coreBundleProofDigest', 'disposition', 'durableObjectLifecycle',
    'edgeBundleProofDigest', 'failedStage', 'humanAuthorizationDigest', 'mode', 'recovery',
    'rollback', 'routeDisposition', 'schema', 'workerState', 'workerVersions', 'zoneIdentityDigest',
  ].sort()), 'bootstrap_resume_receipt_shape_invalid')
  exact(receipt.schema === PRODUCTION_BOOTSTRAP_FAILURE_SCHEMA && receipt.mode === 'forward-only'
    && receipt.disposition === 'failed' && receipt.candidateSha === sha1(candidateSha),
  'bootstrap_resume_receipt_identity_invalid')
  exact(receipt.routeDisposition === 'absent' || receipt.routeDisposition === 'detached',
    'bootstrap_resume_route_not_private')
  exact(receipt.durableObjectLifecycle === 'preserved-for-roll-forward'
    && receipt.workerState === 'preserved-for-roll-forward'
    && receipt.recovery === 'inspect-receipt-then-roll-forward', 'bootstrap_resume_disposition_invalid')
  const rollback = object(receipt.rollback, 'bootstrap_resume_rollback_invalid')
  exact(canonicalJson(Object.keys(rollback).sort()) === canonicalJson(['attempted', 'supported']),
    'bootstrap_resume_rollback_shape_invalid')
  exact(rollback.attempted === false && rollback.supported === false,
    'bootstrap_resume_false_rollback_claim')
  const humanAuthorizationDigest = digest(receipt.humanAuthorizationDigest)
  const zoneIdentityDigest = digest(receipt.zoneIdentityDigest)
  const coreBundleProofDigest = digest(receipt.coreBundleProofDigest)
  const edgeBundleProofDigest = digest(receipt.edgeBundleProofDigest)
  const versions = object(receipt.workerVersions, 'bootstrap_resume_versions_invalid')
  exact(canonicalJson(Object.keys(versions).sort()) === canonicalJson(['core', 'edge']),
    'bootstrap_resume_versions_shape_invalid')
  const coreVersionId = versions.core === null ? null : versionId(versions.core)
  const edgeVersionId = versions.edge === null ? null : versionId(versions.edge)
  exact(coreVersionId !== null || edgeVersionId !== null, 'bootstrap_resume_has_no_partial_workers')
  return Object.freeze({
    coreVersionId,
    edgeVersionId,
    humanAuthorizationDigest,
    zoneIdentityDigest,
    coreBundleProofDigest,
    edgeBundleProofDigest,
  })
}

export function buildCandidateIdentity(candidateSha: string): CandidateIdentity {
  assertProductionCoreServicesManifestCurrent()
  exact(git(['rev-parse', 'HEAD']) === candidateSha, 'candidate_head_mismatch')
  const candidateTree = git(['rev-parse', 'HEAD^{tree}'])
  const identity = sealCandidateIdentity({
    candidateSha: sha1(candidateSha),
    candidateTree: sha1(candidateTree),
    packageLockDigest: fileDigest('package-lock.json'),
    coreConfigDigest: fileDigest('wrangler.core.jsonc'),
    coreServicesManifestDigest: PRODUCTION_CORE_SERVICES_SNAPSHOT.digest,
    edgeConfigDigest: fileDigest('wrangler.edge.jsonc'),
    sandboxConfigDigest: fileDigest('wrangler.sandbox.jsonc'),
    executionHostContractDigest: fileDigest('src/sandbox/device-host.ts'),
    durableObjectStorageCompatibilityRevision: digest(gitNodeStorageRevision()),
    sandboxStorageCompatibilityRevision: sha256(canonicalJson([
      fileDigest('src/sandbox/device-executor.ts'),
      fileDigest('src/sandbox/device-host.ts'),
    ])),
  })
  assertProductionCoreServicesManifestCurrent()
  return identity
}

export function sealCandidateIdentity(input: CandidateIdentityInput): CandidateIdentity {
  const identity = Object.freeze({
    candidateSha: sha1(input.candidateSha),
    candidateTree: sha1(input.candidateTree),
    packageLockDigest: digest(input.packageLockDigest),
    coreConfigDigest: digest(input.coreConfigDigest),
    coreServicesManifestDigest: digest(input.coreServicesManifestDigest),
    edgeConfigDigest: digest(input.edgeConfigDigest),
    sandboxConfigDigest: digest(input.sandboxConfigDigest),
    executionHostContractDigest: digest(input.executionHostContractDigest),
    durableObjectStorageCompatibilityRevision: digest(input.durableObjectStorageCompatibilityRevision),
    sandboxStorageCompatibilityRevision: digest(input.sandboxStorageCompatibilityRevision),
  })
  return Object.freeze({ ...identity, candidateDigest: sha256(canonicalJson(identity)) })
}

function fileDigest(filePath: string): string {
  return sha256(fs.readFileSync(path.resolve(filePath)))
}

function git(arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, { encoding: 'utf8', maxBuffer: 1_048_576 }).trim()
}

function gitNodeStorageRevision(): string {
  return execFileSync(process.execPath, ['scripts/validate-do-storage-compatibility.ts'], {
    encoding: 'utf8', maxBuffer: 1_048_576,
  }).trim()
}

function readJson(filePath: string): unknown {
  const descriptor = fs.openSync(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    exact(stat.isFile() && stat.size > 0 && stat.size <= MAXIMUM_JSON_BYTES, 'json_file_size_invalid')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor))) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(path.resolve(filePath), `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx' })
}

function object(value: unknown, code: string): JsonObject {
  exact(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as JsonObject
}

function array(value: unknown, code: string): unknown[] {
  exact(Array.isArray(value), code)
  return value
}

function sha1(value: unknown): string {
  exact(typeof value === 'string' && SHA1_PATTERN.test(value), 'sha1_required')
  return value
}

function digest(value: unknown): string {
  exact(typeof value === 'string' && SHA256_PATTERN.test(value), 'sha256_required')
  return value
}

function versionId(value: unknown): string {
  exact(typeof value === 'string' && VERSION_ID_PATTERN.test(value), 'version_id_invalid')
  return value
}

function boundedText(value: unknown, code: string): string {
  exact(typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 128, code)
  return value
}

function exact(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_lifecycle:${code}`)
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === 'identity' && arguments_.length === 2) {
    writeJson(arguments_[1] as string, buildCandidateIdentity(arguments_[0] as string))
  } else if (command === 'private-edge-config' && arguments_.length === 2) {
    writeJson(arguments_[1] as string, buildPrivateEdgeConfig(readJson(arguments_[0] as string)))
  } else if (command === 'active-version' && arguments_.length === 1) {
    process.stdout.write(`${parseActiveVersion(readJson(arguments_[0] as string))}\n`)
  } else if (command === 'bundle-size' && arguments_.length === 2) {
    writeJson(arguments_[1] as string, proveBundleSize(arguments_[0] as string))
  } else if (command === 'uploaded-version' && arguments_.length === 3) {
    process.stdout.write(`${selectUploadedVersion(readJson(arguments_[0] as string),
      readJson(arguments_[1] as string), arguments_[2] as string)}\n`)
  } else if (command === 'bootstrap-failure' && arguments_.length === 10) {
    const disposition = arguments_[2]
    exact(disposition === 'absent' || disposition === 'detached' || disposition === 'unknown',
      'route_disposition_invalid')
    writeJson(arguments_[9] as string, buildBootstrapFailure({
      candidateSha: arguments_[0] as string,
      failedStage: arguments_[1] as string,
      routeDisposition: disposition,
      coreVersionId: arguments_[3] === '-' ? null : arguments_[3] as string,
      edgeVersionId: arguments_[4] === '-' ? null : arguments_[4] as string,
      humanAuthorizationDigest: arguments_[5] as string,
      zoneIdentityDigest: arguments_[6] as string,
      coreBundleProofDigest: arguments_[7] as string,
      edgeBundleProofDigest: arguments_[8] as string,
    }))
  } else if (command === 'bootstrap-resume' && arguments_.length === 3) {
    const receipt = parseBootstrapResumeReceipt(readJson(arguments_[0] as string), arguments_[1] as string)
    writeJson(arguments_[2] as string, receipt)
  } else {
    throw new Error('production_lifecycle:unsupported_command')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_lifecycle:unknown_error'}\n`)
    process.exitCode = 1
  })
}
