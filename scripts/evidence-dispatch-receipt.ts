import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { canonicalJson, sha256 } from './evidence-integrity.ts'
import {
  sameAuthoredSource,
  validAuthoredSourceFingerprint,
  type AuthoredSourceFingerprint,
} from './evidence-source-fingerprint.ts'

export const EVIDENCE_DISPATCH_RECEIPT_SCHEMA = 'agentic-commerce-evidence-dispatch-receipt/v1'
export const EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA = 'agentic-commerce-evidence-dispatch-trust-anchor/v1'
export const EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA = 'agentic-commerce-evidence-artifact-sink-authority/v1'

export type EvidenceArtifactSinkAuthority = Readonly<{
  schema: typeof EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA
  workspaceRootRealPath: string
  artifactRootRealPath: string
  exclusiveEvaluatorAccess: true
  stableAncestry: true
}>

export type TrustedDispatchIssuer = Readonly<{
  issuer: string
  keyId: string
  algorithm: 'ed25519'
  publicKeySpkiBase64: string
}>

export type EvidenceDispatchReceipt = Readonly<{
  schema: typeof EVIDENCE_DISPATCH_RECEIPT_SCHEMA
  receiptId: string
  taskId: string
  performingMechanism: string
  performerPublicKeySpkiBase64: string
  sourceFingerprint: AuthoredSourceFingerprint
  semanticScope: string
  declaredWriteSet: readonly string[]
  claimId: string
  leaseEpoch: number
  fenceRevision: string
  issuer: string
  issuerKeyId: string
  issuedAtMs: number
  receiptDigest: string
  signatureAlgorithm: 'ed25519'
  signatureBase64: string
}>

export type EvidenceDispatchTrustAnchor = Readonly<{
  schema: typeof EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA
  anchorId: string
  verificationBaselineSha256: string
  implementationBaseline: string
  gitExecutableSha256: string
  artifactSinkAuthority: EvidenceArtifactSinkAuthority
  trustedDispatchIssuers: readonly TrustedDispatchIssuer[]
  policyDigest: string
}>

export type DispatchReceiptFindingCode =
  | 'dispatch_receipt_invalid'
  | 'dispatch_receipt_source_mismatch'
  | 'dispatch_receipt_task_mismatch'
  | 'dispatch_receipt_untrusted'
  | 'dispatch_trust_anchor_mismatch'
  | 'dispatch_trust_anchor_unavailable'
  | 'performer_identity_mismatch'

export type DispatchReceiptFinding = Readonly<{
  code: DispatchReceiptFindingCode
  detail: string
}>

export function parseTrustedDispatchIssuers(value: unknown): readonly TrustedDispatchIssuer[] | null {
  if (!Array.isArray(value)) return null
  const issuers: TrustedDispatchIssuer[] = []
  const identities = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate) || !namedIdentity(candidate.issuer) || !namedIdentity(candidate.keyId)
      || candidate.algorithm !== 'ed25519' || !canonicalBase64(candidate.publicKeySpkiBase64)) return null
    const identity = `${candidate.issuer}\0${candidate.keyId}`
    if (identities.has(identity) || !validEd25519PublicKey(candidate.publicKeySpkiBase64)) return null
    identities.add(identity)
    issuers.push(Object.freeze({
      issuer: candidate.issuer,
      keyId: candidate.keyId,
      algorithm: 'ed25519',
      publicKeySpkiBase64: candidate.publicKeySpkiBase64,
    }))
  }
  return Object.freeze(issuers.sort((left, right) => left.issuer.localeCompare(right.issuer)
    || left.keyId.localeCompare(right.keyId)))
}

export function resolveExternalDispatchTrust(
  value: unknown,
  expected: Readonly<{
    verificationBaselineSha256: string
    implementationBaseline: string
    projectedIssuers: readonly TrustedDispatchIssuer[]
  }>,
): Readonly<{
  policyDigest: string
  trustedIssuers: readonly TrustedDispatchIssuer[]
  artifactSinkAuthority: EvidenceArtifactSinkAuthority
} | null> {
  if (!isRecord(value) || value.schema !== EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA || !digest(value.anchorId)
    || !digest(value.verificationBaselineSha256) || !/^[0-9a-f]{40}$/u.test(String(value.implementationBaseline))
    || !digest(value.gitExecutableSha256)
    || !digest(value.policyDigest)) return null
  const trustedIssuers = parseTrustedDispatchIssuers(value.trustedDispatchIssuers)
  const artifactSinkAuthority = parseArtifactSinkAuthority(value.artifactSinkAuthority)
  if (!trustedIssuers || trustedIssuers.length === 0 || !artifactSinkAuthority) return null
  const body = Object.freeze({
    schema: EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
    anchorId: String(value.anchorId),
    verificationBaselineSha256: String(value.verificationBaselineSha256),
    implementationBaseline: String(value.implementationBaseline),
    gitExecutableSha256: String(value.gitExecutableSha256),
    artifactSinkAuthority,
    trustedDispatchIssuers: trustedIssuers,
  })
  if (sha256(canonicalJson(body)) !== value.policyDigest
    || body.verificationBaselineSha256 !== expected.verificationBaselineSha256
    || body.implementationBaseline !== expected.implementationBaseline
    || canonicalJson(body.trustedDispatchIssuers) !== canonicalJson(expected.projectedIssuers)) return null
  return Object.freeze({ policyDigest: String(value.policyDigest), trustedIssuers, artifactSinkAuthority })
}

function parseArtifactSinkAuthority(value: unknown): EvidenceArtifactSinkAuthority | null {
  if (!isRecord(value) || value.schema !== EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA
    || typeof value.workspaceRootRealPath !== 'string' || !path.isAbsolute(value.workspaceRootRealPath)
    || typeof value.artifactRootRealPath !== 'string' || !path.isAbsolute(value.artifactRootRealPath)
    || value.exclusiveEvaluatorAccess !== true || value.stableAncestry !== true) return null
  return Object.freeze({
    schema: EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
    workspaceRootRealPath: value.workspaceRootRealPath,
    artifactRootRealPath: value.artifactRootRealPath,
    exclusiveEvaluatorAccess: true,
    stableAncestry: true,
  })
}

export function verifyEvidenceDispatchReceipt(
  value: unknown,
  expected: Readonly<{
    taskId: string
    sourceFingerprint: AuthoredSourceFingerprint
    trustedIssuers: readonly TrustedDispatchIssuer[]
    expectedPerformingMechanism?: string | null
  }>,
): Readonly<{ receipt: EvidenceDispatchReceipt | null; findings: readonly DispatchReceiptFinding[] }> {
  const receipt = parseEvidenceDispatchReceipt(value)
  if (!receipt) return failed('dispatch_receipt_invalid', 'dispatch receipt fields or integrity digest are invalid')
  const findings: DispatchReceiptFinding[] = []
  if (receipt.taskId !== expected.taskId) {
    findings.push(finding('dispatch_receipt_task_mismatch', 'dispatch receipt is bound to a different task'))
  }
  if (!sameAuthoredSource(receipt.sourceFingerprint, expected.sourceFingerprint)) {
    findings.push(finding('dispatch_receipt_source_mismatch', 'dispatch receipt is bound to a different authored-source fingerprint'))
  }
  if (expected.expectedPerformingMechanism
    && receipt.performingMechanism !== expected.expectedPerformingMechanism) {
    findings.push(finding('performer_identity_mismatch', 'caller performer label differs from the authoritative dispatch receipt'))
  }
  const trusted = expected.trustedIssuers.find(({ issuer, keyId }) => issuer === receipt.issuer && keyId === receipt.issuerKeyId)
  if (!trusted || receipt.issuer === receipt.performingMechanism || receipt.issuer === 'evidence-verdict-runner'
    || !verifySignature(receipt, trusted)) {
    findings.push(finding('dispatch_receipt_untrusted', 'dispatch receipt is not signed by a distinct trusted dispatch authority'))
  }
  return Object.freeze({ receipt, findings: Object.freeze(findings) })
}

export function parseEvidenceDispatchReceipt(value: unknown): EvidenceDispatchReceipt | null {
  if (!isRecord(value) || value.schema !== EVIDENCE_DISPATCH_RECEIPT_SCHEMA) return null
  if (!digest(value.receiptId) || !/^[0-9]+(?:\.[0-9]+)+$/u.test(String(value.taskId))
    || !namedIdentity(value.performingMechanism) || !canonicalBase64(value.performerPublicKeySpkiBase64)
    || !validEd25519PublicKey(value.performerPublicKeySpkiBase64)
    || !validAuthoredSourceFingerprint(value.sourceFingerprint)
    || !bounded(value.semanticScope) || !validWriteSet(value.declaredWriteSet) || !bounded(value.claimId)
    || !Number.isSafeInteger(value.leaseEpoch) || Number(value.leaseEpoch) < 1
    || !/^[0-9a-f]{40,64}$/u.test(String(value.fenceRevision)) || !namedIdentity(value.issuer)
    || !namedIdentity(value.issuerKeyId) || !Number.isSafeInteger(value.issuedAtMs) || Number(value.issuedAtMs) < 1
    || !digest(value.receiptDigest) || value.signatureAlgorithm !== 'ed25519'
    || !canonicalBase64(value.signatureBase64)) return null
  const receipt = Object.freeze({
    schema: EVIDENCE_DISPATCH_RECEIPT_SCHEMA,
    receiptId: String(value.receiptId),
    taskId: String(value.taskId),
    performingMechanism: String(value.performingMechanism),
    performerPublicKeySpkiBase64: String(value.performerPublicKeySpkiBase64),
    sourceFingerprint: value.sourceFingerprint,
    semanticScope: String(value.semanticScope),
    declaredWriteSet: Object.freeze([...value.declaredWriteSet] as string[]),
    claimId: String(value.claimId),
    leaseEpoch: Number(value.leaseEpoch),
    fenceRevision: String(value.fenceRevision),
    issuer: String(value.issuer),
    issuerKeyId: String(value.issuerKeyId),
    issuedAtMs: Number(value.issuedAtMs),
    receiptDigest: String(value.receiptDigest),
    signatureAlgorithm: 'ed25519' as const,
    signatureBase64: String(value.signatureBase64),
  })
  return sha256(canonicalJson(unsignedReceipt(receipt))) === receipt.receiptDigest ? receipt : null
}

export function unsignedReceipt(receipt: EvidenceDispatchReceipt): Readonly<Omit<
  EvidenceDispatchReceipt,
  'receiptDigest' | 'signatureAlgorithm' | 'signatureBase64'
>> {
  const { receiptDigest: _receiptDigest, signatureAlgorithm: _algorithm, signatureBase64: _signature, ...payload } = receipt
  return Object.freeze(payload)
}

function verifySignature(receipt: EvidenceDispatchReceipt, trusted: TrustedDispatchIssuer): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(trusted.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return publicKey.asymmetricKeyType === 'ed25519' && crypto.verify(
      null,
      Buffer.from(canonicalJson(unsignedReceipt(receipt))),
      publicKey,
      Buffer.from(receipt.signatureBase64, 'base64'),
    )
  } catch {
    return false
  }
}

function validEd25519PublicKey(value: string): boolean {
  try {
    return crypto.createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

function validWriteSet(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128
    || !value.every((entry) => typeof entry === 'string' && bounded(entry) && validRelativeScope(entry))) return false
  return value.every((entry, index) => index === 0 || String(value[index - 1]).localeCompare(entry) < 0)
}

function validRelativeScope(value: string): boolean {
  return !value.includes('\0') && !value.startsWith('/') && !value.startsWith('../') && !value.includes('/../')
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  try {
    return Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

function namedIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)
}

function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 280
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function failed(code: DispatchReceiptFindingCode, detail: string): Readonly<{
  receipt: null
  findings: readonly DispatchReceiptFinding[]
}> {
  return Object.freeze({ receipt: null, findings: Object.freeze([finding(code, detail)]) })
}

function finding(code: DispatchReceiptFindingCode, detail: string): DispatchReceiptFinding {
  return Object.freeze({ code, detail })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
