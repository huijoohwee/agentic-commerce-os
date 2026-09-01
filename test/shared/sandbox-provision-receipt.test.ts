import crypto, { type KeyObject } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { canonicalJson, sha256 } from '../../scripts/evidence-integrity.ts'
import { AUTHORED_SOURCE_FINGERPRINT_SCHEMA, type AuthoredSourceFingerprint } from '../../scripts/evidence-source-fingerprint.ts'
import {
  parseSandboxProvisionReceipt,
  parseSandboxProvisionTrustAnchor,
  SANDBOX_PROVISION_RECEIPT_SCHEMA,
  SANDBOX_PROVISION_TRUST_ANCHOR_SCHEMA,
  sandboxLaneOutputSha256,
  unsignedSandboxProvisionReceipt,
  verifySandboxProvisionReceipt,
  type SandboxProvisionExpected,
  type SandboxProvisionLane,
  type SandboxProvisionReceipt,
  type TrustedSandboxProvisionAttestor,
} from '../../scripts/sandbox-provision-receipt.ts'

type ReceiptBody = Omit<SandboxProvisionReceipt, 'receiptDigest' | 'signatureAlgorithm' | 'signatureBase64'>

const AUTHORITY = crypto.generateKeyPairSync('ed25519')
const OTHER_AUTHORITY = crypto.generateKeyPairSync('ed25519')
const INSTANCE_IDENTITY = 'sandbox-proof-instance-1'
const NOW_MS = 2_000
const SOURCE_FINGERPRINT = sourceFingerprint('a')
const SUPPORTED_BROWSERS = Object.freeze([
  Object.freeze({ name: 'Google Chrome', minimumVersion: 149 }),
  Object.freeze({ name: 'Microsoft Edge', minimumVersion: 150 }),
])
const RESOURCE_BOUNDS = Object.freeze({
  wallClockSeconds: 300,
  memoryMegabytes: 256,
  terminationGraceSeconds: 5,
})

describe('provisioned Sandbox receipt', () => {
  it('accepts one externally signed, source-bound instance for both exact lanes', () => {
    const result = verifySandboxProvisionReceipt(signedReceipt(), expected())

    expect(result).toMatchObject({ ok: true, findings: [] })
    expect(result.receipt?.lanes.map(({ taskId, command }) => ({ taskId, command }))).toEqual([
      { taskId: '12.4', command: 'npm run check:webmcp' },
      { taskId: '12.7', command: 'npm run check:browser' },
    ])
    expect(result.receipt?.termination).toMatchObject({
      instanceIdentity: INSTANCE_IDENTITY,
      outcome: 'destroyed',
    })
  })

  it('fails closed when the external receipt is absent', () => {
    expect(verifySandboxProvisionReceipt(undefined, expected())).toMatchObject({
      ok: false,
      receipt: null,
      findings: [{ code: 'sandbox_provision_receipt_unavailable' }],
    })
  })

  it('rejects a valid signature bound to a different source fingerprint', () => {
    const result = verifySandboxProvisionReceipt(signedReceipt(), {
      ...expected(),
      sourceFingerprint: sourceFingerprint('b'),
    })
    expect(result).toMatchObject({
      ok: false,
      findings: [{ code: 'sandbox_provision_source_mismatch' }],
    })
  })

  it('rejects runtime, support-set, resource, lane, instance, termination, and freshness drift', () => {
    const base = signedReceipt()
    const body = unsignedSandboxProvisionReceipt(base)
    const wrongLane = resign({
      ...body,
      lanes: Object.freeze([
        lane('12.4', 'npm run check:not-webmcp', INSTANCE_IDENTITY, 1_100, 1_200),
        body.lanes[1] as SandboxProvisionLane,
      ]),
    })
    const wrongInstance = resign({
      ...body,
      lanes: Object.freeze([
        { ...(body.lanes[0] as SandboxProvisionLane), instanceIdentity: 'sandbox-proof-instance-2' },
        body.lanes[1] as SandboxProvisionLane,
      ]),
    })
    const slowTermination = resign({
      ...body,
      termination: Object.freeze({
        ...body.termination,
        completedAtMs: 7_000,
      }),
      issuedAtMs: 7_100,
      expiresAtMs: 10_000,
    })

    expect(verifySandboxProvisionReceipt(base, { ...expected(), sandboxPackageVersion: '0.12.8' }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'sandbox_provision_runtime_mismatch' })]))
    expect(verifySandboxProvisionReceipt(base, {
      ...expected(), supportedBrowsers: [{ name: 'Google Chrome', minimumVersion: 149 }],
    }).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_browser_mismatch' }),
    ]))
    expect(verifySandboxProvisionReceipt(base, {
      ...expected(), resourceBounds: { ...RESOURCE_BOUNDS, wallClockSeconds: 299 },
    }).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_resource_mismatch' }),
    ]))
    expect(verifySandboxProvisionReceipt(wrongLane, expected()).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_lane_mismatch' }),
    ]))
    expect(verifySandboxProvisionReceipt(wrongInstance, expected()).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_instance_mismatch' }),
    ]))
    expect(verifySandboxProvisionReceipt(slowTermination, expected()).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_termination_mismatch' }),
    ]))
    expect(verifySandboxProvisionReceipt(base, { ...expected(), nowMs: 10_001 }).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_receipt_stale' }),
    ]))
  })

  it('rejects command and output digests that do not describe the attested lane', () => {
    const body = unsignedSandboxProvisionReceipt(signedReceipt())
    const first = body.lanes[0] as SandboxProvisionLane
    const commandMismatch = resign({
      ...body,
      lanes: Object.freeze([{ ...first, commandSha256: sha256('different-command') }, body.lanes[1] as SandboxProvisionLane]),
    })
    const outputMismatch = resign({
      ...body,
      lanes: Object.freeze([{ ...first, stdoutSha256: sha256('different-output') }, body.lanes[1] as SandboxProvisionLane]),
    })

    expect(parseSandboxProvisionReceipt(commandMismatch)).toBeNull()
    expect(parseSandboxProvisionReceipt(outputMismatch)).toBeNull()
  })

  it('rejects a receipt not signed by the externally trusted attestor', () => {
    const result = verifySandboxProvisionReceipt(signedReceipt(), {
      ...expected(),
      trustedAttestors: [attestor(OTHER_AUTHORITY.publicKey)],
    })
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sandbox_provision_receipt_untrusted' }),
    ]))
  })

  it('accepts only a digest-bound trust policy with a real Ed25519 public key', () => {
    const body = Object.freeze({
      schema: SANDBOX_PROVISION_TRUST_ANCHOR_SCHEMA,
      anchorId: sha256('sandbox-provision-anchor'),
      implementationBaseline: '0'.repeat(40),
      gitExecutableSha256: sha256('trusted-git-binary'),
      maximumReceiptValidityMs: 86_400_000,
      trustedAttestors: Object.freeze([attestor(AUTHORITY.publicKey)]),
    })
    const anchor = Object.freeze({ ...body, policyDigest: sha256(canonicalJson(body)) })

    expect(parseSandboxProvisionTrustAnchor(anchor)).toEqual(anchor)
    expect(parseSandboxProvisionTrustAnchor({ ...anchor, maximumReceiptValidityMs: 86_399_999 })).toBeNull()
  })
})

function expected(): SandboxProvisionExpected {
  return Object.freeze({
    sourceFingerprint: SOURCE_FINGERPRINT,
    sandboxPackageVersion: '0.12.9',
    sandboxImage: 'docker.io/cloudflare/sandbox:0.12.9',
    supportedBrowsers: SUPPORTED_BROWSERS,
    minimumChromiumVersion: 151,
    resourceBounds: RESOURCE_BOUNDS,
    trustedAttestors: Object.freeze([attestor(AUTHORITY.publicKey)]),
    maximumReceiptValidityMs: 86_400_000,
    nowMs: NOW_MS,
  })
}

function signedReceipt(): SandboxProvisionReceipt {
  return resign(Object.freeze({
    schema: SANDBOX_PROVISION_RECEIPT_SCHEMA,
    receiptId: sha256('sandbox-provision-receipt'),
    sourceFingerprint: SOURCE_FINGERPRINT,
    sandboxPackageVersion: '0.12.9',
    sandboxImage: 'docker.io/cloudflare/sandbox:0.12.9',
    instance: Object.freeze({
      provider: 'cloudflare-sandbox',
      identity: INSTANCE_IDENTITY,
      provisionedAtMs: 1_000,
    }),
    browser: Object.freeze({
      engine: 'Chromium',
      version: 151,
      executableSha256: sha256('chromium-binary'),
      supportedBrowsers: SUPPORTED_BROWSERS,
    }),
    lanes: Object.freeze([
      lane('12.4', 'npm run check:webmcp', INSTANCE_IDENTITY, 1_100, 1_200),
      lane('12.7', 'npm run check:browser', INSTANCE_IDENTITY, 1_300, 1_400),
    ]),
    resourceBounds: RESOURCE_BOUNDS,
    termination: Object.freeze({
      instanceIdentity: INSTANCE_IDENTITY,
      outcome: 'destroyed',
      requestedAtMs: 1_500,
      completedAtMs: 1_600,
    }),
    issuedAtMs: 1_700,
    expiresAtMs: 10_000,
    issuer: 'sandbox-provision-controller',
    issuerKeyId: 'sandbox-provision-key-1',
  }))
}

function lane(
  taskId: SandboxProvisionLane['taskId'],
  command: string,
  instanceIdentity: string,
  startedAtMs: number,
  completedAtMs: number,
): SandboxProvisionLane {
  const output = Object.freeze({
    exitCode: 0,
    stdoutBytes: 24,
    stderrBytes: 0,
    stdoutSha256: sha256(`passing-output:${taskId}`),
    stderrSha256: sha256(''),
    outputTruncated: false,
  })
  return Object.freeze({
    taskId,
    command,
    commandSha256: sha256(command),
    instanceIdentity,
    startedAtMs,
    completedAtMs,
    ...output,
    outputSha256: sandboxLaneOutputSha256(output),
  })
}

function resign(body: ReceiptBody, privateKey = AUTHORITY.privateKey): SandboxProvisionReceipt {
  const provisional: SandboxProvisionReceipt = Object.freeze({
    ...body,
    receiptDigest: sha256(canonicalJson(body)),
    signatureAlgorithm: 'ed25519',
    signatureBase64: '',
  })
  return Object.freeze({
    ...provisional,
    signatureBase64: Buffer.from(crypto.sign(
      null,
      Buffer.from(canonicalJson(unsignedSandboxProvisionReceipt(provisional))),
      privateKey,
    )).toString('base64'),
  })
}

function sourceFingerprint(seed: string): AuthoredSourceFingerprint {
  const body = Object.freeze({
    schema: AUTHORED_SOURCE_FINGERPRINT_SCHEMA,
    implementationBaseline: '0'.repeat(40),
    headRevision: '1'.repeat(40),
    authoredFileCount: 1,
    authoredTreeSha256: seed.repeat(64),
  })
  return Object.freeze({ ...body, fingerprintDigest: sha256(canonicalJson(body)) })
}

function attestor(publicKey: KeyObject): TrustedSandboxProvisionAttestor {
  return Object.freeze({
    issuer: 'sandbox-provision-controller',
    keyId: 'sandbox-provision-key-1',
    algorithm: 'ed25519',
    publicKeySpkiBase64: Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
  })
}
