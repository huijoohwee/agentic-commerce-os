import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  identityTableFromRegister,
  rejectLegacyIdentity,
} from '../../src/shared/terminology-guard'
import type { RegisterOccurrence } from '../../src/shared/terminology-register'

describe('terminology identity guard', () => {
  // Feature: agentic-graph-commerce-platform, Property 1: Legacy identity rejection parity
  it('rejects exactly renamed identities and returns their registered successor', () => {
    fc.assert(fc.property(
      fc.constantFrom('knowgrph', 'knowledgegraph', 'knowledge-graph', 'knowledge_graph', 'knowledge.graph', 'kgc', 'KG_'),
      fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/u),
      (legacyRoot, suffix) => {
        const legacy = `${legacyRoot}-${suffix}`
        const superseding = `agentic-graph-${suffix}`
        const occurrences: readonly RegisterOccurrence[] = Object.freeze([
          Object.freeze({
            path: 'src/renamed.ts',
            line: 1,
            legacyIdentifier: legacy,
            supersedingIdentifier: superseding,
            disposition: 'renamed',
            kind: 'tool',
          }),
          Object.freeze({
            path: 'src/external.ts',
            line: 1,
            legacyIdentifier: `${legacy}-external`,
            supersedingIdentifier: `${superseding}-external`,
            disposition: 'externally-owned',
            kind: 'endpoint',
            owningSystem: 'upstream',
            reason: 'upstream contract',
          }),
        ])
        const table = identityTableFromRegister(occurrences)

        expect(rejectLegacyIdentity(legacy, table)).toEqual({
          ok: false,
          code: 'legacy_identifier_rejected',
          presented: legacy,
          supersedingIdentifier: superseding,
        })
        expect(rejectLegacyIdentity(`${legacy}-external`, table)).toBeNull()
        for (const adjacent of [legacy.toUpperCase(), `x${legacy}`, `${legacy}x`]) {
          if (adjacent !== legacy) expect(rejectLegacyIdentity(adjacent, table)).toBeNull()
        }
      },
    ), { numRuns: 200, seed: 20_260_901 })
  })
})
