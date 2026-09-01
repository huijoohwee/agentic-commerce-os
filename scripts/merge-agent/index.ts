import type { MergeBounds } from './types.ts'

export { forbiddenCommands } from './policy.ts'

export function validMergeBounds(bounds: MergeBounds): boolean {
  return Number.isInteger(bounds.tokenCeiling)
    && bounds.tokenCeiling > 0
    && Number.isInteger(bounds.iterationCeiling)
    && bounds.iterationCeiling > 0
    && bounds.iterationCeiling <= 10
    && Number.isInteger(bounds.wallClockMinutes)
    && bounds.wallClockMinutes > 0
    && bounds.wallClockMinutes <= 30
    && bounded(bounds.circuitBreaker)
}

function bounded(value: string): boolean {
  return value === value.trim() && value.length > 0 && value.length <= 1_024
}
