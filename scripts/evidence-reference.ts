export type CheckResult = Readonly<{
  namedCheck: string
  ran: boolean
  passed: boolean
  recordedResult: string
  readableSurface: string
}>

export type EvidenceReference = Readonly<{
  namedCheck: string
  recordedResult: string
  readableSurface: string
  surface: 'authoring'
}>

export type VerdictRecord = Readonly<{
  taskId: string
  performingMechanism: string
  verdictIssuingMechanism: string
  derivedFromSurfacedOutput: boolean
  finding: 'self_graded_verdict' | null
}>

export function emitReferences(results: readonly CheckResult[]): readonly EvidenceReference[] {
  return Object.freeze(results
    .filter((result) => result.ran && result.passed)
    .map((result) => Object.freeze({
      namedCheck: result.namedCheck,
      recordedResult: result.recordedResult,
      readableSurface: result.readableSurface,
      surface: 'authoring' as const,
    })))
}

export function buildVerdictRecord(input: Omit<VerdictRecord, 'finding'>): VerdictRecord {
  const selfGraded = !input.performingMechanism.trim()
    || !input.verdictIssuingMechanism.trim()
    || input.performingMechanism === input.verdictIssuingMechanism
    || !input.derivedFromSurfacedOutput
  return Object.freeze({ ...input, finding: selfGraded ? 'self_graded_verdict' : null })
}

export function deriveRung(
  references: readonly EvidenceReference[],
  openFindings: readonly string[],
): Readonly<{ localRung: string; deliveredRung: string; blocked: boolean }> {
  if (openFindings.length > 0) {
    return Object.freeze({ localRung: 'blocked', deliveredRung: 'not-delivered', blocked: true })
  }
  return Object.freeze({
    localRung: references.length > 0 ? 'source-verified' : 'not-started',
    deliveredRung: 'not-delivered',
    blocked: false,
  })
}
