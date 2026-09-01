import { isRecord } from './http'

export type Disposition = 'renamed' | 'externally-owned' | 'historical-record'
export type IdentityKind = 'endpoint' | 'tool'

export type RegisterOccurrence = Readonly<{
  path: string
  line: number
  legacyIdentifier: string
  supersedingIdentifier: string
  disposition: Disposition
  kind?: IdentityKind
  owningSystem?: string
  reason?: string
  preservingArtifact?: string
  readOnly?: true
}>

export type TerminologyRegister = Readonly<{
  schema: 'agentic-graph-terminology-register/v1'
  environmentKeyPrefix: 'AG_'
  fileScope: Readonly<{ include: readonly string[]; exclude: readonly string[] }>
  matcher: Readonly<{
    boundaryAware: true
    caseSensitiveTerms: readonly string[]
    caseInsensitiveTerms: readonly string[]
  }>
  occurrences: readonly RegisterOccurrence[]
}>

const DISPOSITIONS = new Set<Disposition>(['renamed', 'externally-owned', 'historical-record'])
const IDENTITY_KINDS = new Set<IdentityKind>(['endpoint', 'tool'])

export function readTerminologyRegister(value: unknown): TerminologyRegister | null {
  if (!isRecord(value)
    || value.schema !== 'agentic-graph-terminology-register/v1'
    || value.environmentKeyPrefix !== 'AG_'
    || !isRecord(value.fileScope)
    || !isRecord(value.matcher)
    || value.matcher.boundaryAware !== true
    || !Array.isArray(value.occurrences)) return null

  const include = readStringArray(value.fileScope.include)
  const exclude = readStringArray(value.fileScope.exclude)
  const caseSensitiveTerms = readStringArray(value.matcher.caseSensitiveTerms)
  const caseInsensitiveTerms = readStringArray(value.matcher.caseInsensitiveTerms)
  if (!include || !exclude || !caseSensitiveTerms || !caseInsensitiveTerms) return null

  const occurrences = value.occurrences.map(readOccurrence)
  if (occurrences.some((entry) => entry === null)) return null
  return Object.freeze({
    schema: 'agentic-graph-terminology-register/v1',
    environmentKeyPrefix: 'AG_',
    fileScope: Object.freeze({ include, exclude }),
    matcher: Object.freeze({ boundaryAware: true, caseSensitiveTerms, caseInsensitiveTerms }),
    occurrences: Object.freeze(occurrences as RegisterOccurrence[]),
  })
}

export function requiredDispositionFields(entry: RegisterOccurrence): readonly string[] {
  if (entry.disposition === 'externally-owned') {
    return Object.freeze([
      ...(entry.owningSystem ? [] : ['owningSystem']),
      ...(entry.reason ? [] : ['reason']),
    ])
  }
  if (entry.disposition === 'historical-record') {
    return Object.freeze([
      ...(entry.preservingArtifact ? [] : ['preservingArtifact']),
      ...(entry.readOnly === true ? [] : ['readOnly']),
    ])
  }
  return Object.freeze([])
}

function readOccurrence(value: unknown): RegisterOccurrence | null {
  if (!isRecord(value)
    || !boundedText(value.path, 1_024)
    || !Number.isSafeInteger(value.line)
    || Number(value.line) < 1
    || !boundedText(value.legacyIdentifier, 280)
    || !boundedText(value.supersedingIdentifier, 280)
    || typeof value.disposition !== 'string'
    || !DISPOSITIONS.has(value.disposition as Disposition)) return null
  if (value.kind !== undefined
    && (typeof value.kind !== 'string' || !IDENTITY_KINDS.has(value.kind as IdentityKind))) return null

  const occurrence: RegisterOccurrence = Object.freeze({
    path: value.path as string,
    line: Number(value.line),
    legacyIdentifier: value.legacyIdentifier as string,
    supersedingIdentifier: value.supersedingIdentifier as string,
    disposition: value.disposition as Disposition,
    ...(value.kind !== undefined ? { kind: value.kind as IdentityKind } : {}),
    ...(boundedText(value.owningSystem, 280) ? { owningSystem: value.owningSystem as string } : {}),
    ...(boundedText(value.reason, 1_024) ? { reason: value.reason as string } : {}),
    ...(boundedText(value.preservingArtifact, 1_024)
      ? { preservingArtifact: value.preservingArtifact as string }
      : {}),
    ...(value.readOnly === true ? { readOnly: true as const } : {}),
  })
  return requiredDispositionFields(occurrence).length === 0 ? occurrence : null
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)
    || value.some((entry) => !boundedText(entry, 1_024))) return null
  return Object.freeze(value as string[])
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
}
