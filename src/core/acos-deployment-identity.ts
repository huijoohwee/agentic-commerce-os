export const ACOS_DEPLOYMENT_IDENTITY_SCHEMA = 'acos-cloudflare-deployment-identity/v1' as const

const IDENTITY_KEYS = Object.freeze([
  'schema', 'sourceRevision', 'candidateDigest', 'versionId', 'versionTag', 'versionTimestamp',
])
const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u

export type AcosDeploymentPin = Readonly<{
  sourceRevision: string
  candidateDigest: string
}>

export type AcosDeploymentIdentity = Readonly<{
  schema: typeof ACOS_DEPLOYMENT_IDENTITY_SCHEMA
  sourceRevision: string
  candidateDigest: string
  versionId: string
  versionTag: string
  versionTimestamp: string
}>

export function readAcosDeploymentPin(
  sourceRevision: unknown,
  candidateDigest: unknown,
): AcosDeploymentPin | null {
  return typeof sourceRevision === 'string'
    && SHA1_PATTERN.test(sourceRevision)
    && typeof candidateDigest === 'string'
    && SHA256_PATTERN.test(candidateDigest)
    ? Object.freeze({ sourceRevision, candidateDigest }) : null
}

export function validAcosDeploymentPin(value: AcosDeploymentPin): boolean {
  return SHA1_PATTERN.test(value.sourceRevision) && SHA256_PATTERN.test(value.candidateDigest)
}

export function readAcosDeploymentIdentity(
  value: unknown,
  expected?: AcosDeploymentPin,
): AcosDeploymentIdentity | null {
  if (!record(value) || !exactKeys(value, IDENTITY_KEYS)
    || value.schema !== ACOS_DEPLOYMENT_IDENTITY_SCHEMA
    || typeof value.sourceRevision !== 'string' || !SHA1_PATTERN.test(value.sourceRevision)
    || typeof value.candidateDigest !== 'string' || !SHA256_PATTERN.test(value.candidateDigest)
    || typeof value.versionId !== 'string' || !UUID_PATTERN.test(value.versionId)
    || value.versionTag !== `acos-prod-${value.candidateDigest}`
    || typeof value.versionTimestamp !== 'string'
    || !UTC_TIMESTAMP_PATTERN.test(value.versionTimestamp)
    || !Number.isFinite(Date.parse(value.versionTimestamp))
    || (expected !== undefined && (value.sourceRevision !== expected.sourceRevision
      || value.candidateDigest !== expected.candidateDigest))) return null
  return Object.freeze({ ...value }) as AcosDeploymentIdentity
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText)
  const wanted = [...expected].sort(compareText)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
