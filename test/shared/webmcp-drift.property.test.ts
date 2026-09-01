import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import { buildRegisteredToolSet, verifyBeforeExecute } from '../../src/edge/client/webmcp-tools'

type ToolMetadata = Readonly<{
  name: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema: Readonly<Record<string, unknown>>
}>

const arbTool = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/u),
  inputMarker: fc.integer(),
  outputMarker: fc.integer(),
}).map(({ name, inputMarker, outputMarker }) => Object.freeze({
  name: `commerce.${name}`,
  inputSchema: Object.freeze({ type: 'object', marker: inputMarker }),
  outputSchema: Object.freeze({ type: 'object', marker: outputMarker }),
}))

describe('WebMCP registration drift property', () => {
  // Feature: agentic-graph-commerce-platform, Property 13: Registration drift refusal
  it('refuses add, remove, rename, and schema mutations before action execution', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(arbTool, { minLength: 1, maxLength: 15, selector: ({ name }) => name }),
      fc.constantFrom('add' as const, 'remove' as const, 'rename' as const, 'schema-edit' as const),
      async (tools, mutation) => {
        const recorded = await buildRegisteredToolSet(tools)
        const mutated = mutate(tools, mutation)
        const action = vi.fn()
        const refusal = await verifyBeforeExecute(
          recorded,
          tools[0]?.name ?? 'commerce.missing',
          await buildRegisteredToolSet(mutated),
        )
        if (!refusal) action()

        expect(refusal).toMatchObject({ ok: false, code: 'webmcp_registration_drift' })
        expect(refusal?.recordedDigest).not.toBe(refusal?.observedDigest)
        expect(action).not.toHaveBeenCalled()
      },
    ), { numRuns: 300, seed: 20_260_913 })
  })
})

function mutate(tools: readonly ToolMetadata[], mutation: 'add' | 'remove' | 'rename' | 'schema-edit'):
readonly ToolMetadata[] {
  const first = tools[0]
  if (!first) throw new Error('webmcp_property_tool_missing')
  if (mutation === 'remove') return tools.slice(1)
  if (mutation === 'rename') {
    return [Object.freeze({ ...first, name: uniqueName(tools, 'renamed') }), ...tools.slice(1)]
  }
  if (mutation === 'schema-edit') {
    return [Object.freeze({
      ...first,
      inputSchema: Object.freeze({ ...first.inputSchema, driftMarker: true }),
    }), ...tools.slice(1)]
  }
  return [...tools, Object.freeze({
    name: uniqueName(tools, 'added'),
    inputSchema: Object.freeze({ type: 'object' }),
    outputSchema: Object.freeze({ type: 'object' }),
  })]
}

function uniqueName(tools: readonly ToolMetadata[], suffix: string): string {
  const names = new Set(tools.map(({ name }) => name))
  let index = 0
  while (names.has(`commerce.${suffix}${index}`)) index += 1
  return `commerce.${suffix}${index}`
}
