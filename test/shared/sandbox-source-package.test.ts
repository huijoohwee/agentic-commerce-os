import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { runSandboxLiveProof } from '../../scripts/sandbox-live-proof.ts'
import { buildSandboxSourcePackage } from '../../scripts/sandbox-source-package.ts'
import {
  canonicalJson,
  SANDBOX_PROOF_BOUNDS,
  SANDBOX_PROOF_COMMANDS,
  SANDBOX_PROOF_IMAGE,
  SANDBOX_PROOF_PACKAGE_VERSION,
  SANDBOX_UNSIGNED_PROOF_SCHEMA,
  sha256Hex,
} from '../../src/sandbox/provision-contract.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Sandbox source packager', () => {
  it('captures the exact current tracked, modified, and untracked authored bytes without Git or dependencies', async () => {
    const repository = repositoryFixture()
    fs.writeFileSync(path.join(repository.root, 'src/value.ts'), 'export const value = 2\n')
    fs.writeFileSync(path.join(repository.root, 'src/new.ts'), 'export const newValue = true\n')
    fs.mkdirSync(path.join(repository.root, 'node_modules/ignored'), { recursive: true })
    fs.writeFileSync(path.join(repository.root, 'node_modules/ignored/index.js'), 'throw new Error("must not transfer")')

    const sourcePackage = await buildSandboxSourcePackage(options(repository))

    expect(sourcePackage.entries.map(({ path: relativePath }) => relativePath)).toEqual([
      'package-lock.json',
      'package.json',
      'src/new.ts',
      'src/value.ts',
    ])
    expect(Buffer.from(sourcePackage.entries.find(({ path: relativePath }) => relativePath === 'src/value.ts')!
      .contentBase64, 'base64').toString()).toBe('export const value = 2\n')
    expect(sourcePackage.entries.every(({ path: relativePath }) => (
      !relativePath.startsWith('.git/') && !relativePath.startsWith('node_modules/')
    ))).toBe(true)
  })

  it('fails instead of silently packaging an authored secret path', async () => {
    const repository = repositoryFixture()
    fs.writeFileSync(path.join(repository.root, '.env'), 'REAL_SECRET=must-not-transfer\n')
    git(repository.root, ['add', '.env'])

    await expect(buildSandboxSourcePackage(options(repository)))
      .rejects.toThrow('sandbox_source_path_forbidden:.env')
  })

  it('fails instead of following an authored symlink', async () => {
    const repository = repositoryFixture()
    fs.symlinkSync('package.json', path.join(repository.root, 'linked-package.json'))
    git(repository.root, ['add', 'linked-package.json'])

    await expect(buildSandboxSourcePackage(options(repository)))
      .rejects.toThrow('sandbox_source_symlink_forbidden:linked-package.json')
  })

  it('writes only an external unsigned signing payload after a source-stable remote proof', async () => {
    const repository = repositoryFixture()
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-sandbox-output-'))
    temporaryRoots.push(outputRoot)
    const outputPath = path.join(outputRoot, 'unsigned.json')
    let observedAuthorization = ''
    const result = await runSandboxLiveProof({
      AG_SANDBOX_PROOF_WORKSPACE: repository.root,
      AG_SANDBOX_PROOF_ENDPOINT: 'https://proof.example/v1/provision-proof',
      AG_SANDBOX_PROOF_BEARER_TOKEN: 'z'.repeat(64),
      AG_SANDBOX_PROOF_ISSUER: 'sandbox-provision-controller',
      AG_SANDBOX_PROOF_ISSUER_KEY_ID: 'sandbox-provision-key-1',
      AG_SANDBOX_PROOF_IMPLEMENTATION_BASELINE: repository.baseline,
      AG_SANDBOX_PROOF_TRUSTED_GIT: repository.gitExecutable,
      AG_SANDBOX_PROOF_TRUSTED_GIT_SHA256: repository.gitSha256,
      AG_SANDBOX_UNSIGNED_RECEIPT_PATH: outputPath,
    }, (async (_input, init) => {
      observedAuthorization = new Headers(init?.headers).get('authorization') ?? ''
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const receiptBody = await receiptBodyForRequest(request)
      return Response.json({
        ok: true,
        schema: SANDBOX_UNSIGNED_PROOF_SCHEMA,
        receiptBody,
        receiptDigest: await sha256Hex(canonicalJson(receiptBody)),
      })
    }) as typeof fetch)

    expect(observedAuthorization).toBe(`Bearer ${'z'.repeat(64)}`)
    expect(result.outputPath).toBe(outputPath)
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>
    expect(output).toMatchObject({ schema: SANDBOX_UNSIGNED_PROOF_SCHEMA, receiptDigest: result.receiptDigest })
    expect(output.controller).toMatchObject({
      provider: 'cloudflare-workers',
      endpoint: 'https://proof.example/v1/provision-proof',
    })
    expect(output).not.toHaveProperty('signatureBase64')
    expect(output).not.toHaveProperty('privateKey')
    expect(Buffer.from(String(output.signingPayloadBase64), 'base64').toString())
      .toBe(canonicalJson(output.receiptBody))
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600)
  })
})

type RepositoryFixture = Readonly<{
  root: string
  baseline: string
  gitExecutable: string
  gitSha256: string
}>

function repositoryFixture(): RepositoryFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-sandbox-source-'))
  temporaryRoots.push(root)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sandbox-source-fixture","private":true}\n')
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"sandbox-source-fixture","lockfileVersion":3}\n')
  fs.writeFileSync(path.join(root, 'src/value.ts'), 'export const value = 1\n')
  git(root, ['init', '--initial-branch=main'])
  git(root, ['add', 'package.json', 'package-lock.json', 'src/value.ts'])
  git(root, ['-c', 'user.name=Sandbox Test', '-c', 'user.email=sandbox@example.invalid', 'commit', '-m', 'baseline'])
  const gitExecutable = fs.realpathSync('/usr/bin/git')
  return Object.freeze({
    root: fs.realpathSync(root),
    baseline: git(root, ['rev-parse', 'HEAD']).trim(),
    gitExecutable,
    gitSha256: crypto.createHash('sha256').update(fs.readFileSync(gitExecutable)).digest('hex'),
  })
}

function options(repository: RepositoryFixture): Parameters<typeof buildSandboxSourcePackage>[0] {
  return {
    workspaceRoot: repository.root,
    implementationBaseline: repository.baseline,
    trustedGitExecutable: repository.gitExecutable,
    trustedGitExecutableSha256: repository.gitSha256,
  }
}

function git(root: string, argumentsValue: readonly string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...argumentsValue], {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: path.parse(root).root,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    } as unknown as NodeJS.ProcessEnv,
  })
}

async function receiptBodyForRequest(request: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>> {
  const sourcePackage = request.sourcePackage as Record<string, unknown>
  const instanceIdentity = 'proof-1234567890abcdef1234567890abcdef'
  const lanes = []
  for (const [index, expected] of SANDBOX_PROOF_COMMANDS.entries()) {
    const stdout = new TextEncoder().encode(`${expected.command}:passed\n`)
    const stderr = new Uint8Array()
    const output = Object.freeze({
      exitCode: 0,
      stdoutBytes: stdout.byteLength,
      stderrBytes: 0,
      stdoutSha256: await sha256Hex(stdout),
      stderrSha256: await sha256Hex(stderr),
      outputTruncated: false,
    })
    lanes.push(Object.freeze({
      taskId: expected.taskId,
      command: expected.command,
      commandSha256: await sha256Hex(expected.command),
      instanceIdentity,
      startedAtMs: 1_100 + index * 200,
      completedAtMs: 1_200 + index * 200,
      ...output,
      outputSha256: await sha256Hex(canonicalJson(output)),
    }))
  }
  const terminationCompletedAtMs = 1_600
  const receiptId = await sha256Hex(canonicalJson({
    nonce: request.nonce,
    packageDigest: sourcePackage.packageDigest,
    instanceIdentity,
    lanes,
    terminationCompletedAtMs,
  }))
  return Object.freeze({
    schema: 'agentic-commerce-sandbox-provision-receipt/v1',
    receiptId,
    sourceFingerprint: sourcePackage.sourceFingerprint,
    sandboxPackageVersion: SANDBOX_PROOF_PACKAGE_VERSION,
    sandboxImage: SANDBOX_PROOF_IMAGE,
    instance: Object.freeze({ provider: 'cloudflare-sandbox', identity: instanceIdentity, provisionedAtMs: 1_000 }),
    browser: Object.freeze({
      engine: 'Chromium',
      version: 151,
      executableSha256: await sha256Hex('chromium'),
      supportedBrowsers: Object.freeze([
        Object.freeze({ name: 'Google Chrome', minimumVersion: 149 }),
        Object.freeze({ name: 'Microsoft Edge', minimumVersion: 150 }),
      ]),
    }),
    lanes: Object.freeze(lanes),
    resourceBounds: SANDBOX_PROOF_BOUNDS,
    termination: Object.freeze({
      instanceIdentity,
      outcome: 'destroyed',
      requestedAtMs: 1_500,
      completedAtMs: terminationCompletedAtMs,
    }),
    issuedAtMs: 1_700,
    expiresAtMs: 3_601_700,
    issuer: request.issuer,
    issuerKeyId: request.issuerKeyId,
  })
}
