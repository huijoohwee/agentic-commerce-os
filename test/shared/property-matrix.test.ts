import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const MATRIX = Object.freeze([
  row(1, 'Legacy identity rejection parity', 200, 'test/shared/terminology-guard.property.test.ts'),
  row(2, 'Surplus never blocks, deficit always blocks', 500, 'test/domain/convergence.property.test.ts'),
  row(3, 'Verdict determinism', 300, 'test/domain/convergence.property.test.ts'),
  row(4, 'Forward-compatible revision and identity blocking', 400, 'test/domain/convergence.property.test.ts'),
  row(5, 'Markup arithmetic and non-interference', 500, 'test/domain/take-rate.property.test.ts'),
  row(6, 'CP-6 — Ledger idempotence', 300, 'test/workers/revenue-ledger-idempotence.property.test.ts'),
  row(7, 'CP-7 — Period read-back and aggregation', 300, 'test/workers/revenue-ledger-period.property.test.ts'),
  row(8, 'Theme manifest round trip', 300, 'test/shared/theme-manifest.test.ts'),
  row(9, 'Catalog scope containment', 300, 'test/domain/merchant-catalog.property.test.ts'),
  row(10, 'Resolution totality', 400, 'test/shared/invocation-resolution.property.test.ts'),
  row(11, 'Resolution idempotence across revisions', 200, 'test/shared/invocation-resolution.property.test.ts'),
  row(14, 'CP-14 — Dispatch count totality', 500, 'test/workers/dispatch-count.property.test.ts'),
  row(15, 'Selection determinism and tie rule', 300, 'test/domain/selection-policy.property.test.ts'),
  row(16, 'CP-16 — Public projection fidelity', 300, 'test/workers/public-catalog.property.test.ts'),
  row(17, 'Merge confluence', 300, 'test/domain/sync-merge.property.test.ts'),
  row(18, 'Offline order preservation', 300, 'test/shared/local-store.test.ts'),
  row(19, 'CP-19 — Claim admission and byte preservation', 300, 'test/workers/authoring-claim.property.test.ts'),
  row(20, 'CP-20 — Change-event idempotence', 300, 'test/workers/offer-watch.property.test.ts'),
  row(21, 'CP-21 — Settlement blocking after change', 500, 'test/workers/settlement-gate.property.test.ts'),
  row(22, 'Isolation and allowlist enforcement', 400, 'test/shared/sandbox-executor.test.ts'),
  row(23, 'Resource-limit termination', 200, 'test/shared/sandbox-executor.test.ts'),
  row(24, 'Bounded merge mutation', 300, 'test/shared/merge-agent.property.test.ts'),
])

describe('required property-test matrix', () => {
  it.each(MATRIX)('keeps CP$number tagged at exactly $numRuns runs', ({ tag, numRuns, file }) => {
    const text = fs.readFileSync(path.resolve(file), 'utf8')
    const starts = allIndexes(text, tag)
    expect(starts.length).toBeGreaterThan(0)
    for (const start of starts) {
      const next = text.indexOf('Feature: agentic-graph-commerce-platform, Property ', start + tag.length)
      const segment = text.slice(start, next < 0 ? undefined : next)
      const match = segment.match(/numRuns:\s*(\d+)/u)
      expect(match?.[1]).toBe(String(numRuns))
    }
  })
})

function row(number: number, title: string, numRuns: number, file: string) {
  return Object.freeze({
    number,
    tag: `Feature: agentic-graph-commerce-platform, Property ${number}: ${title}`,
    numRuns,
    file,
  })
}

function allIndexes(text: string, value: string): number[] {
  const indexes: number[] = []
  let offset = 0
  while (offset < text.length) {
    const index = text.indexOf(value, offset)
    if (index < 0) break
    indexes.push(index)
    offset = index + value.length
  }
  return indexes
}
