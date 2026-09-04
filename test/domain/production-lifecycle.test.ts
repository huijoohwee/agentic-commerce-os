import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  buildBootstrapFailure,
  buildPrivateEdgeConfig,
  parseBootstrapResumeReceipt,
  parseActiveVersion,
  proveBundleSize,
  sealCandidateIdentity,
  selectUploadedVersion,
} from '../../scripts/production-release/lifecycle.ts'
import {
  parseHumanAuthorizationReceipt,
  validateHumanAuthorization,
} from '../../scripts/production-release/human-authorization.ts'

const CANDIDATE = 'a'.repeat(40)
const PRIOR = 'b'.repeat(40)

test('Active deployment parsing rejects split or partial traffic', () => {
  assert.equal(parseActiveVersion({ versions: [{ version_id: 'version-1', percentage: 100 }] }), 'version-1')
  assert.throws(() => parseActiveVersion({ versions: [
    { version_id: 'version-1', percentage: 50 },
    { version_id: 'version-2', percentage: 50 },
  ] }), /active_version_cardinality_invalid/u)
  assert.throws(() => parseActiveVersion({ versions: [{ version_id: 'version-1', percentage: 99 }] }),
    /active_version_percentage_invalid/u)
})

test('Uploaded version selection uses the observed version-set delta and exact candidate tag', () => {
  const before = [{ id: 'prior-version', annotations: { 'workers/tag': PRIOR } }]
  const after = [...before, { id: 'candidate-version', annotations: { 'workers/tag': CANDIDATE } }]
  assert.equal(selectUploadedVersion(before, after, CANDIDATE), 'candidate-version')
  assert.throws(() => selectUploadedVersion(before, [...after,
    { id: 'duplicate-candidate', annotations: { 'workers/tag': CANDIDATE } }], CANDIDATE),
  /uploaded_version_cardinality_invalid/u)
})

test('Bootstrap private edge config removes only route publication', () => {
  const original = { env: { production: { routes: [{ pattern: 'airvio.co/agentic-commerce-os' }], vars: { A: 'b' } } } }
  const privateConfig = buildPrivateEdgeConfig(original) as any
  assert.deepEqual(privateConfig.env.production.routes, [])
  assert.deepEqual(privateConfig.env.production.vars, { A: 'b' })
  assert.equal(original.env.production.routes.length, 1)
})

test('Bundle proof enforces the exclusive 500 kB JavaScript chunk ceiling', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-bundle-'))
  try {
    fs.writeFileSync(path.join(directory, 'worker.js'), Buffer.alloc(499_999, 1))
    const proof = proveBundleSize(directory) as any
    assert.equal(proof.maximumExclusiveBytes, 500_000)
    assert.equal(proof.chunks[0].bytes, 499_999)
    fs.writeFileSync(path.join(directory, 'worker.js'), Buffer.alloc(500_000, 1))
    assert.throws(() => proveBundleSize(directory), /javascript_chunk_size_invalid/u)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})

test('candidate digest binds the canonical Production core-service manifest digest', () => {
  const identity = {
    candidateSha: CANDIDATE,
    candidateTree: PRIOR,
    packageLockDigest: '1'.repeat(64),
    coreConfigDigest: '2'.repeat(64),
    coreServicesManifestDigest: '3'.repeat(64),
    edgeConfigDigest: '4'.repeat(64),
    sandboxConfigDigest: '5'.repeat(64),
    sandboxContainerBuildInputDigest: '6'.repeat(64),
    durableObjectStorageCompatibilityRevision: '7'.repeat(64),
    sandboxStorageCompatibilityRevision: '8'.repeat(64),
  }
  const sealed = sealCandidateIdentity(identity)
  const changed = sealCandidateIdentity({
    ...identity,
    coreServicesManifestDigest: '9'.repeat(64),
  })
  assert.equal(sealed.coreServicesManifestDigest, identity.coreServicesManifestDigest)
  assert.notEqual(changed.candidateDigest, sealed.candidateDigest)
  assert.throws(() => sealCandidateIdentity({
    ...identity,
    coreServicesManifestDigest: 'not-a-digest',
  }), /sha256_required/u)
})

test('Bootstrap failure is forward-only and cannot claim rollback', () => {
  const failure = buildBootstrapFailure({
    candidateSha: CANDIDATE,
    failedStage: 'route-publication',
    routeDisposition: 'detached',
    coreVersionId: 'core-version',
    edgeVersionId: null,
    humanAuthorizationDigest: '1'.repeat(64),
    zoneIdentityDigest: '2'.repeat(64),
    coreBundleProofDigest: '3'.repeat(64),
    edgeBundleProofDigest: '4'.repeat(64),
  }) as any
  assert.deepEqual(failure.rollback, { attempted: false, supported: false })
  assert.equal(failure.durableObjectLifecycle, 'preserved-for-roll-forward')
  assert.deepEqual(parseBootstrapResumeReceipt(failure, CANDIDATE), {
    coreVersionId: 'core-version', edgeVersionId: null,
    humanAuthorizationDigest: '1'.repeat(64),
    zoneIdentityDigest: '2'.repeat(64),
    coreBundleProofDigest: '3'.repeat(64),
    edgeBundleProofDigest: '4'.repeat(64),
  })
  assert.throws(() => parseBootstrapResumeReceipt({
    ...failure, candidateSha: PRIOR,
  }, CANDIDATE), /bootstrap_resume_receipt_identity_invalid/u)

})

test('Human authorization requires protected Production approval by one non-bot user', () => {
  const reviews = [{
    state: 'approved',
    environments: [{ name: 'production' }],
    user: { login: 'release-owner', id: 7, type: 'User' },
  }]
  const environment = {
    name: 'production',
    protection_rules: [{
      type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 7 } }],
    }],
  }
  const authorization = validateHumanAuthorization(reviews, environment, {
    releaseMode: 'bootstrap', candidateSha: CANDIDATE, runId: 11, runAttempt: 1,
  })
  assert.equal(authorization.approver.login, 'release-owner')
  assert.equal(authorization.environment, 'production')
  assert.deepEqual(parseHumanAuthorizationReceipt(authorization, {
    candidateSha: CANDIDATE, releaseMode: 'bootstrap', runId: 11, runAttempt: 1,
  }), authorization)
  assert.throws(() => parseHumanAuthorizationReceipt({ ...authorization, token: 'forbidden' }, {
    candidateSha: CANDIDATE, runId: 11, runAttempt: 1,
  }), /receipt_shape_invalid/u)
  assert.throws(() => validateHumanAuthorization(reviews, {
    ...environment,
    protection_rules: [{
      type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 7 } }],
    }],
  }, { releaseMode: 'bootstrap', candidateSha: CANDIDATE, runId: 11, runAttempt: 1 }),
  /self_review_not_prevented/u)
  assert.throws(() => validateHumanAuthorization(reviews, environment, {
    releaseMode: 'bootstrap', candidateSha: CANDIDATE, runId: 11, runAttempt: 2,
  }), /run_attempt_not_authorizable/u)
  assert.throws(() => validateHumanAuthorization([{
    ...reviews[0], user: { login: 'bypass-admin', id: 999, type: 'User' },
  }], environment, {
    releaseMode: 'bootstrap', candidateSha: CANDIDATE, runId: 11, runAttempt: 1,
  }), /approver_not_configured_reviewer/u)
  const missingPreventSelfReview = structuredClone(environment)
  Reflect.deleteProperty(missingPreventSelfReview.protection_rules[0] as Record<string, unknown>,
    'prevent_self_review')
  assert.throws(() => validateHumanAuthorization(reviews, missingPreventSelfReview, {
    releaseMode: 'bootstrap', candidateSha: CANDIDATE, runId: 11, runAttempt: 1,
  }), /self_review_not_prevented/u)
})
