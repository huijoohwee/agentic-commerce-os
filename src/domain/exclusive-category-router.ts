const INTENT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PAYMENT_CREDENTIAL_FIELDS = new Set([
  'authorization', 'cardnumber', 'cvc', 'cvv', 'mnemonic', 'pan', 'password',
  'paymenttoken', 'privatekey', 'secret', 'seedphrase',
])

export type RegisteredAgent = Readonly<{
  agentId: string
  category: string
  admissionVerified: boolean
  registrationState: 'active' | 'inactive'
}>

export type RoutingIntent = Readonly<{
  intentId: string
  category: string
  constraints: Readonly<Record<string, unknown>>
}>

export type DispatchDecision = Readonly<{
  status: 'dispatch'
  intentId: string
  agentId: string
  category: string
  discoveryInput: RoutingIntent
}>

export type NoDispatchReason =
  | 'invalid-intent'
  | 'unmatched-category'
  | 'ambiguous-category'
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
): RouteDecision {
  const intent = readRoutingIntent(candidate)
  if (!intent) return noDispatch(candidate, null, 'invalid-intent', [])

  const registryConflict = findRegistryConflict(registry)
  if (registryConflict) {
    return noDispatch(intent, intent.category, 'registry-conflict', registryConflict)
  }

  const candidates = registry
    .filter((record) => record.registrationState === 'active')
    .filter((record) => record.admissionVerified)
    .filter((record) => record.category === intent.category)
    .map((record) => record.agentId)
    .sort(compareText)

  const agentId = candidates[0]
  if (agentId === undefined) {
    return noDispatch(intent, intent.category, 'unmatched-category', candidates)
  }
  if (candidates.length > 1) {
    return noDispatch(intent, intent.category, 'ambiguous-category', candidates)
  }

  return Object.freeze({
    status: 'dispatch',
    intentId: intent.intentId,
    agentId,
    category: intent.category,
    discoveryInput: intent,
  })
}

export function readRoutingIntent(candidate: unknown): RoutingIntent | null {
  if (!isRecord(candidate)) return null
  const allowedFields = new Set(['intentId', 'category', 'constraints'])
  if (Object.keys(candidate).some((field) => !allowedFields.has(field))) return null
  if (typeof candidate.intentId !== 'string' || !INTENT_IDENTIFIER_PATTERN.test(candidate.intentId)) return null
  const category = normalizeAgentCategory(candidate.category)
  if (!category || !isRecord(candidate.constraints)) return null
  if (!isJsonCompatible(candidate.constraints) || containsCredentialMaterial(candidate.constraints)) return null
  return Object.freeze({
    intentId: candidate.intentId,
    category,
    constraints: freezeJsonRecord(candidate.constraints),
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
    && typeof value.admissionVerified === 'boolean'
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
