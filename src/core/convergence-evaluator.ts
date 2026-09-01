import { canonicalJson, sha256Hex } from '../shared/digest.ts'
import { isRecord } from '../shared/http.ts'
import {
  COMMERCE_PRD_REVISION,
  UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
  type UpstreamEvidencePin,
} from './upstream-evidence.ts'

export type ConvergenceState = 'converged' | 'converged-with-surplus' | 'blocked'

export type ContractRevision = Readonly<{
  major: number
  minor: number
  patch: number
}>

export type DeclaredRequirements = Readonly<{
  provider: string
  expectedContract: string
  requiredCheckSet: readonly string[]
  declaredContractRevision: ContractRevision
  pin: UpstreamEvidencePin
}>

export type IdentityFailure = Readonly<{
  field: string
  reason: string
}>

export type ConvergenceVerdict = Readonly<{
  provider: string
  state: ConvergenceState
  reason: string | null
  requiredSatisfied: readonly string[]
  requiredAbsentOrFailing: readonly string[]
  surplusChecks: readonly string[]
  unnamedEnvelopeFieldCount: number
  declaredContractRevision: string
  advertisedContractRevision: string | null
  identityFailures: readonly IdentityFailure[]
}>

export function blockedConvergenceVerdict(
  provider: string,
  declaredContractRevision: string,
  requiredCheckSet: readonly string[],
  reason: string,
): ConvergenceVerdict {
  const requiredAbsentOrFailing = [...new Set(requiredCheckSet)].sort(compareText)
  return Object.freeze({
    provider,
    state: 'blocked',
    reason,
    requiredSatisfied: Object.freeze([]),
    requiredAbsentOrFailing: Object.freeze(requiredAbsentOrFailing),
    surplusChecks: Object.freeze([]),
    unnamedEnvelopeFieldCount: 0,
    declaredContractRevision,
    advertisedContractRevision: null,
    identityFailures: Object.freeze([
      Object.freeze({ field: 'evidence', reason }),
    ]),
  })
}

const OUTER_FIELDS = Object.freeze(['contract', 'evidence', 'ok'])
const EVIDENCE_FIELDS = Object.freeze([
  'checks',
  'prdRevision',
  'providerVersionId',
  'receiptDigest',
  'schema',
  'sourceRevision',
  'storageCompatibilityRevision',
])

export function parseContractRevision(value: unknown): ContractRevision | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u)
  if (!match) return null
  const [major, minor, patch] = match.slice(1).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return Object.freeze({ major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0 })
}

export function formatContractRevision(revision: ContractRevision): string {
  return `${revision.major}.${revision.minor}.${revision.patch}`
}

export function revisionForwardCompatible(
  declared: ContractRevision,
  advertised: ContractRevision,
): boolean {
  return advertised.major === declared.major && advertised.minor >= declared.minor
}

export async function evaluateConvergence(
  advertised: unknown,
  declared: DeclaredRequirements,
): Promise<ConvergenceVerdict> {
  const failures: IdentityFailure[] = []
  const outer = isRecord(advertised) ? advertised : null
  const evidence = outer && isRecord(outer.evidence) ? outer.evidence : null
  const unnamedEnvelopeFieldCount = countUnnamed(outer, OUTER_FIELDS) + countUnnamed(evidence, EVIDENCE_FIELDS)

  requireIdentity(failures, 'envelope', outer !== null, 'missing_or_malformed')
  requireIdentity(failures, 'ok', outer?.ok === true, 'not_true')
  requireIdentity(failures, 'contract', outer?.contract === declared.expectedContract, 'mismatch')
  requireIdentity(failures, 'evidence', evidence !== null, 'missing_or_malformed')

  const advertisedRevisionText = typeof evidence?.prdRevision === 'string' ? evidence.prdRevision : null
  const advertisedRevision = parseContractRevision(advertisedRevisionText)
  requireIdentity(failures, 'prdRevision', advertisedRevision !== null, 'invalid_format')
  if (advertisedRevision && !revisionForwardCompatible(declared.declaredContractRevision, advertisedRevision)) {
    failures.push(Object.freeze({ field: 'prdRevision', reason: 'not_forward_compatible' }))
  }

  requireIdentity(
    failures,
    'schema',
    evidence?.schema === UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
    'mismatch',
  )
  checkPinnedIdentity(failures, evidence, 'sourceRevision', declared.pin.sourceRevision, /^[0-9a-f]{40}$/u)
  checkPinnedIdentity(failures, evidence, 'receiptDigest', declared.pin.receiptDigest, /^[0-9a-f]{64}$/u)
  checkPinnedIdentity(
    failures,
    evidence,
    'storageCompatibilityRevision',
    declared.pin.storageCompatibilityRevision,
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u,
  )
  checkPinnedIdentity(
    failures,
    evidence,
    'providerVersionId',
    declared.pin.providerVersionId,
    /^[A-Za-z0-9_-]{1,128}$/u,
  )

  const checks = readChecks(evidence?.checks)
  if (!checks.valid) failures.push(Object.freeze({ field: 'checks', reason: 'malformed_or_duplicate' }))
  const required = [...new Set(declared.requiredCheckSet)].sort(compareText)
  const passing = new Set(checks.passing)
  const requiredSatisfied = required.filter((name) => passing.has(name))
  const requiredAbsentOrFailing = required.filter((name) => !passing.has(name))
  const surplusChecks = checks.passing.filter((name) => !required.includes(name)).sort(compareText)

  if (evidence) {
    const expectedDigest = await sha256Hex(canonicalJson({
      schema: evidence.schema,
      prdRevision: evidence.prdRevision,
      sourceRevision: evidence.sourceRevision,
      storageCompatibilityRevision: evidence.storageCompatibilityRevision,
      providerVersionId: evidence.providerVersionId,
      checks: checks.raw,
    }))
    requireIdentity(failures, 'integrity', evidence.receiptDigest === expectedDigest, 'digest_mismatch')
  }

  failures.sort((left, right) => compareText(`${left.field}:${left.reason}`, `${right.field}:${right.reason}`))
  const blocked = failures.length > 0 || requiredAbsentOrFailing.length > 0
  const state: ConvergenceState = blocked
    ? 'blocked'
    : surplusChecks.length > 0 ? 'converged-with-surplus' : 'converged'
  const reason = failures.length > 0
    ? 'identity_or_integrity_failure'
    : requiredAbsentOrFailing.length > 0 ? 'required_checks_unsatisfied' : null

  return Object.freeze({
    provider: declared.provider,
    state,
    reason,
    requiredSatisfied: Object.freeze(requiredSatisfied),
    requiredAbsentOrFailing: Object.freeze(requiredAbsentOrFailing),
    surplusChecks: Object.freeze(surplusChecks),
    unnamedEnvelopeFieldCount,
    declaredContractRevision: formatContractRevision(declared.declaredContractRevision),
    advertisedContractRevision: advertisedRevisionText,
    identityFailures: Object.freeze(failures),
  })
}

export function declaredRequirements(
  provider: string,
  expectedContract: string,
  requiredCheckSet: readonly string[],
  pin: UpstreamEvidencePin,
): DeclaredRequirements {
  const revision = parseContractRevision(COMMERCE_PRD_REVISION)
  if (!revision) throw new Error('declared_contract_revision_invalid')
  return Object.freeze({
    provider,
    expectedContract,
    requiredCheckSet: Object.freeze([...requiredCheckSet]),
    declaredContractRevision: revision,
    pin,
  })
}

function readChecks(value: unknown): Readonly<{
  valid: boolean
  passing: readonly string[]
  raw: readonly unknown[]
}> {
  if (!Array.isArray(value)) return Object.freeze({ valid: false, passing: Object.freeze([]), raw: Object.freeze([]) })
  const names = new Set<string>()
  const passing: string[] = []
  let valid = true
  for (const entry of value) {
    if (!isRecord(entry)
      || !hasOnly(entry, ['name', 'ok'])
      || typeof entry.name !== 'string'
      || entry.name.length === 0
      || typeof entry.ok !== 'boolean'
      || names.has(entry.name)) {
      valid = false
      continue
    }
    names.add(entry.name)
    if (entry.ok) passing.push(entry.name)
  }
  return Object.freeze({
    valid,
    passing: Object.freeze(passing.sort(compareText)),
    raw: Object.freeze([...value]),
  })
}

function checkPinnedIdentity(
  failures: IdentityFailure[],
  evidence: Record<string, unknown> | null,
  field: string,
  expected: string,
  pattern: RegExp,
): void {
  const value = evidence?.[field]
  if (typeof value !== 'string') {
    failures.push(Object.freeze({ field, reason: 'missing' }))
  } else if (!pattern.test(value)) {
    failures.push(Object.freeze({ field, reason: 'invalid_format' }))
  } else if (value !== expected) {
    failures.push(Object.freeze({ field, reason: 'mismatch' }))
  }
}

function requireIdentity(
  failures: IdentityFailure[],
  field: string,
  condition: boolean,
  reason: string,
): void {
  if (!condition) failures.push(Object.freeze({ field, reason }))
}

function countUnnamed(value: Record<string, unknown> | null, named: readonly string[]): number {
  return value ? Object.keys(value).filter((field) => !named.includes(field)).length : 0
}

function hasOnly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
