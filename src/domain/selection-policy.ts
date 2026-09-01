export type DeclaredAttributes = Readonly<{
  priceMinor: number
  qualityScore: number
  latencyMs: number
}>

export type SelectionPolicy = Readonly<{
  schema: 'agentic-graph-selection-policy/v1'
  weights: Readonly<{ price: number; quality: number; latency: number }>
  normalization: 'min-max'
}>

export type Selection = Readonly<{
  selectedAgentId: string
  score: number
  consideredAgentIds: readonly string[]
  decidingAttributes: Readonly<Record<string, DeclaredAttributes>>
}>

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = Object.freeze({
  schema: 'agentic-graph-selection-policy/v1',
  weights: Object.freeze({ price: 1, quality: 1, latency: 1 }),
  normalization: 'min-max',
})

export function readSelectionPolicy(value: unknown): SelectionPolicy | null {
  if (!isRecord(value)
    || value.schema !== 'agentic-graph-selection-policy/v1'
    || value.normalization !== 'min-max'
    || !isRecord(value.weights)
    || !hasOnly(value, ['schema', 'weights', 'normalization'])
    || !hasOnly(value.weights, ['price', 'quality', 'latency'])) return null
  const weights = [value.weights.price, value.weights.quality, value.weights.latency]
  if (!weights.every((weight) => typeof weight === 'number' && Number.isFinite(weight) && weight >= 0)
    || weights.every((weight) => weight === 0)) return null
  return Object.freeze({
    schema: 'agentic-graph-selection-policy/v1',
    weights: Object.freeze({
      price: Number(value.weights.price),
      quality: Number(value.weights.quality),
      latency: Number(value.weights.latency),
    }),
    normalization: 'min-max',
  })
}

export function selectAgent(
  eligible: readonly Readonly<{ agentId: string; attributes: DeclaredAttributes }>[],
  policy: SelectionPolicy,
): Selection | null {
  if (!readSelectionPolicy(policy) || !Array.isArray(eligible) || eligible.length === 0) return null
  const candidates = eligible.filter(validCandidate).sort((left, right) => compareText(left.agentId, right.agentId))
  if (candidates.length !== eligible.length || new Set(candidates.map(({ agentId }) => agentId)).size !== candidates.length) {
    return null
  }
  const ranges = Object.freeze({
    price: range(candidates.map(({ attributes }) => attributes.priceMinor)),
    quality: range(candidates.map(({ attributes }) => attributes.qualityScore)),
    latency: range(candidates.map(({ attributes }) => attributes.latencyMs)),
  })
  const scored = candidates.map((candidate) => Object.freeze({
    candidate,
    score: score(candidate.attributes, policy, ranges),
  })).sort((left, right) => right.score - left.score || compareText(left.candidate.agentId, right.candidate.agentId))
  const selected = scored[0]
  if (!selected) return null
  return Object.freeze({
    selectedAgentId: selected.candidate.agentId,
    score: selected.score,
    consideredAgentIds: Object.freeze(candidates.map(({ agentId }) => agentId)),
    decidingAttributes: Object.freeze(Object.fromEntries(candidates.map(({ agentId, attributes }) => [
      agentId,
      Object.freeze({ ...attributes }),
    ]))),
  })
}

function score(
  attributes: DeclaredAttributes,
  policy: SelectionPolicy,
  ranges: Readonly<{ price: Range; quality: Range; latency: Range }>,
): number {
  const price = normalizeCost(attributes.priceMinor, ranges.price)
  const quality = normalizeBenefit(attributes.qualityScore, ranges.quality)
  const latency = normalizeCost(attributes.latencyMs, ranges.latency)
  const totalWeight = policy.weights.price + policy.weights.quality + policy.weights.latency
  return (
    price * policy.weights.price
    + quality * policy.weights.quality
    + latency * policy.weights.latency
  ) / totalWeight
}

type Range = Readonly<{ minimum: number; maximum: number }>

function range(values: readonly number[]): Range {
  return Object.freeze({ minimum: Math.min(...values), maximum: Math.max(...values) })
}

function normalizeBenefit(value: number, values: Range): number {
  return values.minimum === values.maximum ? 1 : (value - values.minimum) / (values.maximum - values.minimum)
}

function normalizeCost(value: number, values: Range): number {
  return values.minimum === values.maximum ? 1 : (values.maximum - value) / (values.maximum - values.minimum)
}

function validCandidate(value: unknown): value is Readonly<{ agentId: string; attributes: DeclaredAttributes }> {
  if (!isRecord(value)
    || typeof value.agentId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.agentId)
    || !isRecord(value.attributes)) return false
  return [value.attributes.priceMinor, value.attributes.qualityScore, value.attributes.latencyMs]
    .every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)
}

function hasOnly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
