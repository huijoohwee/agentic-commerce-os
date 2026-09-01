import type { RegisterOccurrence } from './terminology-register'

export type LegacyIdentityRejection = Readonly<{
  ok: false
  code: 'legacy_identifier_rejected'
  presented: string
  supersedingIdentifier: string
}>

export type LegacyIdentity = Readonly<{ legacy: string; superseding: string }>

export function identityTableFromRegister(
  occurrences: readonly RegisterOccurrence[],
): readonly LegacyIdentity[] {
  return Object.freeze(occurrences
    .filter((entry) => entry.disposition === 'renamed'
      && (entry.kind === 'endpoint' || entry.kind === 'tool'))
    .map((entry) => Object.freeze({
      legacy: entry.legacyIdentifier,
      superseding: entry.supersedingIdentifier,
    })))
}

export function rejectLegacyIdentity(
  presented: string,
  table: readonly LegacyIdentity[],
): LegacyIdentityRejection | null {
  const matched = table.find((entry) => entry.legacy === presented)
  return matched
    ? Object.freeze({
      ok: false,
      code: 'legacy_identifier_rejected',
      presented,
      supersedingIdentifier: matched.superseding,
    })
    : null
}
