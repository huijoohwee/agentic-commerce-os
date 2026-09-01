import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { parseSandboxProvisionReceipt } from '../../scripts/sandbox-provision-receipt.ts'
import {
  canonicalJson,
  MAXIMUM_SANDBOX_SOURCE_BYTES,
  parseSandboxProofRequest,
  parseSandboxSourcePackage,
  SANDBOX_PROOF_COMMANDS,
  SANDBOX_PROOF_REQUEST_SCHEMA,
  SANDBOX_SOURCE_PACKAGE_SCHEMA,
  sha256Hex,
  sourceTreeSha256,
  validSandboxSourcePath,
  type SandboxSourceEntry,
  type SandboxSourcePackage,
} from '../../src/sandbox/provision-contract.ts'
import {
  handleSandboxProofRequest,
  type SandboxProofRuntime,
} from '../../src/sandbox/provision.ts'

const TOKEN = 'a'.repeat(64)
const INSTANCE_IDENTITY = `proof-${'b'.repeat(32)}`

describe('Sandbox live proof contract', () => {
  it('accepts one digest-bound package that exactly reproduces its authored-source tree', async () => {
    const sourcePackage = await packageFixture()
    await expect(parseSandboxSourcePackage(sourcePackage)).resolves.toEqual(sourcePackage)
    expect(sourcePackage.entries.map(({ path }) => path)).toEqual(['package-lock.json', 'package.json'])
  })

  it.each([
    '../escape.ts',
    '/absolute.ts',
    'nested\\windows.ts',
    '.git/config',
    'node_modules/poison/index.js',
    'docs/evidence-verdicts/forged.json',
    '.env',
    '.dev.vars',
    '.npmrc',
    'secrets/private.pem',
  ])('rejects unsafe package path %s', (candidate) => {
    expect(validSandboxSourcePath(candidate)).toBe(false)
  })

  it('rejects traversal, size, digest, and caller-command mutations', async () => {
    const sourcePackage = await packageFixture()
    const first = sourcePackage.entries[0]!
    const traversal = await resignPackage(sourcePackage, [
      { ...first, path: '../package-lock.json' },
      sourcePackage.entries[1]!,
    ])
    const badSize = { ...sourcePackage, totalFileBytes: MAXIMUM_SANDBOX_SOURCE_BYTES + 1 }
    const badDigest = { ...sourcePackage, packageDigest: 'f'.repeat(64) }
    const request = requestFixture(sourcePackage)

    await expect(parseSandboxSourcePackage(traversal)).resolves.toBeNull()
    await expect(parseSandboxSourcePackage(badSize)).resolves.toBeNull()
    await expect(parseSandboxSourcePackage(badDigest)).resolves.toBeNull()
    await expect(parseSandboxProofRequest({ ...request, command: 'rm -rf /' })).resolves.toBeNull()
  })

  it('fails closed before provisioning when authentication is absent or wrong', async () => {
    const sourcePackage = await packageFixture()
    const createSandbox = vi.fn()
    for (const authorization of [undefined, 'Bearer wrong']) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (authorization) headers.authorization = authorization
      const response = await handleSandboxProofRequest(new Request('https://proof.example/v1/provision-proof', {
        method: 'POST', headers, body: canonicalJson(requestFixture(sourcePackage)),
      }), environment(), { createSandbox })
      expect(response.status).toBe(401)
    }
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('runs only the immutable setup and task commands in one instance, then destroys it', async () => {
    const sourcePackage = await packageFixture()
    const runtime = runtimeFixture(sourcePackage)
    const response = await handleSandboxProofRequest(proofRequest(requestFixture(sourcePackage)), environment(), {
      createSandbox: (_namespace, identity) => {
        expect(identity).toBe(INSTANCE_IDENTITY)
        return runtime
      },
      createInstanceIdentity: () => INSTANCE_IDENTITY,
      now: monotonicClock(),
    })
    const result = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(result).toMatchObject({ ok: true, schema: 'agentic-commerce-sandbox-unsigned-proof/v1' })
    expect(runtime.exec.mock.calls.map(([command]) => command)).toEqual([
      expect.stringMatching(/^node \/tmp\/ag-proof-[a-z0-9]+-harness\.mjs$/u),
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm run check:webmcp',
      'npm run check:browser',
      expect.stringMatching(/^node \/tmp\/ag-proof-[a-z0-9]+-harness\.mjs$/u),
    ])
    expect(runtime.destroy).toHaveBeenCalledOnce()
    const receipt = result.receiptBody as Record<string, unknown>
    expect(receipt).toMatchObject({
      sourceFingerprint: sourcePackage.sourceFingerprint,
      instance: { provider: 'cloudflare-sandbox', identity: INSTANCE_IDENTITY },
      termination: { outcome: 'destroyed', instanceIdentity: INSTANCE_IDENTITY },
      issuer: 'sandbox-provision-controller',
      issuerKeyId: 'sandbox-provision-key-1',
    })
    expect((receipt.lanes as Array<Record<string, unknown>>).map(({ taskId, command }) => ({ taskId, command })))
      .toEqual(SANDBOX_PROOF_COMMANDS)
    expect(result.receiptDigest).toBe(await sha256Hex(canonicalJson(receipt)))
    expect(parseSandboxProvisionReceipt({
      ...receipt,
      receiptDigest: result.receiptDigest,
      signatureAlgorithm: 'ed25519',
      signatureBase64: 'AAAA',
    })).not.toBeNull()
  })

  it('destroys the instance and emits no receipt when either exact lane fails', async () => {
    const sourcePackage = await packageFixture()
    const runtime = runtimeFixture(sourcePackage, { failingCommand: 'npm run check:browser' })
    const response = await handleSandboxProofRequest(proofRequest(requestFixture(sourcePackage)), environment(), {
      createSandbox: () => runtime,
      createInstanceIdentity: () => INSTANCE_IDENTITY,
      now: monotonicClock(),
    })
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ ok: false, code: 'sandbox_proof_lane_12_7_failed' })
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('rejects a request-supplied command without creating a Sandbox', async () => {
    const sourcePackage = await packageFixture()
    const createSandbox = vi.fn()
    const response = await handleSandboxProofRequest(proofRequest({
      ...requestFixture(sourcePackage),
      commands: ['npm run attacker-controlled'],
    }), environment(), { createSandbox })
    expect(response.status).toBe(400)
    expect(createSandbox).not.toHaveBeenCalled()
  })
})

async function packageFixture(): Promise<SandboxSourcePackage> {
  const entries = Object.freeze([
    await entry('package-lock.json', '{"lockfileVersion":3}'),
    await entry('package.json', '{"devDependencies":{"@playwright/test":"1.62.1"}}'),
  ])
  const fingerprintBody = Object.freeze({
    schema: 'agentic-commerce-authored-source-fingerprint/v1' as const,
    implementationBaseline: '0'.repeat(40),
    headRevision: '1'.repeat(40),
    authoredFileCount: entries.length,
    authoredTreeSha256: await sourceTreeSha256(entries),
  })
  const sourceFingerprint = Object.freeze({
    ...fingerprintBody,
    fingerprintDigest: await sha256Hex(canonicalJson(fingerprintBody)),
  })
  const body = Object.freeze({
    schema: SANDBOX_SOURCE_PACKAGE_SCHEMA,
    sourceFingerprint,
    entries,
    totalFileBytes: entries.reduce((sum, candidate) => sum + candidate.size, 0),
  })
  return Object.freeze({ ...body, packageDigest: await sha256Hex(canonicalJson(body)) })
}

async function resignPackage(
  sourcePackage: SandboxSourcePackage,
  entries: readonly SandboxSourceEntry[],
): Promise<SandboxSourcePackage> {
  const body = Object.freeze({
    schema: SANDBOX_SOURCE_PACKAGE_SCHEMA,
    sourceFingerprint: sourcePackage.sourceFingerprint,
    entries: Object.freeze(entries),
    totalFileBytes: entries.reduce((sum, candidate) => sum + candidate.size, 0),
  })
  return Object.freeze({ ...body, packageDigest: await sha256Hex(canonicalJson(body)) })
}

async function entry(path: string, content: string): Promise<SandboxSourceEntry> {
  const bytes = new TextEncoder().encode(content)
  return Object.freeze({
    path,
    kind: 'file',
    mode: '100644',
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    contentBase64: Buffer.from(bytes).toString('base64'),
  })
}

function requestFixture(sourcePackage: SandboxSourcePackage): Record<string, unknown> {
  return {
    schema: SANDBOX_PROOF_REQUEST_SCHEMA,
    nonce: 'c'.repeat(64),
    issuer: 'sandbox-provision-controller',
    issuerKeyId: 'sandbox-provision-key-1',
    validityMs: 3_600_000,
    sourcePackage,
  }
}

function proofRequest(body: unknown): Request {
  return new Request('https://proof.example/v1/provision-proof', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: canonicalJson(body),
  })
}

function environment(): Parameters<typeof handleSandboxProofRequest>[1] {
  return {
    Sandbox: {} as Parameters<typeof handleSandboxProofRequest>[1]['Sandbox'],
    SANDBOX_PROOF_BEARER_TOKEN: TOKEN,
  }
}

type FakeRuntime = SandboxProofRuntime & {
  exec: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function runtimeFixture(
  sourcePackage: SandboxSourcePackage,
  options: Readonly<{ failingCommand?: string }> = {},
): FakeRuntime {
  return {
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => ({
      content: path.includes('-extract.json')
        ? JSON.stringify({
          ok: true,
          mode: 'extract',
          packageDigest: sourcePackage.packageDigest,
          sourceFingerprintDigest: sourcePackage.sourceFingerprint.fingerprintDigest,
        })
        : JSON.stringify({
          ok: true,
          mode: 'inspect',
          nodeVersion: '22.22.3',
          playwrightVersion: '1.62.1',
          browser: {
            engine: 'Chromium',
            version: 151,
            executableSha256: 'd'.repeat(64),
            supportedBrowsers: [
              { name: 'Google Chrome', minimumVersion: 149 },
              { name: 'Microsoft Edge', minimumVersion: 150 },
            ],
          },
        }),
    })),
    exec: vi.fn(async (command: string) => ({
      success: command !== options.failingCommand,
      exitCode: command === options.failingCommand ? 1 : 0,
      stdout: command.startsWith('npm run check:') ? `${command}:passed\n` : 'ok\n',
      stderr: '',
    })),
    destroy: vi.fn(async () => undefined),
  }
}

function monotonicClock(): () => number {
  let current = Date.UTC(2026, 7, 30)
  return () => current += 100
}
