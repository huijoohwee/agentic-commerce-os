const INTENT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PAYMENT_CREDENTIAL_FIELDS = new Set([
  'authorization', 'cardnumber', 'cvc', 'cvv', 'mnemonic', 'pan', 'password',
  'paymenttoken', 'privatekey', 'secret', 'seedphrase',
])

export type RegisteredAgent = Readonly<{
  agentId: string
  category: string
  declaredAttributes: DeclaredAttributes
  fallbackAgentId: string | null
  admissionVerified: boolean
  registrationState: 'active' | 'inactive'
}>

export type RoutingIntent = Readonly<{
  intentId: string
  category: string
  constraints: Readonly<Record<string, unknown>>
  merchantId?: string
  listingId?: string
}>

export type PinnedRouteAuthority = Readonly<{
  pinnedAgentId: string
  fallbackAgentId: string | null
}>

export type DispatchDecision = Readonly<{
  status: 'dispatch'
  intentId: string
  agentId: string
  fallbackAgentId: string | null
  category: string
  discoveryInput: RoutingIntent
  consideredAgentIds: readonly string[]
  decidingAttributes: Readonly<Record<string, DeclaredAttributes>>
}>

export type NoDispatchReason =
  | 'invalid-intent'
  | 'unmatched-category'
  | 'registry-conflict'

export type NoDispatchDecision = Readonly<{
  status: 'no-dispatch'
  intentId: string | null
  category: string | null
  reason: NoDispatchReason
  candidateAgentIds: readonly string[]
}>

export type RouteDecision = DispatchDecision | NoDispatchDecision

/**
 * Selects exactly one active, ACOS-admitted agent or returns a decision that
 * cannot be mistaken for dispatch authority. Provider I/O belongs after this
 * pure boundary and only for the `dispatch` variant.
 */
export function routeIntentExclusively(
  candidate: unknown,
  registry: readonly RegisteredAgent[],
  policy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
  routingAuthority: PinnedRouteAuthority | null = null,
): RouteDecision {
  const intent = readRoutingIntent(candidate)
  if (!intent) return noDispatch(candidate, null, 'invalid-intent', [])

  const pinnedAuthority = routingAuthority === null ? null : readPinnedRouteAuthority(routingAuthority)
  if (routingAuthority !== null && !pinnedAuthority) {
    return noDispatch(intent, intent.category, 'registry-conflict', [])
  }

  const registryConflict = findRegistryConflict(registry)
  if (registryConflict) {
    return noDispatch(intent, intent.category, 'registry-conflict', registryConflict)
  }

  const candidates = registry
    .filter((record) => record.registrationState === 'active')
    .filter((record) => record.admissionVerified)
    .filter((record) => record.category === intent.category)
    .sort((left, right) => compareText(left.agentId, right.agentId))

  if (candidates.length === 0) return noDispatch(intent, intent.category, 'unmatched-category', [])
  const winnerCandidates = pinnedAuthority
    ? candidates.filter(({ agentId }) => agentId === pinnedAuthority.pinnedAgentId)
    : candidates
  if (winnerCandidates.length !== 1 && pinnedAuthority) {
    return noDispatch(intent, intent.category, 'unmatched-category', candidates.map(({ agentId }) => agentId))
  }
  const selection = selectAgent(winnerCandidates.map((record) => Object.freeze({
    agentId: record.agentId,
    attributes: record.declaredAttributes,
  })), policy)
  if (!selection) return noDispatch(intent, intent.category, 'registry-conflict', candidates.map(({ agentId }) => agentId))
  const selected = candidates.find(({ agentId }) => agentId === selection.selectedAgentId)
  if (!selected) return noDispatch(intent, intent.category, 'registry-conflict', selection.consideredAgentIds)
  const requestedFallbackId = pinnedAuthority
    ? pinnedAuthority.fallbackAgentId
    : selected.fallbackAgentId
  if (pinnedAuthority && requestedFallbackId !== null && selected.fallbackAgentId !== requestedFallbackId) {
    return noDispatch(intent, intent.category, 'registry-conflict', selection.consideredAgentIds)
  }
  const fallback = requestedFallbackId
    ? candidates.find(({ agentId }) => agentId === requestedFallbackId)
    : null
  if (pinnedAuthority && requestedFallbackId !== null && !fallback) {
    return noDispatch(intent, intent.category, 'registry-conflict', selection.consideredAgentIds)
  }

  return Object.freeze({
    status: 'dispatch',
    intentId: intent.intentId,
    agentId: selected.agentId,
    fallbackAgentId: fallback?.agentId ?? null,
    category: intent.category,
    discoveryInput: intent,
    consideredAgentIds: selection.consideredAgentIds,
    decidingAttributes: selection.decidingAttributes,
  })
}

export function readPinnedRouteAuthority(value: unknown): PinnedRouteAuthority | null {
  if (!isRecord(value)
    || Object.keys(value).some((field) => !['pinnedAgentId', 'fallbackAgentId'].includes(field))
    || typeof value.pinnedAgentId !== 'string'
    || !INTENT_IDENTIFIER_PATTERN.test(value.pinnedAgentId)
    || (value.fallbackAgentId !== null
      && (typeof value.fallbackAgentId !== 'string' || !INTENT_IDENTIFIER_PATTERN.test(value.fallbackAgentId)))
    || value.fallbackAgentId === value.pinnedAgentId) return null
  return Object.freeze({
    pinnedAgentId: value.pinnedAgentId,
    fallbackAgentId: value.fallbackAgentId,
  })
}

export function readRoutingIntent(candidate: unknown): RoutingIntent | null {
  if (!isRecord(candidate)) return null
  const allowedFields = new Set(['intentId', 'category', 'constraints', 'merchantId', 'listingId'])
  if (Object.keys(candidate).some((field) => !allowedFields.has(field))) return null
  if (typeof candidate.intentId !== 'string' || !INTENT_IDENTIFIER_PATTERN.test(candidate.intentId)) return null
  const category = normalizeAgentCategory(candidate.category)
  if (!category || !isRecord(candidate.constraints)) return null
  const merchantTargetAbsent = candidate.merchantId === undefined && candidate.listingId === undefined
  const merchantTargetValid = typeof candidate.merchantId === 'string'
    && typeof candidate.listingId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.merchantId)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.listingId)
  if (!merchantTargetAbsent && !merchantTargetValid) return null
  if (!isJsonCompatible(candidate.constraints) || containsCredentialMaterial(candidate.constraints)) return null
  return Object.freeze({
    intentId: candidate.intentId,
    category,
    constraints: freezeJsonRecord(candidate.constraints),
    ...(merchantTargetValid ? { merchantId: String(candidate.merchantId), listingId: String(candidate.listingId) } : {}),
  })
}

export function normalizeAgentCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLocaleLowerCase('en-US')
  return CATEGORY_PATTERN.test(normalized) ? normalized : null
}

function findRegistryConflict(registry: readonly RegisteredAgent[]): readonly string[] | null {
  if (!Array.isArray(registry)) return Object.freeze(['registry-not-an-array'])
  const seenAgentIds = new Set<string>()
  const conflicts = new Set<string>()
  for (const record of registry) {
    if (!isRegistryRecordShape(record)) {
      conflicts.add('malformed-registry-record')
      continue
    }
    if (seenAgentIds.has(record.agentId)) conflicts.add(record.agentId)
    seenAgentIds.add(record.agentId)
  }
  return conflicts.size > 0 ? Object.freeze([...conflicts].sort(compareText)) : null
}

function isRegistryRecordShape(value: unknown): value is RegisteredAgent {
  if (!isRecord(value)) return false
  if (value.registrationState !== 'active' && value.registrationState !== 'inactive') return false
  return typeof value.agentId === 'string'
    && typeof value.category === 'string'
    && isDeclaredAttributes(value.declaredAttributes)
    && (value.fallbackAgentId === null || typeof value.fallbackAgentId === 'string')
    && typeof value.admissionVerified === 'boolean'
}

function isDeclaredAttributes(value: unknown): value is DeclaredAttributes {
  if (!isRecord(value)) return false
  return [value.priceMinor, value.qualityScore, value.latencyMs]
    .every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)
}

function noDispatch(
  candidate: unknown,
  category: string | null,
  reason: NoDispatchReason,
  candidateAgentIds: readonly string[],
): NoDispatchDecision {
  const intentId = isRecord(candidate) && typeof candidate.intentId === 'string'
    ? candidate.intentId
    : null
  return Object.freeze({
    status: 'no-dispatch',
    intentId,
    category,
    reason,
    candidateAgentIds: Object.freeze([...candidateAgentIds]),
  })
}

function isJsonCompatible(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const values = Array.isArray(value) ? value : Object.values(value)
  const compatible = values.every((item) => isJsonCompatible(item, seen, depth + 1))
  seen.delete(value)
  return compatible
}

function containsCredentialMaterial(value: unknown, depth = 0): boolean {
  if (depth > 32) return true
  if (Array.isArray(value)) return value.some((item) => containsCredentialMaterial(item, depth + 1))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, item]) => (
    PAYMENT_CREDENTIAL_FIELDS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase())
    || containsCredentialMaterial(item, depth + 1)
  ))
}

function freezeJsonRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, item]) => [
      key,
      freezeJsonValue(item),
    ]),
  ))
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue))
  if (isRecord(value)) return freezeJsonRecord(value)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
import {
  DEFAULT_SELECTION_POLICY,
  selectAgent,
  type DeclaredAttributes,
  type SelectionPolicy,
} from './selection-policy.ts'
