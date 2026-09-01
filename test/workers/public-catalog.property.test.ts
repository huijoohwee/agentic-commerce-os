import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { AgentRegistryRecord } from '../../src/core/agent-registry.ts'
import {
  PUBLIC_FIELD_ALLOWLIST,
  projectPublicCatalog,
} from '../../src/core/public-catalog.ts'

type GeneratedAgent = Readonly<{
  agentId: string
  category: string
  active: boolean
  capabilities: readonly string[]
}>

const agentArbitrary: fc.Arbitrary<GeneratedAgent> = fc.record({
  agentId: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u),
  category: fc.constantFrom('flight', 'shopping', 'lodging', 'mobility'),
  active: fc.boolean(),
  capabilities: fc.uniqueArray(
    fc.stringMatching(/^[a-z][a-z0-9.-]{0,30}$/u),
    { minLength: 0, maxLength: 8 },
  ),
}).map((agent) => Object.freeze({ ...agent, capabilities: Object.freeze(agent.capabilities) }))

const maximumRegistry = Object.freeze(Array.from({ length: 500 }, (_, index): GeneratedAgent => Object.freeze({
  agentId: `agent-${index.toString().padStart(3, '0')}`,
  category: index % 2 === 0 ? 'flight' : 'shopping',
  active: index % 3 !== 0,
  capabilities: Object.freeze([`commerce.capability.${index % 11}`]),
})))

const allInactiveRegistryArbitrary = fc.uniqueArray(agentArbitrary, {
  minLength: 0,
  maxLength: 40,
  selector: ({ agentId }) => agentId,
}).map((agents) => agents.map((agent) => Object.freeze({ ...agent, active: false })))

const registryArbitrary = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.uniqueArray(agentArbitrary, {
      minLength: 0,
      maxLength: 50,
      selector: ({ agentId }) => agentId,
    }),
  },
  { weight: 1, arbitrary: allInactiveRegistryArbitrary },
  { weight: 1, arbitrary: fc.constant(maximumRegistry) },
)

const digestArbitrary = fc.array(fc.constantFrom(...'0123456789abcdef'), {
  minLength: 64,
  maxLength: 64,
}).map((characters) => characters.join(''))

describe('public catalog Worker property evidence', () => {
  it('Feature: agentic-graph-commerce-platform, Property 16: CP-16 — Public projection fidelity', { timeout: 30_000 }, () => {
    fc.assert(fc.property(
      registryArbitrary,
      fc.nat({ max: 1_000_000 }),
      digestArbitrary,
      (generatedAgents, revision, digest) => {
        const records = generatedAgents.map(toRegistryRecord)
        const projection = projectPublicCatalog(Object.freeze({ revision, digest, agents: records }))
        const expectedActive = generatedAgents
          .filter(({ active }) => active)
          .sort((left, right) => left.agentId.localeCompare(right.agentId, 'en-US'))

        expect(projection.revision).toBe(revision)
        expect(projection.digest).toBe(digest)
        expect(projection.agents.map(({ agentId }) => agentId)).toEqual(
          expectedActive.map(({ agentId }) => agentId),
        )
        expect(projection.agents.map(({ declaredCategory }) => declaredCategory)).toEqual(
          expectedActive.map(({ category }) => category),
        )
        for (const [index, projected] of projection.agents.entries()) {
          const expected = expectedActive[index]
          if (!expected) throw new Error('projected catalog length exceeded the active registry set')
          expect(projected.declaredCapabilities).toEqual([...new Set(expected.capabilities)].sort(compareText))
          expect(Object.keys(projected).sort()).toEqual([...PUBLIC_FIELD_ALLOWLIST].sort(compareText))
        }
      },
    ), { numRuns: 300, seed: 16_016 })
  })
})

function toRegistryRecord(agent: GeneratedAgent): AgentRegistryRecord {
  return Object.freeze({
    agentId: agent.agentId,
    category: agent.category,
    registrationState: agent.active ? 'active' : 'inactive',
    admissionInputs: Object.freeze({
      toolAllowlistEntry: Object.freeze({ tool_names: Object.freeze([...agent.capabilities, ...agent.capabilities]) }),
    }),
  }) as unknown as AgentRegistryRecord
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
