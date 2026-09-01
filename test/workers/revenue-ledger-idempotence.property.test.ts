import { env, runInDurableObject } from 'cloudflare:test'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { RevenueLedger, type RevenueLine } from '../../src/core/revenue-ledger.ts'

const BASE_INSTANT_MS = 1_800_000_000_000

type LineValues = Readonly<{
  agentIndex: number
  settledAmountMinor: number
  appliedRateBasisPoints: number
  markupMinor: number
  instantOffsetMs: number
}>

const lineValuesArbitrary: fc.Arbitrary<LineValues> = fc.record({
  agentIndex: fc.integer({ min: 0, max: 20 }),
  settledAmountMinor: fc.integer({ min: 0, max: 1_000_000 }),
  appliedRateBasisPoints: fc.integer({ min: 1, max: 1_000 }),
  markupSeed: fc.nat({ max: 1_000_000 }),
  instantOffsetMs: fc.integer({ min: 0, max: 1_000 }),
}).map(({ markupSeed, ...values }) => Object.freeze({
  ...values,
  markupMinor: markupSeed % (values.settledAmountMinor + 1),
}))

const settlementSequenceArbitrary = fc.array(lineValuesArbitrary, { minLength: 1, maxLength: 6 })
  .chain((values) => fc.array(fc.integer({ min: 0, max: values.length - 1 }), {
    minLength: 1,
    maxLength: 8,
  }).chain((duplicates) => {
    const occurrences = [...values.keys(), ...duplicates]
    return fc.array(fc.nat(), { minLength: occurrences.length, maxLength: occurrences.length })
      .map((keys) => Object.freeze({
        lines: Object.freeze(values.map(toRevenueLine)),
        sequence: Object.freeze(occurrences
          .map((lineIndex, occurrenceIndex) => ({ lineIndex, key: keys[occurrenceIndex] ?? 0 }))
          .sort((left, right) => left.key - right.key || left.lineIndex - right.lineIndex)
          .map(({ lineIndex }) => lineIndex)),
      }))
  }))

describe('RevenueLedger property evidence', () => {
  it('Feature: agentic-graph-commerce-platform, Property 6: CP-6 — Ledger idempotence', { timeout: 30_000 }, async () => {
    await fc.assert(fc.asyncProperty(settlementSequenceArbitrary, async ({ lines, sequence }) => {
      const stub = env.REVENUE_LEDGER.get(env.REVENUE_LEDGER.newUniqueId())
      const evidence = await runInDurableObject(stub, async (instance) => {
        const ledger = instance as RevenueLedger
        const appendResults: unknown[] = []
        for (const lineIndex of sequence) {
          const line = lines[lineIndex]
          if (!line) throw new Error('generated settlement index is out of range')
          appendResults.push(await ledger.appendLine(line))
        }
        return Object.freeze({
          appendResults,
          period: await ledger.readPeriod(BASE_INSTANT_MS, BASE_INSTANT_MS + 1_001),
        })
      })

      const seen = new Set<string>()
      for (const [index, result] of evidence.appendResults.entries()) {
        const lineIndex = sequence[index]
        const line = lineIndex === undefined ? undefined : lines[lineIndex]
        if (!line || !isAppendSuccess(result)) throw new Error('ledger rejected a generated valid line')
        expect(result.line).toEqual(line)
        expect(result.idempotent).toBe(seen.has(line.settlementId))
        seen.add(line.settlementId)
      }

      if (!isPeriodResult(evidence.period)) throw new Error('ledger returned an invalid period result')
      const expected = lines
        .filter(({ settlementId }) => seen.has(settlementId))
        .sort(compareRevenueLines)
      expect(evidence.period.lines).toEqual(expected)
      expect(evidence.period.lineCount).toBe(expected.length)
      expect(evidence.period.summedMarkupMinor).toBe(expected.reduce((sum, line) => sum + line.markupMinor, 0))
    }), { numRuns: 300, seed: 6_006 })
  })
})

function toRevenueLine(values: LineValues, index: number): RevenueLine {
  const recordedAtMs = BASE_INSTANT_MS + values.instantOffsetMs
  return Object.freeze({
    settlementId: `settlement-${index}`,
    agentId: `agent-${values.agentIndex}`,
    settledAmountMinor: values.settledAmountMinor,
    currency: 'USD',
    appliedRateBasisPoints: values.appliedRateBasisPoints,
    markupMinor: values.markupMinor,
    recordedAtMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
  })
}

function compareRevenueLines(left: RevenueLine, right: RevenueLine): number {
  return left.recordedAtMs - right.recordedAtMs
    || left.settlementId.localeCompare(right.settlementId, 'en-US')
}

function isAppendSuccess(value: unknown): value is Readonly<{
  ok: true
  idempotent: boolean
  line: RevenueLine
}> {
  return isRecord(value) && value.ok === true && typeof value.idempotent === 'boolean' && isRecord(value.line)
}

function isPeriodResult(value: unknown): value is Readonly<{
  ok: true
  lines: readonly RevenueLine[]
  summedMarkupMinor: number
  lineCount: number
}> {
  return isRecord(value)
    && value.ok === true
    && Array.isArray(value.lines)
    && Number.isSafeInteger(value.summedMarkupMinor)
    && Number.isSafeInteger(value.lineCount)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
