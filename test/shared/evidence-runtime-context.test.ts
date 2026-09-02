import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
  EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
} from '../../scripts/evidence-dispatch-receipt.ts'
import { canonicalJson, sha256 } from '../../scripts/evidence-integrity.ts'
import {
  EVIDENCE_RUNTIME_INPUTS,
  ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA,
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
})

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
