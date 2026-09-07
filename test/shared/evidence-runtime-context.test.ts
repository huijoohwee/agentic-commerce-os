import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
  EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
} from '../../scripts/evidence-dispatch-receipt.ts'
import { canonicalJson, sha256 } from '../../scripts/evidence-integrity.ts'
import {
  EVIDENCE_RUNTIME_INPUTS,
  ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA,
  describeEvidenceRuntimeSetup,
  loadEvidenceRuntimeContext,
} from '../../scripts/evidence-runtime-context.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

describe('evidence runtime context', () => {
  it('loads only a complete externally sourced trust and execution context', async () => {
    const fixture = runtimeFixture()
    const context = await loadEvidenceRuntimeContext(fixture.workspaceRoot, [], fixture.environment)

    expect(context.workspaceRoot).toBe(fs.realpathSync(fixture.workspaceRoot))
    expect(context.dispatchTrustAnchor?.policyDigest).toBe(fixture.policyDigest)
    expect(context.trustedGitExecutable).toBe(fs.realpathSync(fixture.trustedGit))
    expect(context.agenticCanvasOsRoot).toBe(fs.realpathSync(fixture.agenticCanvasOsRoot))
    expect(context.isolatedCheckExecutor?.({ namedCheck: 'npm run test:unit' } as never)).toEqual({
      adapter: 'external',
      namedCheck: 'npm run test:unit',
    })
  })

  it('accepts the same absolute file contract through unambiguous CLI bindings', async () => {
    const fixture = runtimeFixture()
    const argumentsValue = Object.entries(EVIDENCE_RUNTIME_INPUTS).map(([key, input]) => {
      const values = {
        dispatchTrustAnchor: fixture.anchorPath,
        trustedGitExecutable: fixture.trustedGit,
        agenticCanvasOsRoot: fixture.agenticCanvasOsRoot,
        isolatedExecutorModule: fixture.executorModulePath,
      }
      return `${input.flag}${values[key as keyof typeof values]}`
    })
    const context = await loadEvidenceRuntimeContext(fixture.workspaceRoot, argumentsValue, {})
    expect(context.dispatchTrustAnchor?.schema).toBe(EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA)
  })

  it('rejects candidate-controlled anchors, modules, and inline JSON self-attestation', async () => {
    const fixture = runtimeFixture()
    const candidateAnchor = path.join(fixture.workspaceRoot, 'candidate-anchor.json')
    fs.copyFileSync(fixture.anchorPath, candidateAnchor)
    await expect(loadEvidenceRuntimeContext(fixture.workspaceRoot, [], {
      ...fixture.environment,
      [EVIDENCE_RUNTIME_INPUTS.dispatchTrustAnchor.environment]: candidateAnchor,
    })).rejects.toMatchObject({ code: 'evidence_runtime_source_candidate_controlled' })

    const candidateModule = path.join(fixture.workspaceRoot, 'candidate-executor.mjs')
    fs.copyFileSync(fixture.executorModulePath, candidateModule)
    await expect(loadEvidenceRuntimeContext(fixture.workspaceRoot, [], {
      ...fixture.environment,
      [EVIDENCE_RUNTIME_INPUTS.isolatedExecutorModule.environment]: candidateModule,
    })).rejects.toMatchObject({ code: 'evidence_runtime_source_candidate_controlled' })

    await expect(loadEvidenceRuntimeContext(fixture.workspaceRoot, [], {
      ...fixture.environment,
      [EVIDENCE_RUNTIME_INPUTS.dispatchTrustAnchor.environment]: fs.readFileSync(fixture.anchorPath, 'utf8'),
    })).rejects.toMatchObject({ code: 'evidence_runtime_path_invalid' })
  })

  it('rejects malformed or changing external executor modules and conflicting inputs', async () => {
    const fixture = runtimeFixture()
    const invalidModule = path.join(fixture.externalRoot, 'invalid-executor.mjs')
    fs.writeFileSync(invalidModule, 'export const schema = "wrong"\nexport function isolatedCheckExecutor() { return {} }\n')
    await expect(loadEvidenceRuntimeContext(fixture.workspaceRoot, [], {
      ...fixture.environment,
      [EVIDENCE_RUNTIME_INPUTS.isolatedExecutorModule.environment]: invalidModule,
    })).rejects.toMatchObject({ code: 'isolated_executor_module_invalid' })

    await expect(loadEvidenceRuntimeContext(fixture.workspaceRoot, [
      `${EVIDENCE_RUNTIME_INPUTS.dispatchTrustAnchor.flag}${path.join(fixture.externalRoot, 'other.json')}`,
    ], fixture.environment)).rejects.toMatchObject({ code: 'evidence_runtime_context_ambiguous' })

    const context = await loadEvidenceRuntimeContext(fixture.workspaceRoot, [], fixture.environment)
    fs.appendFileSync(fixture.executorModulePath, '\n')
    expect(() => context.isolatedCheckExecutor?.({} as never)).toThrow('isolated_executor_module_changed')
  })

  it('reports every missing input and the empty issuer enrollment together without accepting an anchor', async () => {
    const fixture = runtimeFixture()
    clearEnrolledIssuers(fixture.workspaceRoot)
    const setup = describeEvidenceRuntimeSetup(fixture.workspaceRoot, [], {})
    expect(setup.inputs.map(input => input.environment)).toEqual(Object.values(EVIDENCE_RUNTIME_INPUTS).map(input => input.environment))
    expect(setup.inputs.every(input => input.status === 'missing')).toBe(true)
    expect(setup.enrolledIssuerCount).toBe(0)
    expect(setup.blockers.map(blocker => blocker.code)).toEqual(['runtime_inputs_unresolved', 'dispatch_issuers_unenrolled'])
    expect(setup.grantsAuthority).toBe(false)
    expect(setup.executorImportedByDiagnostic).toBe(false)
    await expect(loadEvidenceRuntimeContext(fixture.workspaceRoot, [], {}))
      .rejects.toMatchObject({ code: 'evidence_runtime_context_incomplete' })
  })

  it('does not read trust files or import configured executors and never claims readiness', () => {
    const fixture = runtimeFixture(), marker = path.join(fixture.externalRoot, 'executor-imported')
    fs.writeFileSync(fixture.anchorPath, 'not a trust anchor')
    fs.writeFileSync(fixture.executorModulePath,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'must not run')\n`)
    const setup = describeEvidenceRuntimeSetup(fixture.workspaceRoot, [], fixture.environment)
    expect(setup.inputs.every(input => input.status === 'configured')).toBe(true)
    expect(setup.blockers).toEqual([])
    expect(setup.observationOnly).toBe(true)
    expect(setup.grantsAuthority).toBe(false)
    expect(setup.executorImportedByDiagnostic).toBe(false)
    expect(setup).not.toHaveProperty('ok')
    expect(fs.existsSync(marker)).toBe(false)
    expect(JSON.stringify(setup)).not.toContain(fixture.externalRoot)
  })

  it('diagnoses a missing legacy lifecycle verifier only for an explicit root', () => {
    const fixture = runtimeFixture()
    fs.writeFileSync(path.join(fixture.agenticCanvasOsRoot, 'package.json'), JSON.stringify({
      scripts: { doctor: 'agentic-os doctor', 'check:adlc': 'npm --prefix node_modules/agentic-os run evals' },
    }))
    const setup = describeEvidenceRuntimeSetup(fixture.workspaceRoot,
      [`${EVIDENCE_RUNTIME_INPUTS.agenticCanvasOsRoot.flag}${fixture.agenticCanvasOsRoot}`], {})
    expect(setup.blockers.map(blocker => blocker.code)).toEqual(['runtime_inputs_unresolved', 'lifecycle_verifier_unavailable'])
    expect(describeEvidenceRuntimeSetup(fixture.workspaceRoot, [], {}).blockers.map(blocker => blocker.code))
      .not.toContain('lifecycle_verifier_unavailable')
  })

  it('reports invalid and ambiguous bindings without leaking their values or skipping enrollment gaps', () => {
    const fixture = runtimeFixture(), confidential = 'never-print-this-private-input'
    clearEnrolledIssuers(fixture.workspaceRoot)
    const setup = describeEvidenceRuntimeSetup(fixture.workspaceRoot,
      [`${EVIDENCE_RUNTIME_INPUTS.dispatchTrustAnchor.flag}/outside/${confidential}`], {
        ...fixture.environment,
        [EVIDENCE_RUNTIME_INPUTS.trustedGitExecutable.environment]: confidential,
        [EVIDENCE_RUNTIME_INPUTS.isolatedExecutorModule.environment]: path.join(fs.realpathSync(fixture.workspaceRoot), confidential),
      })
    expect(setup.inputs.find(input => input.name === 'dispatchTrustAnchor')?.status).toBe('ambiguous')
    expect(setup.inputs.find(input => input.name === 'trustedGitExecutable')?.status).toBe('invalid')
    expect(setup.inputs.find(input => input.name === 'isolatedExecutorModule')?.status).toBe('invalid')
    expect(setup.blockers.map(blocker => blocker.code)).toContain('dispatch_issuers_unenrolled')
    for (const hidden of [confidential, fixture.workspaceRoot, fixture.externalRoot])
      expect(JSON.stringify(setup)).not.toContain(hidden)
    expect(Buffer.byteLength(JSON.stringify(setup))).toBeLessThan(8192)
  })

  it('keeps the actual evidence CLI red and includes all source setup gaps in its existing response', () => {
    const fixture = runtimeFixture()
    clearEnrolledIssuers(fixture.workspaceRoot)
    fs.writeFileSync(path.join(fixture.agenticCanvasOsRoot, 'package.json'), JSON.stringify({ scripts: { doctor: 'agentic-os doctor' } }))
    const environment = { ...process.env }
    for (const input of Object.values(EVIDENCE_RUNTIME_INPUTS)) delete environment[input.environment]
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/checks/evidence.ts', import.meta.url)),
      `${EVIDENCE_RUNTIME_INPUTS.agenticCanvasOsRoot.flag}${fixture.agenticCanvasOsRoot}`], {
      cwd: fixture.workspaceRoot, env: environment, encoding: 'utf8', timeout: 10_000,
    })
    expect(result.status, result.stderr).toBe(1)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ ok: false, check: 'evidence', code: 'evidence_runtime_context_incomplete' })
    expect(output.setup.blockers.map((blocker: { code: string }) => blocker.code)).toEqual([
      'runtime_inputs_unresolved', 'dispatch_issuers_unenrolled', 'lifecycle_verifier_unavailable',
    ])
    expect(output.setup.inputs.filter((input: { status: string }) => input.status === 'missing')).toHaveLength(3)
    expect(result.stdout).not.toContain(fixture.externalRoot)
  })

  it('reports malformed local baseline bytes without throwing or inspecting an unconfigured lifecycle root', () => {
    const fixture = runtimeFixture()
    fs.writeFileSync(path.join(fixture.workspaceRoot, 'docs/verification-baseline.json'), '{')
    const setup = describeEvidenceRuntimeSetup(fixture.workspaceRoot, [], {})
    expect(setup.enrolledIssuerCount).toBe(null)
    expect(setup.blockers.map(blocker => blocker.code)).toEqual(['runtime_inputs_unresolved', 'verification_baseline_invalid'])
  })
})

function clearEnrolledIssuers(workspaceRoot: string): void {
  const baselinePath = path.join(workspaceRoot, 'docs/verification-baseline.json')
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, trustedDispatchIssuers: [] }))
}

type RuntimeFixture = Readonly<{
  workspaceRoot: string
  externalRoot: string
  anchorPath: string
  trustedGit: string
  agenticCanvasOsRoot: string
  executorModulePath: string
  policyDigest: string
  environment: Readonly<Record<string, string>>
}>

function runtimeFixture(): RuntimeFixture {
  const workspaceRoot = temporaryDirectory('evidence-runtime-workspace-')
  const externalRoot = temporaryDirectory('evidence-runtime-external-')
  const artifactRoot = path.join(externalRoot, 'artifacts')
  const agenticCanvasOsRoot = path.join(externalRoot, 'agentic-canvas-os')
  fs.mkdirSync(path.join(workspaceRoot, 'docs'), { recursive: true })
  fs.mkdirSync(artifactRoot)
  fs.mkdirSync(agenticCanvasOsRoot)
  fs.writeFileSync(path.join(agenticCanvasOsRoot, 'package.json'), JSON.stringify({
    private: true,
    scripts: { 'worktree:lifecycle:check': 'node --version' },
  }))

  const issuerKey = crypto.generateKeyPairSync('ed25519').publicKey
  const issuer = Object.freeze({
    issuer: 'external-dispatch-authority',
    keyId: 'dispatch-key-v1',
    algorithm: 'ed25519' as const,
    publicKeySpkiBase64: Buffer.from(issuerKey.export({ format: 'der', type: 'spki' })).toString('base64'),
  })
  const implementationBaseline = 'a'.repeat(40)
  const baselinePath = path.join(workspaceRoot, 'docs/verification-baseline.json')
  fs.writeFileSync(baselinePath, JSON.stringify({
    schema: 'agentic-commerce-verification-baseline/v1',
    implementationBaseline,
    aggregateCheck: 'npm run check:implementation',
    evidenceArtifactDirectory: 'docs/evidence-verdicts',
    trustedDispatchIssuers: [issuer],
    passingChecks: ['types:check', 'typecheck', 'test:domain', 'test:unit', 'test:workers', 'deploy:dev:dry', 'deploy:production:dry'],
  }))

  const trustedGit = trustedGitExecutable()
  const trustBody = Object.freeze({
    schema: EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
    anchorId: sha256('external-anchor'),
    verificationBaselineSha256: sha256(fs.readFileSync(baselinePath)),
    implementationBaseline,
    gitExecutableSha256: sha256(fs.readFileSync(trustedGit)),
    artifactSinkAuthority: Object.freeze({
      schema: EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
      workspaceRootRealPath: fs.realpathSync(workspaceRoot),
      artifactRootRealPath: fs.realpathSync(artifactRoot),
      exclusiveEvaluatorAccess: true as const,
      stableAncestry: true as const,
    }),
    trustedDispatchIssuers: Object.freeze([issuer]),
  })
  const policyDigest = sha256(canonicalJson(trustBody))
  const anchorPath = path.join(externalRoot, 'dispatch-trust-anchor.json')
  fs.writeFileSync(anchorPath, `${canonicalJson({ ...trustBody, policyDigest })}\n`)
  const executorModulePath = path.join(externalRoot, 'isolated-executor.mjs')
  fs.writeFileSync(executorModulePath, [
    `export const schema = '${ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA}'`,
    'export function isolatedCheckExecutor(request) {',
    "  return Object.freeze({ adapter: 'external', namedCheck: request.namedCheck })",
    '}',
    '',
  ].join('\n'))
  const environment = Object.freeze({
    [EVIDENCE_RUNTIME_INPUTS.dispatchTrustAnchor.environment]: anchorPath,
    [EVIDENCE_RUNTIME_INPUTS.trustedGitExecutable.environment]: trustedGit,
    [EVIDENCE_RUNTIME_INPUTS.agenticCanvasOsRoot.environment]: agenticCanvasOsRoot,
    [EVIDENCE_RUNTIME_INPUTS.isolatedExecutorModule.environment]: executorModulePath,
  })
  return Object.freeze({
    workspaceRoot,
    externalRoot,
    anchorPath,
    trustedGit,
    agenticCanvasOsRoot,
    executorModulePath,
    policyDigest,
    environment,
  })
}

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function trustedGitExecutable(): string {
  for (const candidate of ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']) {
    try {
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {
      // Try the next fixed location without consulting candidate-controlled PATH.
    }
  }
  throw new Error('trusted_test_git_unavailable')
}
