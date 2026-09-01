import crypto, { type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { captureCheckOutput, sanitizeOutput } from '../../scripts/capture-check-output.ts'
import { parseGovernedCheckCommand } from '../../scripts/evidence-command-policy.ts'
import {
  EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
  EVIDENCE_DISPATCH_RECEIPT_SCHEMA,
  EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
  unsignedReceipt,
  type EvidenceDispatchReceipt,
  type EvidenceDispatchTrustAnchor,
  type TrustedDispatchIssuer,
} from '../../scripts/evidence-dispatch-receipt.ts'
import { canonicalJson, sha256 } from '../../scripts/evidence-integrity.ts'
import { computeAuthoredSourceFingerprint, resolveTrustedGitRuntime } from '../../scripts/evidence-source-fingerprint.ts'
import { evaluateEvidenceGate } from '../../scripts/checks/evidence.ts'
import {
  buildCheckArtifact,
  EVIDENCE_REQUEST_SCHEMA,
  evaluateEvidenceRequest,
  readVerificationBaseline,
  runEvidenceVerdict,
  validatePersistedVerdict,
  writeCheckArtifact,
  type CheckArtifact,
  type EvidenceContext,
  type EvidenceRequest,
  type EvidenceRole,
  type EvidenceSurface,
  type IsolatedCheckExecutionRequest,
} from '../../scripts/evidence-verdict-runner.ts'

const temporaryDirectories: string[] = []
const TASK_ID = '20.2'
const TASK_CHECK = 'npm run check:evidence'
const IMPLEMENTATION_CHECK = 'npm run check:implementation'
const PERFORMER = 'independent-performer'
const EVALUATOR = 'evidence-verdict-runner'
const ISSUER = 'external-dispatch-authority'
const ISSUER_KEY_ID = 'dispatch-key-v1'
const TRUSTED_GIT = trustedGitExecutable()
const TRUSTED_GIT_SHA256 = sha256(fs.readFileSync(TRUSTED_GIT))

type Fixture = Readonly<{
  context: EvidenceContext
  artifactRoot: string
  authorityPrivateKey: KeyObject
  performerPrivateKey: KeyObject
  performerPublicKeySpkiBase64: string
  receipts: Map<string, EvidenceDispatchReceipt>
}>

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

describe('evidence verdict integrity', () => {
  it('keeps implementation verification non-circular and validates its reachable baseline', () => {
    const packageValue = readJson(path.resolve('package.json')) as { scripts: Record<string, string> }
    const baseline = readJson(path.resolve('docs/verification-baseline.json')) as {
      aggregateCheck: string
      implementationBaseline: string
      trustedDispatchIssuers: unknown[]
    }
    expect(packageValue.scripts['check:implementation']).not.toContain('check:evidence')
    expect(packageValue.scripts['check:named']).not.toContain('check:evidence')
    expect(packageValue.scripts.check).toBe(
      'npm run check:integration && npm run check:evidence',
    )
    expect(baseline).toMatchObject({ aggregateCheck: IMPLEMENTATION_CHECK, trustedDispatchIssuers: [] })
    expect(spawnSync(TRUSTED_GIT, ['merge-base', '--is-ancestor', baseline.implementationBaseline, 'HEAD']).status).toBe(0)
  })

  it('persists a deterministic verdict from two signed source-bound surfaces', () => {
    const fixture = fixtureContext()
    const request = passingRequest(fixture)
    const first = runEvidenceVerdict(request, fixture.context)
    const firstBytes = fs.readFileSync(artifactFile(fixture, first.outputPath), 'utf8')
    const second = runEvidenceVerdict(request, fixture.context)

    expect(first.verdict).toMatchObject({
      status: 'verified', taskId: TASK_ID, performingMechanism: PERFORMER,
      derivedFromSurfacedOutput: true, findings: [],
    })
    expect(first.verdict.references).toHaveLength(2)
    expect(first.verdict.sourceFingerprint?.headRevision).toMatch(/^[0-9a-f]{40}$/u)
    expect(first.verdict.dispatchTrustPolicyDigest).toBe(fixture.context.dispatchTrustAnchor?.policyDigest)
    expect(firstBytes).not.toContain(fs.realpathSync(fixture.context.workspaceRoot))
    expect(fs.readFileSync(artifactFile(fixture, second.outputPath), 'utf8')).toBe(firstBytes)
    expect(validatePersistedVerdict(JSON.parse(firstBytes) as unknown)).toBe(true)
  })

  it('rejects caller relabeling and self-grading despite a valid dispatch receipt', () => {
    const fixture = fixtureContext()
    const request = passingRequest(fixture)
    const relabeled = evaluateEvidenceRequest({ ...request, performingMechanism: 'relabeled-performer' }, fixture.context)
    expect(relabeled.status).toBe('failed')
    expect(relabeled.findings.map(({ code }) => code)).toContain('performer_identity_mismatch')

    const selfGraded = evaluateEvidenceRequest({ ...request, verdictIssuingMechanism: PERFORMER }, fixture.context)
    expect(selfGraded.status).toBe('failed')
    expect(selfGraded.findings.map(({ code }) => code)).toContain('self_graded_verdict')
  })

  it('rejects substituted branch trust keys against the external evaluator anchor', () => {
    const fixture = fixtureContext()
    const request = passingRequest(fixture)
    const baselinePath = path.join(fixture.context.workspaceRoot, 'docs/verification-baseline.json')
    const baseline = readJson(baselinePath) as Record<string, unknown>
    const replacement = Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({
      format: 'der', type: 'spki',
    })).toString('base64')
    fs.writeFileSync(baselinePath, JSON.stringify({
      ...baseline,
      trustedDispatchIssuers: [{ issuer: ISSUER, keyId: ISSUER_KEY_ID, algorithm: 'ed25519', publicKeySpkiBase64: replacement }],
    }))

    const verdict = evaluateEvidenceRequest(request, fixture.context)
    expect(verdict.status).toBe('failed')
    expect(verdict.findings.map(({ code }) => code)).toContain('dispatch_trust_anchor_mismatch')
  })

  it('rejects digest drift, failing checks, and unresolved findings', () => {
    const driftFixture = fixtureContext()
    const request = passingRequest(driftFixture)
    const drifted = { ...request, surfaces: request.surfaces.map((surface) => surface.role === 'task-named-check'
      ? { ...surface, sha256: 'f'.repeat(64) }
      : surface) }
    expect(evaluateEvidenceRequest(drifted, driftFixture.context).findings.map(({ code }) => code))
      .toContain('evidence_digest_mismatch')

    const failedFixture = fixtureContext()
    const failed = evaluateEvidenceRequest(requestFor([
      passingSurface(failedFixture, 'existing-verification', IMPLEMENTATION_CHECK),
      signedSurface(failedFixture, 'task-named-check', TASK_CHECK, TASK_ID, {
        exitCode: 1, stdout: '{"ok":false,"failures":["forced"]}\n',
      }),
    ]), failedFixture.context)
    expect(failed.findings.map(({ code }) => code)).toContain('check_failed')

    const openFixture = fixtureContext()
    const open = evaluateEvidenceRequest({ ...passingRequest(openFixture), openFindings: ['provider receipt unresolved'] }, openFixture.context)
    expect(open.findings).toContainEqual(expect.objectContaining({ code: 'unresolved_evidence' }))
  })

  it('requires performer signatures and forbids readable-surface traversal', () => {
    const signedFixture = fixtureContext()
    const signedRequest = passingRequest(signedFixture)
    const surface = signedRequest.surfaces[0]
    const artifactPath = artifactFile(signedFixture, surface?.readableSurface)
    const artifact = readJson(artifactPath) as Record<string, unknown>
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, stdout: '{"ok":false}\n' }))
    const descriptorUpdated = {
      ...signedRequest,
      surfaces: signedRequest.surfaces.map((entry) => entry === surface
        ? { ...entry, sha256: sha256(fs.readFileSync(artifactPath)) }
        : entry),
    }
    expect(evaluateEvidenceRequest(descriptorUpdated, signedFixture.context).findings.map(({ code }) => code))
      .toContain('evidence_unreadable')

    const traversalFixture = fixtureContext()
    const traversalRequest = passingRequest(traversalFixture)
    const escaped = { ...traversalRequest, surfaces: traversalRequest.surfaces.map((entry) => entry.role === 'task-named-check'
      ? { ...entry, readableSurface: '../outside.json' }
      : entry) }
    expect(evaluateEvidenceRequest(escaped, traversalFixture.context).findings.map(({ code }) => code))
      .toContain('evidence_path_forbidden')
  })

  it('ingests only evaluator-isolated signed output and rejects performer spoofing', () => {
    const fixture = fixtureContext()
    const dispatchReceiptPath = writeReceipt(fixture, TASK_ID)
    const captured = captureCheckOutput({
      taskId: TASK_ID, role: 'task-named-check', performingMechanism: PERFORMER, dispatchReceiptPath,
    }, fixture.context)
    expect(captured).toMatchObject({ ok: true, command: TASK_CHECK })
    expect(() => captureCheckOutput({
      taskId: TASK_ID, role: 'existing-verification', performingMechanism: 'spoofed-performer', dispatchReceiptPath,
    }, fixture.context)).toThrow('performer_identity_mismatch')
    expect(() => captureCheckOutput({
      taskId: TASK_ID, role: 'task-named-check', performingMechanism: PERFORMER,
      dispatchReceiptPath: path.resolve(fixture.context.workspaceRoot, dispatchReceiptPath),
    }, fixture.context)).toThrow('dispatch_receipt_invalid')
  })

  it('runs zero subprocesses when external trust or isolation is absent', () => {
    const fixture = fixtureContext()
    const dispatchReceiptPath = writeReceipt(fixture, TASK_ID)
    const shadowDirectory = path.join(fixture.context.workspaceRoot, 'node_modules/.bin')
    const marker = path.join(fixture.context.workspaceRoot, 'shadow-git-ran')
    fs.mkdirSync(shadowDirectory, { recursive: true })
    fs.writeFileSync(path.join(shadowDirectory, 'git'), `#!/bin/sh\ntouch "${marker}"\nexit 91\n`, { mode: 0o755 })
    const previousPath = process.env.PATH
    process.env.PATH = `${shadowDirectory}${path.delimiter}${previousPath ?? ''}`
    try {
      expect(() => captureCheckOutput({
        taskId: TASK_ID, role: 'task-named-check', performingMechanism: PERFORMER, dispatchReceiptPath,
      }, { workspaceRoot: fixture.context.workspaceRoot })).toThrow('dispatch_trust_anchor_unavailable')
      expect(evaluateEvidenceGate({ workspaceRoot: fixture.context.workspaceRoot }).ok).toBe(false)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      process.env.PATH = previousPath
    }

    const sinkFixture = fixtureContext()
    const sinkReceipt = writeReceipt(sinkFixture, TASK_ID)
    const anchor = sinkFixture.context.dispatchTrustAnchor
    if (!anchor) throw new Error('fixture_anchor_missing')
    const { policyDigest: _discarded, ...anchorBody } = anchor
    const mismatchedBody = Object.freeze({
      ...anchorBody,
      artifactSinkAuthority: Object.freeze({
        ...anchor.artifactSinkAuthority,
        artifactRootRealPath: fs.realpathSync(sinkFixture.context.workspaceRoot),
      }),
    })
    const mismatchedContext: EvidenceContext = Object.freeze({
      ...sinkFixture.context,
      dispatchTrustAnchor: Object.freeze({ ...mismatchedBody, policyDigest: sha256(canonicalJson(mismatchedBody)) }),
      isolatedCheckExecutor: () => { throw new Error('executor_reached') },
    })
    expect(() => captureCheckOutput({
      taskId: TASK_ID, role: 'task-named-check', performingMechanism: PERFORMER, dispatchReceiptPath: sinkReceipt,
    }, mismatchedContext)).toThrow('evidence_sink_untrusted')
  })

  it('parses governed argv without shell interpolation', () => {
    const fixture = fixtureContext()
    expect(parseGovernedCheckCommand('npm run check:evidence')).toEqual({ runtime: 'npm', argumentsValue: ['run', 'check:evidence'] })
    expect(parseGovernedCheckCommand(
      'npm --prefix "$AGENTIC_CANVAS_OS_ROOT" run worktree:lifecycle:check',
      { agenticCanvasOsRoot: fixture.context.workspaceRoot },
    )).toEqual({
      runtime: 'npm',
      argumentsValue: ['--prefix', fs.realpathSync(fixture.context.workspaceRoot), 'run', 'worktree:lifecycle:check'],
    })
    for (const unsafe of ['npm run check:evidence; id', 'npm run check:evidence && id', 'npm run $(id)', 'node -e "id"']) {
      expect(parseGovernedCheckCommand(unsafe)).toBeNull()
    }
  })

  it('makes add/change/delete/mode/symlink mutations stale', () => {
    const mutations: ReadonlyArray<(root: string) => void> = [
      root => fs.appendFileSync(path.join(root, 'src/authored.ts'), '\nexport const changed = true\n'),
      root => fs.writeFileSync(path.join(root, 'src/added.ts'), 'export const added = true\n'),
      root => fs.rmSync(path.join(root, 'src/authored.ts')),
      root => fs.chmodSync(path.join(root, 'src/authored.ts'), 0o755),
      root => fs.symlinkSync('authored.ts', path.join(root, 'src/authored-link.ts')),
    ]
    for (const mutate of mutations) {
      const fixture = fixtureContext()
      runEvidenceVerdict(passingRequest(fixture), fixture.context)
      expect(evaluateEvidenceGate(fixture.context).ok).toBe(true)
      mutate(fixture.context.workspaceRoot)
      expect(evaluateEvidenceGate(fixture.context)).toMatchObject({ ok: false, staleVerdictCount: 1 })
    }
  }, 30_000)
  it('refuses an authored source file beyond the per-file fingerprint ceiling', () => {
    const fixture = fixtureContext()
    const oversized = path.join(fixture.context.workspaceRoot, 'src/oversized.ts')
    fs.writeFileSync(oversized, 'x')
    fs.truncateSync(oversized, 2 * 1024 * 1024 + 1)
    const baseline = readVerificationBaseline(fixture.context)
    const anchor = fixture.context.dispatchTrustAnchor
    const trustedGit = anchor
      ? resolveTrustedGitRuntime(fixture.context.workspaceRoot, fixture.context.trustedGitExecutable, anchor.gitExecutableSha256)
      : null
    expect(baseline && trustedGit
      ? computeAuthoredSourceFingerprint(fixture.context.workspaceRoot, baseline.implementationBaseline, trustedGit)
      : null).toBeNull()
  })
  it('keeps external evidence writes out of the authored tree and rejects a later source commit', () => {
    const fixture = fixtureContext()
    const headBeforeEvidence = git(fixture.context.workspaceRoot, ['rev-parse', 'HEAD'])
    runEvidenceVerdict(passingRequest(fixture), fixture.context)
    expect(git(fixture.context.workspaceRoot, ['status', '--short'])).toBe('')
    expect(git(fixture.context.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(headBeforeEvidence)
    expect(evaluateEvidenceGate(fixture.context).ok).toBe(true)
    fs.appendFileSync(path.join(fixture.context.workspaceRoot, 'src/authored.ts'), '\nexport const later = true\n')
    git(fixture.context.workspaceRoot, ['add', 'src/authored.ts'])
    git(fixture.context.workspaceRoot, ['commit', '-m', 'change authored source'])
    expect(evaluateEvidenceGate(fixture.context)).toMatchObject({ ok: false, staleVerdictCount: 1 })
  })
  it('requires the exact complete set while excluding evidence run outputs', () => {
    const fixture = fixtureContext(TASK_CHECK, [TASK_ID, '20.3'])
    runEvidenceVerdict(passingRequest(fixture), fixture.context)
    expect(evaluateEvidenceGate(fixture.context)).toMatchObject({ ok: false, missingVerdictCount: 1 })
    runEvidenceVerdict(passingRequest(fixture, '20.3'), fixture.context)
    expect(evaluateEvidenceGate(fixture.context)).toMatchObject({ ok: true, verifiedTaskCount: 2 })
    fs.writeFileSync(path.join(fixture.artifactRoot, 'run-output.json'), '{}\n')
    expect(evaluateEvidenceGate(fixture.context).ok).toBe(true)
  })
  it('fails on empty, duplicate, and malformed verdict sets', () => {
    expect(evaluateEvidenceGate(fixtureContext().context)).toMatchObject({ ok: false, missingVerdictCount: 1 })
    const duplicate = fixtureContext()
    const persisted = runEvidenceVerdict(passingRequest(duplicate), duplicate.context)
    const verdictPath = artifactFile(duplicate, persisted.outputPath)
    fs.copyFileSync(verdictPath, path.join(path.dirname(verdictPath), 'duplicate.json'))
    expect(evaluateEvidenceGate(duplicate.context)).toMatchObject({ ok: false, duplicateVerdictCount: 1 })
    const malformed = fixtureContext()
    const malformedResult = runEvidenceVerdict(passingRequest(malformed), malformed.context)
    fs.writeFileSync(artifactFile(malformed, malformedResult.outputPath), '{}\n')
    expect(evaluateEvidenceGate(malformed.context)).toMatchObject({ ok: false, invalidVerdictCount: 1 })
  })
  it('fails closed for malformed or unreachable implementation baselines', () => {
    for (const implementationBaseline of ['not-a-revision', 'f'.repeat(40)]) {
      const fixture = fixtureContext()
      const baselinePath = path.join(fixture.context.workspaceRoot, 'docs/verification-baseline.json')
      const baseline = readJson(baselinePath) as Record<string, unknown>
      fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, implementationBaseline }))
      expect(evaluateEvidenceGate(fixture.context)).toMatchObject({
        ok: false,
        failures: expect.arrayContaining([expect.stringContaining('implementation baseline')]),
      })
    }
  })

  it('sanitizes local paths and credential-shaped output before signed persistence', () => {
    const workspaceRoot = path.join(path.sep, 'workspace', 'project')
    const credentialValue = ['session', 'fixture', 'value'].join('-')
    const output = `${workspaceRoot}/test.ts\n/Users/developer/repo\nAuthorization: Bearer ${credentialValue}`
    const sanitized = sanitizeOutput(output, workspaceRoot)
    expect(sanitized).toContain('<workspace>/test.ts')
    expect(sanitized).toContain('<developer-root>/repo')
    expect(sanitized).toContain('Bearer <redacted>')
    expect(sanitized).not.toContain(credentialValue)
  })
})

function fixtureContext(taskNamedCheck = TASK_CHECK, taskIds: readonly string[] = [TASK_ID]): Fixture {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-verdict-'))
  temporaryDirectories.push(workspaceRoot)
  fs.mkdirSync(path.join(workspaceRoot, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(workspaceRoot, 'config'), { recursive: true })
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true })
  const authority = crypto.generateKeyPairSync('ed25519')
  const performer = crypto.generateKeyPairSync('ed25519')
  const issuer = trustedIssuer(authority.publicKey)
  fs.writeFileSync(path.join(workspaceRoot, 'src/authored.ts'), 'export const authored = true\n')
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      'check:implementation': 'node --version',
      'check:evidence': 'node --version',
      'worktree:lifecycle:check': 'node --version',
    },
  }))
  writeFixtureSnapshot(workspaceRoot, taskNamedCheck, taskIds)
  writeBaseline(workspaceRoot, '0'.repeat(40), [issuer])
  initializeGit(workspaceRoot)
  const implementationBaseline = git(workspaceRoot, ['rev-parse', 'HEAD'])
  writeBaseline(workspaceRoot, implementationBaseline, [issuer])
  git(workspaceRoot, ['add', 'docs/verification-baseline.json'])
  git(workspaceRoot, ['commit', '-m', 'bind verification baseline'])
  const baseline = readVerificationBaseline({ workspaceRoot })
  if (!baseline) throw new Error('fixture_baseline_invalid')
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-verdict-sink-'))
  temporaryDirectories.push(artifactRoot)
  const trustBody = Object.freeze({
    schema: EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
    anchorId: sha256('fixture-external-anchor'),
    verificationBaselineSha256: baseline.documentSha256,
    implementationBaseline,
    gitExecutableSha256: TRUSTED_GIT_SHA256,
    artifactSinkAuthority: Object.freeze({
      schema: EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
      workspaceRootRealPath: fs.realpathSync(workspaceRoot),
      artifactRootRealPath: fs.realpathSync(artifactRoot),
      exclusiveEvaluatorAccess: true as const,
      stableAncestry: true as const,
    }),
    trustedDispatchIssuers: Object.freeze([issuer]),
  })
  const dispatchTrustAnchor: EvidenceDispatchTrustAnchor = Object.freeze({
    ...trustBody,
    policyDigest: sha256(canonicalJson(trustBody)),
  })
  const receipts = new Map<string, EvidenceDispatchReceipt>()
  let fixture: Fixture
  const context: EvidenceContext = Object.freeze({
    workspaceRoot,
    dispatchTrustAnchor,
    trustedGitExecutable: TRUSTED_GIT,
    agenticCanvasOsRoot: workspaceRoot,
    isolatedCheckExecutor: request => signedArtifact(fixture, request),
  })
  fixture = Object.freeze({
    context,
    artifactRoot,
    authorityPrivateKey: authority.privateKey,
    performerPrivateKey: performer.privateKey,
    performerPublicKeySpkiBase64: Buffer.from(performer.publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
    receipts,
  })
  return fixture
}

function signedArtifact(fixture: Fixture, request: IsolatedCheckExecutionRequest, result: Partial<{
  ran: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  outputTruncated: boolean
}> = {}): CheckArtifact {
  return buildCheckArtifact({
    namedCheck: request.namedCheck,
    performingMechanism: request.dispatchReceipt.performingMechanism,
    dispatchReceipt: request.dispatchReceipt,
    dispatchTrustPolicyDigest: request.dispatchTrustPolicyDigest,
    sourceFingerprint: request.sourceFingerprint,
    sourceStable: true,
    ran: result.ran ?? true,
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? '{"ok":true,"assertionCount":3,"failures":[]}\n',
    stderr: result.stderr ?? '',
    outputTruncated: result.outputTruncated ?? false,
  }, payload => Buffer.from(crypto.sign(null, Buffer.from(payload), fixture.performerPrivateKey)).toString('base64'))
}

function signedSurface(
  fixture: Fixture,
  role: EvidenceRole,
  namedCheck: string,
  taskId: string,
  result: Partial<{ exitCode: number | null; stdout: string }> = {},
): EvidenceSurface {
  const sourceFingerprint = currentFingerprint(fixture)
  const dispatchReceipt = receiptFor(fixture, taskId)
  const request: IsolatedCheckExecutionRequest = Object.freeze({
    taskId,
    role,
    namedCheck,
    invocation: { runtime: 'npm' as const, argumentsValue: ['run', 'fixture'] },
    workspaceRoot: fixture.context.workspaceRoot,
    maxOutputBytes: 2 * 1024 * 1024,
    sourceFingerprint,
    dispatchReceipt,
    dispatchTrustPolicyDigest: fixture.context.dispatchTrustAnchor?.policyDigest ?? '',
  })
  return writeCheckArtifact(fixture.context, taskId, role, signedArtifact(fixture, request, result))
}

function passingSurface(fixture: Fixture, role: EvidenceRole, namedCheck: string, taskId = TASK_ID): EvidenceSurface {
  return signedSurface(fixture, role, namedCheck, taskId)
}

function passingRequest(fixture: Fixture, taskId = TASK_ID): EvidenceRequest {
  return requestFor([
    passingSurface(fixture, 'existing-verification', IMPLEMENTATION_CHECK, taskId),
    passingSurface(fixture, 'task-named-check', TASK_CHECK, taskId),
  ], taskId)
}

function requestFor(surfaces: readonly EvidenceSurface[], taskId = TASK_ID): EvidenceRequest {
  return Object.freeze({
    schema: EVIDENCE_REQUEST_SCHEMA,
    taskId,
    performingMechanism: PERFORMER,
    verdictIssuingMechanism: EVALUATOR,
    openFindings: Object.freeze([]),
    surfaces: Object.freeze(surfaces),
  })
}

function receiptFor(fixture: Fixture, taskId: string): EvidenceDispatchReceipt {
  const existing = fixture.receipts.get(taskId)
  if (existing) return existing
  const payload = {
    schema: EVIDENCE_DISPATCH_RECEIPT_SCHEMA,
    receiptId: sha256(`dispatch:${taskId}`),
    taskId,
    performingMechanism: PERFORMER,
    performerPublicKeySpkiBase64: fixture.performerPublicKeySpkiBase64,
    sourceFingerprint: currentFingerprint(fixture),
    semanticScope: 'evidence-integrity',
    declaredWriteSet: Object.freeze(['scripts/evidence/**']),
    claimId: 'fixture-evidence-claim',
    leaseEpoch: 1,
    fenceRevision: 'b'.repeat(40),
    issuer: ISSUER,
    issuerKeyId: ISSUER_KEY_ID,
    issuedAtMs: 1,
  } as const
  const provisional = {
    ...payload,
    receiptDigest: sha256(canonicalJson(payload)),
    signatureAlgorithm: 'ed25519' as const,
    signatureBase64: '',
  }
  const receipt: EvidenceDispatchReceipt = Object.freeze({
    ...provisional,
    signatureBase64: Buffer.from(crypto.sign(
      null,
      Buffer.from(canonicalJson(unsignedReceipt(provisional))),
      fixture.authorityPrivateKey,
    )).toString('base64'),
  })
  fixture.receipts.set(taskId, receipt)
  return receipt
}

function writeReceipt(fixture: Fixture, taskId: string): string {
  const relativePath = `docs/evidence-verdicts/dispatch/task-${taskId.replace('.', '-')}.json`
  const absolutePath = artifactFile(fixture, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, `${canonicalJson(receiptFor(fixture, taskId))}\n`)
  return relativePath
}

function artifactFile(fixture: Fixture, logicalPath: string | null | undefined): string {
  if (!logicalPath?.startsWith('docs/evidence-verdicts/')) throw new Error('fixture_artifact_path_invalid')
  return path.join(fixture.artifactRoot, logicalPath.slice('docs/evidence-verdicts/'.length))
}

function currentFingerprint(fixture: Fixture) {
  const baseline = readVerificationBaseline(fixture.context)
  const trustedGit = fixture.context.dispatchTrustAnchor
    ? resolveTrustedGitRuntime(fixture.context.workspaceRoot, fixture.context.trustedGitExecutable,
      fixture.context.dispatchTrustAnchor.gitExecutableSha256)
    : null
  const fingerprint = baseline && trustedGit
    ? computeAuthoredSourceFingerprint(fixture.context.workspaceRoot, baseline.implementationBaseline, trustedGit)
    : null
  if (!fingerprint) throw new Error('fixture_source_fingerprint_unavailable')
  return fingerprint
}

function trustedIssuer(publicKey: KeyObject): TrustedDispatchIssuer {
  return Object.freeze({
    issuer: ISSUER,
    keyId: ISSUER_KEY_ID,
    algorithm: 'ed25519',
    publicKeySpkiBase64: Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
  })
}

function writeBaseline(workspaceRoot: string, implementationBaseline: string, issuers: readonly TrustedDispatchIssuer[]): void {
  fs.writeFileSync(path.join(workspaceRoot, 'docs/verification-baseline.json'), JSON.stringify({
    schema: 'agentic-commerce-verification-baseline/v1',
    implementationBaseline,
    aggregateCheck: IMPLEMENTATION_CHECK,
    evidenceArtifactDirectory: 'docs/evidence-verdicts',
    trustedDispatchIssuers: issuers,
    passingChecks: ['types:check', 'typecheck', 'test:domain', 'test:unit', 'test:workers', 'deploy:dev:dry', 'deploy:production:dry'],
  }))
}

function writeFixtureSnapshot(workspaceRoot: string, taskNamedCheck: string, taskIds: readonly string[]): void {
  fs.writeFileSync(path.join(workspaceRoot, 'config/task-bounds.snapshot.json'), JSON.stringify({
    schema: 'agentic-commerce-task-bounds-snapshot/v2',
    source: '.kiro/specs/agentic-graph-commerce-platform/tasks.md',
    sourceSha256: 'a'.repeat(64),
    taskCount: taskIds.length,
    boundsCount: taskIds.length,
    findingCount: 0,
    namedCheckGroups: [{ namedCheck: taskNamedCheck, taskIds }],
  }))
}

function initializeGit(workspaceRoot: string): void {
  git(workspaceRoot, ['init', '-q'])
  git(workspaceRoot, ['config', 'user.email', 'evidence-fixture@example.invalid'])
  git(workspaceRoot, ['config', 'user.name', 'Evidence Fixture'])
  git(workspaceRoot, ['add', '.'])
  git(workspaceRoot, ['commit', '-m', 'fixture baseline'])
}

function git(workspaceRoot: string, argumentsValue: readonly string[]): string {
  const result = spawnSync(TRUSTED_GIT, ['-C', workspaceRoot, ...argumentsValue], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-08-30T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-30T00:00:00Z',
    },
  })
  if (result.status !== 0) throw new Error(String(result.stderr))
  return String(result.stdout).trim()
}

function trustedGitExecutable(): string {
  for (const candidate of ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']) {
    try {
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {
      // Try the next fixed system location without consulting candidate-controlled PATH.
    }
  }
  throw new Error('trusted_test_git_unavailable')
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
}
