export const TAKE_RATE_CONFIGURATION_KEY = 'AG_TAKE_RATE_BASIS_POINTS'
export const MAXIMUM_RATE_BASIS_POINTS = 1_000

export type TakeRateConfigurationFailure = Readonly<{
  ok: false
  code: 'take_rate_configuration_invalid'
  key: typeof TAKE_RATE_CONFIGURATION_KEY
  condition: 'absent' | 'non_numeric' | 'negative' | 'zero' | 'above_maximum' | 'not_integer'
}>

export function readRateBasisPoints(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && !/^-?[0-9]+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAXIMUM_RATE_BASIS_POINTS
    ? parsed
    : null
}

export function takeRateConfigurationFailure(value: unknown): TakeRateConfigurationFailure | null {
  if (value === undefined || value === null || value === '') return failure('absent')
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?[0-9]+(?:\.[0-9]+)?$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return failure('non_numeric')
  if (!Number.isInteger(numeric)) return failure('not_integer')
  if (numeric < 0) return failure('negative')
  if (numeric === 0) return failure('zero')
  if (numeric > MAXIMUM_RATE_BASIS_POINTS) return failure('above_maximum')
  return null
}

export function computeMarkupMinor(settledAmountMinor: number, rateBasisPoints: number): number {
  if (!Number.isSafeInteger(settledAmountMinor) || settledAmountMinor < 0) {
    throw new RangeError('settled_amount_minor_invalid')
  }
  if (readRateBasisPoints(rateBasisPoints) === null) throw new RangeError('rate_basis_points_invalid')
  const amount = BigInt(settledAmountMinor)
  const rate = BigInt(rateBasisPoints)
  const rounded = (amount * rate + 5_000n) / 10_000n
  const bounded = rounded > amount ? amount : rounded
  const result = Number(bounded)
  if (!Number.isSafeInteger(result)) throw new RangeError('markup_minor_out_of_range')
  return result
}

function failure(condition: TakeRateConfigurationFailure['condition']): TakeRateConfigurationFailure {
  return Object.freeze({
    ok: false,
    code: 'take_rate_configuration_invalid',
    key: TAKE_RATE_CONFIGURATION_KEY,
    condition,
  })
}
