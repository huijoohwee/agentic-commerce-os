import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256 } from './evidence-integrity.ts'
import {
  computeAuthoredSourceFingerprint,
  resolveTrustedGitRuntime,
  sameAuthoredSource,
  validAuthoredSourceFingerprint,
  type AuthoredSourceFingerprint,
} from './evidence-source-fingerprint.ts'
export const SANDBOX_PROVISION_RECEIPT_SCHEMA = 'agentic-commerce-sandbox-provision-receipt/v1'
export const SANDBOX_PROVISION_TRUST_ANCHOR_SCHEMA = 'agentic-commerce-sandbox-provision-trust-anchor/v1'
export const SANDBOX_PROVISION_LANES = Object.freeze([
  Object.freeze({ taskId: '12.4' as const, command: 'npm run check:webmcp' }),
  Object.freeze({ taskId: '12.7' as const, command: 'npm run check:browser' }),
])

const MAXIMUM_EXTERNAL_FILE_BYTES = 256 * 1024
const MAXIMUM_LANE_OUTPUT_BYTES = 2 * 1024 * 1024
export type TrustedSandboxProvisionAttestor = Readonly<{
  issuer: string
  keyId: string
  algorithm: 'ed25519'
  publicKeySpkiBase64: string
}>
export type SandboxProvisionTrustAnchor = Readonly<{
  schema: typeof SANDBOX_PROVISION_TRUST_ANCHOR_SCHEMA
  anchorId: string
  implementationBaseline: string
  gitExecutableSha256: string
  maximumReceiptValidityMs: number
  trustedAttestors: readonly TrustedSandboxProvisionAttestor[]
  policyDigest: string
}>
export type SandboxBrowserSupport = Readonly<{ name: string; minimumVersion: number }>
export type SandboxProvisionLane = Readonly<{
  taskId: '12.4' | '12.7'
  command: string
  commandSha256: string
  instanceIdentity: string
  startedAtMs: number
  completedAtMs: number
  exitCode: 0
  stdoutBytes: number
  stderrBytes: number
  stdoutSha256: string
  stderrSha256: string
  outputTruncated: false
  outputSha256: string
}>
export type SandboxProvisionReceipt = Readonly<{
  schema: typeof SANDBOX_PROVISION_RECEIPT_SCHEMA
  receiptId: string
  sourceFingerprint: AuthoredSourceFingerprint
  sandboxPackageVersion: string
  sandboxImage: string
  instance: Readonly<{
    provider: 'cloudflare-sandbox'
    identity: string
    provisionedAtMs: number
  }>
  browser: Readonly<{
    engine: 'Chromium'
    version: number
    executableSha256: string
    supportedBrowsers: readonly SandboxBrowserSupport[]
  }>
  lanes: readonly SandboxProvisionLane[]
  resourceBounds: Readonly<{
    wallClockSeconds: number
    memoryMegabytes: number
    terminationGraceSeconds: number
  }>
  termination: Readonly<{
    instanceIdentity: string
    outcome: 'destroyed'
    requestedAtMs: number
    completedAtMs: number
  }>
  issuedAtMs: number
  expiresAtMs: number
  issuer: string
  issuerKeyId: string
  receiptDigest: string
  signatureAlgorithm: 'ed25519'
  signatureBase64: string
}>
export type SandboxProvisionFindingCode =
  | 'sandbox_provision_receipt_unavailable'
  | 'sandbox_provision_receipt_invalid'
  | 'sandbox_provision_receipt_untrusted'
  | 'sandbox_provision_receipt_stale'
  | 'sandbox_provision_source_mismatch'
  | 'sandbox_provision_runtime_mismatch'
  | 'sandbox_provision_instance_mismatch'
  | 'sandbox_provision_browser_mismatch'
  | 'sandbox_provision_lane_mismatch'
  | 'sandbox_provision_resource_mismatch'
  | 'sandbox_provision_termination_mismatch'
  | 'sandbox_provision_trust_anchor_unavailable'
  | 'sandbox_provision_trusted_git_unavailable'
  | 'sandbox_provision_source_unavailable'
  | 'sandbox_provision_source_changed'
export type SandboxProvisionFinding = Readonly<{
  code: SandboxProvisionFindingCode
  detail: string
}>
export type SandboxProvisionExpected = Readonly<{
  sourceFingerprint: AuthoredSourceFingerprint
  sandboxPackageVersion: string
  sandboxImage: string
  supportedBrowsers: readonly SandboxBrowserSupport[]
  minimumChromiumVersion: number
  resourceBounds: SandboxProvisionReceipt['resourceBounds']
  trustedAttestors: readonly TrustedSandboxProvisionAttestor[]
  maximumReceiptValidityMs: number
  nowMs: number
}>
export type SandboxProvisionVerification = Readonly<{
  ok: boolean
  receipt: SandboxProvisionReceipt | null
  sourceFingerprint: AuthoredSourceFingerprint | null
  trustPolicyDigest: string | null
  findings: readonly SandboxProvisionFinding[]
}>
export function verifySandboxProvisionReceipt(
  value: unknown,
  expected: SandboxProvisionExpected,
): SandboxProvisionVerification {
  if (value === null || value === undefined) {
    return failed('sandbox_provision_receipt_unavailable', 'external provision receipt is absent')
  }
  const receipt = parseSandboxProvisionReceipt(value)
  if (!receipt) return failed('sandbox_provision_receipt_invalid', 'provision receipt fields, digest, or intrinsic proof are invalid')
  const findings: SandboxProvisionFinding[] = []
  if (!sameAuthoredSource(receipt.sourceFingerprint, expected.sourceFingerprint)) {
    findings.push(finding('sandbox_provision_source_mismatch', 'receipt is bound to a different authored-source fingerprint'))
  }
  if (receipt.sandboxPackageVersion !== expected.sandboxPackageVersion
    || receipt.sandboxImage !== expected.sandboxImage) {
    findings.push(finding('sandbox_provision_runtime_mismatch', 'receipt package or image differs from the exact-pinned Sandbox runtime'))
  }
  if (!sameBrowserSupport(receipt.browser.supportedBrowsers, expected.supportedBrowsers)
    || receipt.browser.version < expected.minimumChromiumVersion) {
    findings.push(finding('sandbox_provision_browser_mismatch', 'receipt does not attest the exact browser support set and minimum Chromium harness'))
  }
  if (!sameResourceBounds(receipt.resourceBounds, expected.resourceBounds)) {
    findings.push(finding('sandbox_provision_resource_mismatch', 'receipt resource bounds differ from the source-enforced Sandbox bounds'))
  }
  if (!lanesMatchExpected(receipt.lanes)) {
    findings.push(finding('sandbox_provision_lane_mismatch', 'receipt does not contain exactly the task 12.4 and 12.7 commands'))
  }
  if (!oneInstance(receipt)) {
    findings.push(finding('sandbox_provision_instance_mismatch', 'both lanes were not executed by one provisioned Sandbox identity'))
  }
  if (!terminatedWithinBound(receipt)) {
    findings.push(finding('sandbox_provision_termination_mismatch', 'the single provisioned instance was not destroyed within its bound'))
  }
  if (receipt.issuedAtMs > expected.nowMs || receipt.expiresAtMs < expected.nowMs
    || receipt.expiresAtMs - receipt.issuedAtMs > expected.maximumReceiptValidityMs) {
    findings.push(finding('sandbox_provision_receipt_stale', 'receipt is not current under the externally anchored validity policy'))
  }
  const trusted = expected.trustedAttestors.find(({ issuer, keyId }) => (
    issuer === receipt.issuer && keyId === receipt.issuerKeyId
  ))
  if (!trusted || !verifyReceiptSignature(receipt, trusted)) {
    findings.push(finding('sandbox_provision_receipt_untrusted', 'receipt is not signed by a trusted external provision attestor'))
  }
  return Object.freeze({
    ok: findings.length === 0,
    receipt,
    sourceFingerprint: expected.sourceFingerprint,
    trustPolicyDigest: null,
    findings: Object.freeze(findings),
  })
}
export function verifySandboxProvisionReceiptFiles(options: Readonly<{
  workspaceRoot: string
  receiptPath?: string
  trustAnchorPath?: string
  trustedGitExecutable?: string
  sandboxPackageVersion: string
  sandboxImage: string
  supportedBrowsers: readonly SandboxBrowserSupport[]
  minimumChromiumVersion: number
  resourceBounds: SandboxProvisionReceipt['resourceBounds']
  nowMs?: number
}>): SandboxProvisionVerification {
  const anchorValue = readExternalJson(options.workspaceRoot, options.trustAnchorPath)
  const anchor = parseSandboxProvisionTrustAnchor(anchorValue)
  if (!anchor) return failed('sandbox_provision_trust_anchor_unavailable', 'external Sandbox provision trust anchor is absent or invalid')
  const trustedGit = resolveTrustedGitRuntime(
    options.workspaceRoot,
    options.trustedGitExecutable,
    anchor.gitExecutableSha256,
  )
  if (!trustedGit) return failed('sandbox_provision_trusted_git_unavailable', 'trust anchor does not resolve its exact out-of-workspace Git executable')
  const sourceAtStart = computeAuthoredSourceFingerprint(
    options.workspaceRoot,
    anchor.implementationBaseline,
    trustedGit,
  )
  if (!sourceAtStart) return failed('sandbox_provision_source_unavailable', 'current authored-source fingerprint cannot be computed')
  const receiptValue = readExternalJson(options.workspaceRoot, options.receiptPath)
  if (receiptValue === null) return failed('sandbox_provision_receipt_unavailable', 'external provision receipt is absent or unreadable')
  const verified = verifySandboxProvisionReceipt(receiptValue, {
    sourceFingerprint: sourceAtStart,
    sandboxPackageVersion: options.sandboxPackageVersion,
    sandboxImage: options.sandboxImage,
    supportedBrowsers: options.supportedBrowsers,
    minimumChromiumVersion: options.minimumChromiumVersion,
    resourceBounds: options.resourceBounds,
    trustedAttestors: anchor.trustedAttestors,
    maximumReceiptValidityMs: anchor.maximumReceiptValidityMs,
    nowMs: options.nowMs ?? Date.now(),
  })
  const sourceAtEnd = computeAuthoredSourceFingerprint(
    options.workspaceRoot,
    anchor.implementationBaseline,
    trustedGit,
  )
  const findings = [...verified.findings]
  if (!sameAuthoredSource(sourceAtStart, sourceAtEnd)) {
    findings.push(finding('sandbox_provision_source_changed', 'authored source changed while the provision receipt was evaluated'))
  }
  return Object.freeze({
    ok: findings.length === 0,
    receipt: verified.receipt,
    sourceFingerprint: sourceAtStart,
    trustPolicyDigest: anchor.policyDigest,
    findings: Object.freeze(findings),
  })
}
export function parseSandboxProvisionTrustAnchor(value: unknown): SandboxProvisionTrustAnchor | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schema', 'anchorId', 'implementationBaseline', 'gitExecutableSha256', 'maximumReceiptValidityMs',
    'trustedAttestors', 'policyDigest',
  ]) || value.schema !== SANDBOX_PROVISION_TRUST_ANCHOR_SCHEMA || !digest(value.anchorId)
    || !/^[0-9a-f]{40}$/u.test(String(value.implementationBaseline)) || !digest(value.gitExecutableSha256)
    || !safeInteger(value.maximumReceiptValidityMs, 1, 86_400_000) || !digest(value.policyDigest)) return null
  const trustedAttestors = parseTrustedAttestors(value.trustedAttestors)
  if (!trustedAttestors || trustedAttestors.length === 0) return null
  const body = Object.freeze({
    schema: SANDBOX_PROVISION_TRUST_ANCHOR_SCHEMA,
    anchorId: String(value.anchorId),
    implementationBaseline: String(value.implementationBaseline),
    gitExecutableSha256: String(value.gitExecutableSha256),
    maximumReceiptValidityMs: Number(value.maximumReceiptValidityMs),
    trustedAttestors,
  })
  if (sha256(canonicalJson(body)) !== value.policyDigest) return null
  return Object.freeze({ ...body, policyDigest: String(value.policyDigest) })
}
export function parseSandboxProvisionReceipt(value: unknown): SandboxProvisionReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schema', 'receiptId', 'sourceFingerprint', 'sandboxPackageVersion', 'sandboxImage', 'instance',
    'browser', 'lanes', 'resourceBounds', 'termination', 'issuedAtMs', 'expiresAtMs', 'issuer',
    'issuerKeyId', 'receiptDigest', 'signatureAlgorithm', 'signatureBase64',
  ]) || value.schema !== SANDBOX_PROVISION_RECEIPT_SCHEMA || !digest(value.receiptId)
    || !validAuthoredSourceFingerprint(value.sourceFingerprint) || !version(value.sandboxPackageVersion)
    || !bounded(value.sandboxImage) || !validInstance(value.instance) || !validBrowser(value.browser)
    || !validResourceBounds(value.resourceBounds) || !validTermination(value.termination)
    || !safeInteger(value.issuedAtMs, 1) || !safeInteger(value.expiresAtMs, Number(value.issuedAtMs) + 1)
    || !namedIdentity(value.issuer) || !namedIdentity(value.issuerKeyId) || !digest(value.receiptDigest)
    || value.signatureAlgorithm !== 'ed25519' || !canonicalBase64(value.signatureBase64)) return null
  const lanes = parseLanes(value.lanes)
  if (!lanes) return null
  const instance = value.instance as Record<string, unknown>
  const browser = value.browser as Record<string, unknown>
  const resourceBounds = value.resourceBounds as Record<string, unknown>
  const termination = value.termination as Record<string, unknown>
  const receipt: SandboxProvisionReceipt = Object.freeze({
    schema: SANDBOX_PROVISION_RECEIPT_SCHEMA,
    receiptId: String(value.receiptId),
    sourceFingerprint: value.sourceFingerprint,
    sandboxPackageVersion: String(value.sandboxPackageVersion),
    sandboxImage: String(value.sandboxImage),
    instance: Object.freeze({
      provider: 'cloudflare-sandbox',
      identity: String(instance.identity),
      provisionedAtMs: Number(instance.provisionedAtMs),
    }),
    browser: Object.freeze({
      engine: 'Chromium',
      version: Number(browser.version),
      executableSha256: String(browser.executableSha256),
      supportedBrowsers: Object.freeze((browser.supportedBrowsers as SandboxBrowserSupport[]).map((support) => Object.freeze({
        name: String(support.name),
        minimumVersion: Number(support.minimumVersion),
      }))),
    }),
    lanes,
    resourceBounds: Object.freeze({
      wallClockSeconds: Number(resourceBounds.wallClockSeconds),
      memoryMegabytes: Number(resourceBounds.memoryMegabytes),
      terminationGraceSeconds: Number(resourceBounds.terminationGraceSeconds),
    }),
    termination: Object.freeze({
      instanceIdentity: String(termination.instanceIdentity),
      outcome: 'destroyed',
      requestedAtMs: Number(termination.requestedAtMs),
      completedAtMs: Number(termination.completedAtMs),
    }),
    issuedAtMs: Number(value.issuedAtMs),
    expiresAtMs: Number(value.expiresAtMs),
    issuer: String(value.issuer),
    issuerKeyId: String(value.issuerKeyId),
    receiptDigest: String(value.receiptDigest),
    signatureAlgorithm: 'ed25519',
    signatureBase64: String(value.signatureBase64),
  })
  if (!validReceiptTimeline(receipt) || sha256(canonicalJson(unsignedSandboxProvisionReceipt(receipt))) !== receipt.receiptDigest) {
    return null
  }
  return receipt
}
export function unsignedSandboxProvisionReceipt(receipt: SandboxProvisionReceipt): Readonly<Omit<
  SandboxProvisionReceipt,
  'receiptDigest' | 'signatureAlgorithm' | 'signatureBase64'
>> {
  const { receiptDigest: _digest, signatureAlgorithm: _algorithm, signatureBase64: _signature, ...body } = receipt
  return Object.freeze(body)
}
export function sandboxLaneOutputSha256(lane: Readonly<{
  exitCode: number
  stdoutBytes: number
  stderrBytes: number
  stdoutSha256: string
  stderrSha256: string
  outputTruncated: boolean
}>): string {
  return sha256(canonicalJson({
    exitCode: lane.exitCode,
    stdoutBytes: lane.stdoutBytes,
    stderrBytes: lane.stderrBytes,
    stdoutSha256: lane.stdoutSha256,
    stderrSha256: lane.stderrSha256,
    outputTruncated: lane.outputTruncated,
  }))
}
function parseLanes(value: unknown): readonly SandboxProvisionLane[] | null {
  if (!Array.isArray(value) || value.length !== SANDBOX_PROVISION_LANES.length) return null
  const lanes: SandboxProvisionLane[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      'taskId', 'command', 'commandSha256', 'instanceIdentity', 'startedAtMs', 'completedAtMs', 'exitCode',
      'stdoutBytes', 'stderrBytes', 'stdoutSha256', 'stderrSha256', 'outputTruncated', 'outputSha256',
    ]) || (candidate.taskId !== '12.4' && candidate.taskId !== '12.7') || !bounded(candidate.command)
      || candidate.commandSha256 !== sha256(String(candidate.command)) || !instanceIdentity(candidate.instanceIdentity)
      || !safeInteger(candidate.startedAtMs, 1) || !safeInteger(candidate.completedAtMs, Number(candidate.startedAtMs))
      || candidate.exitCode !== 0 || !safeInteger(candidate.stdoutBytes, 1, MAXIMUM_LANE_OUTPUT_BYTES)
      || !safeInteger(candidate.stderrBytes, 0, MAXIMUM_LANE_OUTPUT_BYTES)
      || Number(candidate.stdoutBytes) + Number(candidate.stderrBytes) > MAXIMUM_LANE_OUTPUT_BYTES
      || !digest(candidate.stdoutSha256) || !digest(candidate.stderrSha256) || candidate.outputTruncated !== false
      || !digest(candidate.outputSha256) || candidate.outputSha256 !== sandboxLaneOutputSha256({
        exitCode: 0,
        stdoutBytes: Number(candidate.stdoutBytes),
        stderrBytes: Number(candidate.stderrBytes),
        stdoutSha256: String(candidate.stdoutSha256),
        stderrSha256: String(candidate.stderrSha256),
        outputTruncated: false,
      })) return null
    lanes.push(Object.freeze({
      taskId: candidate.taskId,
      command: String(candidate.command),
      commandSha256: String(candidate.commandSha256),
      instanceIdentity: String(candidate.instanceIdentity),
      startedAtMs: Number(candidate.startedAtMs),
      completedAtMs: Number(candidate.completedAtMs),
      exitCode: 0,
      stdoutBytes: Number(candidate.stdoutBytes),
      stderrBytes: Number(candidate.stderrBytes),
      stdoutSha256: String(candidate.stdoutSha256),
      stderrSha256: String(candidate.stderrSha256),
      outputTruncated: false,
      outputSha256: String(candidate.outputSha256),
    }))
  }
  return Object.freeze(lanes)
}

function validInstance(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['provider', 'identity', 'provisionedAtMs'])
    && value.provider === 'cloudflare-sandbox' && instanceIdentity(value.identity)
    && safeInteger(value.provisionedAtMs, 1)
}

function validBrowser(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['engine', 'version', 'executableSha256', 'supportedBrowsers'])
    || value.engine !== 'Chromium' || !safeInteger(value.version, 1) || !digest(value.executableSha256)
    || !Array.isArray(value.supportedBrowsers) || value.supportedBrowsers.length < 1) return false
  const names = new Set<string>()
  let prior = ''
  for (const support of value.supportedBrowsers) {
    if (!isRecord(support) || !hasExactKeys(support, ['name', 'minimumVersion']) || !bounded(support.name)
      || !safeInteger(support.minimumVersion, 1) || names.has(String(support.name))
      || prior.localeCompare(String(support.name)) >= 0) return false
    names.add(String(support.name))
    prior = String(support.name)
  }
  return true
}

function validResourceBounds(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['wallClockSeconds', 'memoryMegabytes', 'terminationGraceSeconds'])
    && safeInteger(value.wallClockSeconds, 1, 300) && safeInteger(value.memoryMegabytes, 1, 512)
    && safeInteger(value.terminationGraceSeconds, 1, 5)
}

function validTermination(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['instanceIdentity', 'outcome', 'requestedAtMs', 'completedAtMs'])
    && instanceIdentity(value.instanceIdentity) && value.outcome === 'destroyed'
    && safeInteger(value.requestedAtMs, 1) && safeInteger(value.completedAtMs, Number(value.requestedAtMs))
}

function validReceiptTimeline(receipt: SandboxProvisionReceipt): boolean {
  const finalLaneAt = Math.max(...receipt.lanes.map(({ completedAtMs }) => completedAtMs))
  return receipt.lanes.every(({ startedAtMs, completedAtMs }) => (
    startedAtMs >= receipt.instance.provisionedAtMs
    && completedAtMs - startedAtMs <= receipt.resourceBounds.wallClockSeconds * 1_000
  )) && receipt.termination.requestedAtMs >= finalLaneAt
    && receipt.termination.completedAtMs <= receipt.issuedAtMs
}

function lanesMatchExpected(lanes: readonly SandboxProvisionLane[]): boolean {
  return lanes.every((lane, index) => {
    const expected = SANDBOX_PROVISION_LANES[index]
    return expected?.taskId === lane.taskId && expected.command === lane.command
  })
}

function oneInstance(receipt: SandboxProvisionReceipt): boolean {
  return receipt.lanes.every(({ instanceIdentity: identity }) => identity === receipt.instance.identity)
    && receipt.termination.instanceIdentity === receipt.instance.identity
}

function terminatedWithinBound(receipt: SandboxProvisionReceipt): boolean {
  return receipt.termination.outcome === 'destroyed'
    && receipt.termination.completedAtMs - receipt.termination.requestedAtMs
      <= receipt.resourceBounds.terminationGraceSeconds * 1_000
}

function sameBrowserSupport(left: readonly SandboxBrowserSupport[], right: readonly SandboxBrowserSupport[]): boolean {
  return canonicalJson(left) === canonicalJson([...right].sort((a, b) => a.name.localeCompare(b.name)))
}

function sameResourceBounds(
  left: SandboxProvisionReceipt['resourceBounds'],
  right: SandboxProvisionReceipt['resourceBounds'],
): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function parseTrustedAttestors(value: unknown): readonly TrustedSandboxProvisionAttestor[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null
  const attestors: TrustedSandboxProvisionAttestor[] = []
  let prior = ''
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['issuer', 'keyId', 'algorithm', 'publicKeySpkiBase64'])
      || !namedIdentity(candidate.issuer) || !namedIdentity(candidate.keyId) || candidate.algorithm !== 'ed25519'
      || !canonicalBase64(candidate.publicKeySpkiBase64) || !validEd25519Key(candidate.publicKeySpkiBase64)) return null
    const identity = `${String(candidate.issuer)}\0${String(candidate.keyId)}`
    if (identity.localeCompare(prior) <= 0) return null
    prior = identity
    attestors.push(Object.freeze({
      issuer: String(candidate.issuer),
      keyId: String(candidate.keyId),
      algorithm: 'ed25519',
      publicKeySpkiBase64: String(candidate.publicKeySpkiBase64),
    }))
  }
  return Object.freeze(attestors)
}

function verifyReceiptSignature(receipt: SandboxProvisionReceipt, trusted: TrustedSandboxProvisionAttestor): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(trusted.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return publicKey.asymmetricKeyType === 'ed25519' && crypto.verify(
      null,
      Buffer.from(canonicalJson(unsignedSandboxProvisionReceipt(receipt))),
      publicKey,
      Buffer.from(receipt.signatureBase64, 'base64'),
    )
  } catch {
    return false
  }
}

function readExternalJson(workspaceRoot: string, requested: string | undefined): unknown | null {
  if (!requested || !path.isAbsolute(requested) || requested.includes('\0')) return null
  let descriptor: number | null = null
  try {
    const workspace = fs.realpathSync(path.resolve(workspaceRoot))
    const requestedPath = path.resolve(requested)
    const initial = fs.lstatSync(requestedPath, { bigint: true })
    const real = fs.realpathSync(requestedPath)
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || within(workspace, real)
      || initial.size < 1n || initial.size > BigInt(MAXIMUM_EXTERNAL_FILE_BYTES)) return null
    descriptor = fs.openSync(requestedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!sameStableFile(initial, opened)) return null
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (read === 0) return null
      offset += read
    }
    if (!sameStableFile(opened, fs.fstatSync(descriptor, { bigint: true }))) return null
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return null
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
}

function validEd25519Key(value: string): boolean {
  try {
    return crypto.createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

function failed(code: SandboxProvisionFindingCode, detail: string): SandboxProvisionVerification {
  return Object.freeze({
    ok: false,
    receipt: null,
    sourceFingerprint: null,
    trustPolicyDigest: null,
    findings: Object.freeze([finding(code, detail)]),
  })
}

function finding(code: SandboxProvisionFindingCode, detail: string): SandboxProvisionFinding {
  return Object.freeze({ code, detail })
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function version(value: unknown): boolean {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 280
}

function namedIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)
}

function instanceIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(value)
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  try {
    return Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
