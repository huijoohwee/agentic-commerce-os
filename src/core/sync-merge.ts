import { canonicalJson } from '../shared/digest.ts'
import { isRecord } from '../shared/http.ts'

export type ChangeOrigin = Readonly<{
  deviceId: string
  sequence: number
  recordedAtMs: number
}>

export type FieldChange = Readonly<{
  scope: string
  field: string
  value: unknown
  origin: ChangeOrigin
}>

export type MergedState = Readonly<{
  fields: readonly FieldChange[]
  eventLog: readonly FieldChange[]
}>

export const EMPTY_MERGED_STATE: MergedState = Object.freeze({
  fields: Object.freeze([]),
  eventLog: Object.freeze([]),
})

export function mergeSequences(
  base: MergedState,
  left: readonly FieldChange[],
  right: readonly FieldChange[],
): MergedState {
  if (!isMergedState(base) || !validChangeSequence(left) || !validChangeSequence(right)) {
    throw new TypeError('sync_merge_malformed')
  }
  const all = [...base.eventLog, ...base.fields, ...left, ...right]
  const unique = new Map<string, FieldChange>()
  for (const change of all) unique.set(changeIdentity(change), freezeChange(change))
  const eventLog = [...unique.values()].sort(compareChange)
  const winners = new Map<string, FieldChange>()
  for (const change of eventLog) {
    const key = `${change.scope}\u0000${change.field}`
    const prior = winners.get(key)
    if (!prior || compareChange(prior, change) < 0) winners.set(key, change)
  }
  const fields = [...winners.values()].sort((first, second) => (
    compareText(first.scope, second.scope)
    || compareText(first.field, second.field)
    || compareChange(first, second)
  ))
  return Object.freeze({ fields: Object.freeze(fields), eventLog: Object.freeze(eventLog) })
}

export function isFieldChange(change: unknown): change is FieldChange {
  return isRecord(change)
    && hasExactKeys(change, ['scope', 'field', 'value', 'origin'])
    && typeof change.scope === 'string'
    && change.scope.length > 0
    && change.scope.length <= 256
    && typeof change.field === 'string'
    && change.field.length > 0
    && change.field.length <= 256
    && isRecord(change.origin)
    && hasExactKeys(change.origin, ['deviceId', 'recordedAtMs', 'sequence'])
    && typeof change.origin.deviceId === 'string'
    && change.origin.deviceId.length > 0
    && change.origin.deviceId.length <= 256
    && Number.isSafeInteger(change.origin.sequence)
    && Number(change.origin.sequence) >= 0
    && Number.isSafeInteger(change.origin.recordedAtMs)
    && Number(change.origin.recordedAtMs) >= 0
}

export function isMergedState(value: unknown): value is MergedState {
  return isRecord(value)
    && hasExactKeys(value, ['eventLog', 'fields'])
    && validChangeSequence(value.fields)
    && validChangeSequence(value.eventLog)
}

function validChangeSequence(value: unknown): value is readonly FieldChange[] {
  return Array.isArray(value) && value.every(isFieldChange)
}

function freezeChange(change: FieldChange): FieldChange {
  return Object.freeze({
    scope: change.scope,
    field: change.field,
    value: change.value,
    origin: Object.freeze({ ...change.origin }),
  })
}

function changeIdentity(change: FieldChange): string {
  return canonicalJson(change)
}

function compareChange(left: FieldChange, right: FieldChange): number {
  return left.origin.recordedAtMs - right.origin.recordedAtMs
    || compareText(left.origin.deviceId, right.origin.deviceId)
    || left.origin.sequence - right.origin.sequence
    || compareText(left.scope, right.scope)
    || compareText(left.field, right.field)
    || compareText(canonicalJson(left.value), canonicalJson(right.value))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareText)
  const sortedExpected = [...expected].sort(compareText)
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index])
}
