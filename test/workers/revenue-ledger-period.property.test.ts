import { env, runInDurableObject } from 'cloudflare:test'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { RevenueLedger, type RevenueLine } from '../../src/core/revenue-ledger.ts'

const BASE_INSTANT_MS = 1_800_000_000_000
const COMPLETE_LINE_FIELDS = Object.freeze([
  'agentId',
  'appliedRateBasisPoints',
  'currency',
  'markupMinor',
  'recordedAt',
  'recordedAtMs',
  'settledAmountMinor',
  'settlementId',
])

type GeneratedLine = Readonly<{
  amountMinor: number
  markupMinor: number
  rateBasisPoints: number
  instantOffsetMs: number
  agentIndex: number
}>

const generatedLineArbitrary: fc.Arbitrary<GeneratedLine> = fc.record({
  amountMinor: fc.integer({ min: 0, max: 1_000_000 }),
  markupSeed: fc.nat({ max: 1_000_000 }),
  rateBasisPoints: fc.integer({ min: 1, max: 1_000 }),
  instantOffsetMs: fc.integer({ min: 0, max: 1_000 }),
  agentIndex: fc.integer({ min: 0, max: 30 }),
}).map(({ markupSeed, ...line }) => Object.freeze({
  ...line,
  markupMinor: markupSeed % (line.amountMinor + 1),
}))

const maximumLineSet = Object.freeze(Array.from({ length: 500 }, (_, index): GeneratedLine => Object.freeze({
  amountMinor: index * 11,
  markupMinor: index % (index * 11 + 1),
  rateBasisPoints: index % 1_000 + 1,
  instantOffsetMs: index % 17,
  agentIndex: index % 31,
})))

const lineSetArbitrary = fc.oneof(
  { weight: 9, arbitrary: fc.array(generatedLineArbitrary, { minLength: 0, maxLength: 40 }) },
  { weight: 1, arbitrary: fc.constant(maximumLineSet) },
)

const periodBoundsArbitrary = fc.tuple(
  fc.integer({ min: 0, max: 1_000 }),
  fc.integer({ min: 1, max: 1_001 }),
).map(([left, right]) => Object.freeze({
  startOffsetMs: Math.min(left, right - 1),
  endOffsetMs: Math.max(left + 1, right),
}))

describe('RevenueLedger period property evidence', () => {
  it('Feature: agentic-graph-commerce-platform, Property 7: CP-7 — Period read-back and aggregation', { timeout: 30_000 }, async () => {
    await fc.assert(fc.asyncProperty(
      lineSetArbitrary,
      periodBoundsArbitrary,
      async (generatedLines, bounds) => {
        const lines = generatedLines.map(toRevenueLine)
        const startInclusiveMs = BASE_INSTANT_MS + bounds.startOffsetMs
        const endExclusiveMs = BASE_INSTANT_MS + bounds.endOffsetMs
        const stub = env.REVENUE_LEDGER.get(env.REVENUE_LEDGER.newUniqueId())
        const result = await runInDurableObject(stub, async (instance) => {
          const ledger = instance as RevenueLedger
          for (const line of lines) {
            const appended = await ledger.appendLine(line)
            if (!isSuccessfulResult(appended)) throw new Error('ledger rejected a generated valid line')
          }
          return ledger.readPeriod(startInclusiveMs, endExclusiveMs)
        })

        if (!isPeriodResult(result)) throw new Error('ledger returned an invalid period result')
        const expected = lines
          .filter(({ recordedAtMs }) => recordedAtMs >= startInclusiveMs && recordedAtMs < endExclusiveMs)
          .sort(compareRevenueLines)
        expect(result.startInclusiveMs).toBe(startInclusiveMs)
        expect(result.endExclusiveMs).toBe(endExclusiveMs)
        expect(result.lines).toEqual(expected)
        expect(result.lineCount).toBe(expected.length)
        expect(result.summedMarkupMinor).toBe(expected.reduce((sum, line) => sum + line.markupMinor, 0))
        for (const line of result.lines) expect(Object.keys(line).sort()).toEqual(COMPLETE_LINE_FIELDS)
      },
    ), { numRuns: 300, seed: 7_007 })
  })
})

function toRevenueLine(line: GeneratedLine, index: number): RevenueLine {
  const recordedAtMs = BASE_INSTANT_MS + line.instantOffsetMs
  return Object.freeze({
    settlementId: `settlement-${index.toString().padStart(3, '0')}`,
    agentId: `agent-${line.agentIndex}`,
    settledAmountMinor: line.amountMinor,
    currency: 'USD',
    appliedRateBasisPoints: line.rateBasisPoints,
    markupMinor: line.markupMinor,
    recordedAtMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
  })
}

function compareRevenueLines(left: RevenueLine, right: RevenueLine): number {
  return left.recordedAtMs - right.recordedAtMs
    || left.settlementId.localeCompare(right.settlementId, 'en-US')
}

function isSuccessfulResult(value: unknown): value is Readonly<{ ok: true }> {
  return isRecord(value) && value.ok === true
}

function isPeriodResult(value: unknown): value is Readonly<{
  ok: true
  startInclusiveMs: number
  endExclusiveMs: number
  lines: readonly RevenueLine[]
  summedMarkupMinor: number
  lineCount: number
}> {
  return isRecord(value)
    && value.ok === true
    && Number.isSafeInteger(value.startInclusiveMs)
    && Number.isSafeInteger(value.endExclusiveMs)
    && Array.isArray(value.lines)
    && Number.isSafeInteger(value.summedMarkupMinor)
    && Number.isSafeInteger(value.lineCount)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
