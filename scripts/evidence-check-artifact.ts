import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { canonicalJson, sha256 } from './evidence-integrity.ts'
import { parseEvidenceDispatchReceipt, type EvidenceDispatchReceipt } from './evidence-dispatch-receipt.ts'
import { validAuthoredSourceFingerprint, type AuthoredSourceFingerprint } from './evidence-source-fingerprint.ts'

export const CHECK_ARTIFACT_SCHEMA = 'agentic-commerce-check-artifact/v2'

export type CheckArtifact = Readonly<{
  schema: typeof CHECK_ARTIFACT_SCHEMA
  namedCheck: string
  performingMechanism: string
  dispatchReceipt: EvidenceDispatchReceipt
  dispatchTrustPolicyDigest: string
  sourceFingerprint: AuthoredSourceFingerprint
  sourceStable: boolean
  ran: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  artifactDigest: string
  performerSignatureBase64: string
}>

type CheckArtifactBody = Omit<CheckArtifact, 'artifactDigest' | 'performerSignatureBase64'>

export function buildCheckArtifact(
  input: Omit<CheckArtifactBody, 'schema'>,
  sign: (payload: string) => string,
): CheckArtifact {
  const body: CheckArtifactBody = Object.freeze({ schema: CHECK_ARTIFACT_SCHEMA, ...input })
  const artifactDigest = sha256(canonicalJson(body))
  const signedBody = Object.freeze({ ...body, artifactDigest })
  return Object.freeze({
    ...signedBody,
    performerSignatureBase64: sign(canonicalJson(signedBody)),
  })
}

export function parseCheckArtifact(value: unknown): CheckArtifact | null {
  if (!isRecord(value) || value.schema !== CHECK_ARTIFACT_SCHEMA || typeof value.namedCheck !== 'string'
    || !value.namedCheck.trim() || !namedMechanism(value.performingMechanism) || typeof value.ran !== 'boolean'
    || !digest(value.dispatchTrustPolicyDigest) || !validAuthoredSourceFingerprint(value.sourceFingerprint)
    || typeof value.sourceStable !== 'boolean'
    || (value.exitCode !== null && (!Number.isInteger(value.exitCode) || Number(value.exitCode) < 0))
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || typeof value.outputTruncated !== 'boolean'
    || !digest(value.artifactDigest) || !canonicalBase64(value.performerSignatureBase64)) return null
  const dispatchReceipt = parseEvidenceDispatchReceipt(value.dispatchReceipt)
  if (!dispatchReceipt || dispatchReceipt.performingMechanism !== value.performingMechanism) return null
  const body: CheckArtifactBody = Object.freeze({
    schema: CHECK_ARTIFACT_SCHEMA,
    namedCheck: value.namedCheck,
    performingMechanism: value.performingMechanism,
    dispatchReceipt,
    dispatchTrustPolicyDigest: value.dispatchTrustPolicyDigest,
    sourceFingerprint: value.sourceFingerprint,
    sourceStable: value.sourceStable,
    ran: value.ran,
    exitCode: value.exitCode === null ? null : Number(value.exitCode),
    stdout: value.stdout,
    stderr: value.stderr,
    outputTruncated: value.outputTruncated,
  })
  if (sha256(canonicalJson(body)) !== value.artifactDigest) return null
  const artifact = Object.freeze({
    ...body,
    artifactDigest: value.artifactDigest,
    performerSignatureBase64: value.performerSignatureBase64,
  })
  return verifyPerformerSignature(artifact) ? artifact : null
}

function verifyPerformerSignature(artifact: CheckArtifact): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(artifact.dispatchReceipt.performerPublicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    const { performerSignatureBase64, ...signedBody } = artifact
    return publicKey.asymmetricKeyType === 'ed25519' && crypto.verify(
      null,
      Buffer.from(canonicalJson(signedBody)),
      publicKey,
      Buffer.from(performerSignatureBase64, 'base64'),
    )
  } catch {
    return false
  }
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  try {
    return Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

function namedMechanism(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
