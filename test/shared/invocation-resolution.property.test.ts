import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  DOCS_INVOCATION_TOOL,
  INVOCATION_ROUTING_SCHEMA,
  MCP_PROTOCOL_VERSION,
  buildInvocationDigests,
  createInvocationClient,
  type FetchFunction,
  type InvocationCatalogEntry,
} from '../../src/invocation/index.js'

const SOURCE_REVISION = 'a'.repeat(40)
const SESSION_ID = 'property-session'
const COUNTS = Object.freeze({ command: 1, semantic: 1, binding: 1 })
const CATALOG: readonly InvocationCatalogEntry[] = Object.freeze([
  entry('/tool.route', 'command'),
  entry('#mcp', 'semantic'),
  entry('@mcp-gateway', 'binding'),
])
const VALID_TOKEN_PATTERN = /^[/#@][a-z0-9][a-z0-9._-]*:?$/u

describe('invocation resolution properties', () => {
  // Feature: agentic-graph-commerce-platform, Property 10: Resolution totality
  it('returns one exact resolution or one typed refusal for every token string', async () => {
    const transport = await createTransport()
    const client = createInvocationClient({ endpoint: 'https://catalog.test/mcp', fetcher: transport.fetch })
    try {
      await fc.assert(fc.asyncProperty(
        fc.oneof(
          fc.constantFrom(...CATALOG.map(({ token }) => token)),
          fc.string({ maxLength: 140 }),
        ),
        async (token) => {
          const priorExactCalls = transport.exactTokens.length
          const expected = CATALOG.find((candidate) => candidate.token === token)
          try {
            const resolved = await client.resolve(token)
            expect(expected).toBeDefined()
            expect(resolved.invocation).toEqual(expected)
            expect(resolved).toMatchObject({ sourceRevision: SOURCE_REVISION, counts: COUNTS })
          } catch (error) {
            expect(expected).toBeUndefined()
            const syntacticallyValid = token.length <= 128
              && token === token.trim()
              && VALID_TOKEN_PATTERN.test(token)
            expect(error).toMatchObject({
              code: syntacticallyValid ? 'invocation_not_found' : 'invalid_input',
            })
          }
          const expectedExactCalls = expected || (
            token.length <= 128 && token === token.trim() && VALID_TOKEN_PATTERN.test(token)
          ) ? 1 : 0
          expect(transport.exactTokens.length - priorExactCalls).toBe(expectedExactCalls)
          expect(transport.capabilityCalls).toBe(0)
        },
      ), { numRuns: 400, seed: 20_260_910 })
    } finally {
      await client.close()
    }
  })

  // Feature: agentic-graph-commerce-platform, Property 11: Resolution idempotence across revisions
  it('returns identical results before and after refreshing the same catalog revision', async () => {
    const transport = await createTransport()
    const client = createInvocationClient({ endpoint: 'https://catalog.test/mcp', fetcher: transport.fetch })
    try {
      await fc.assert(fc.asyncProperty(
        fc.constantFrom(...CATALOG.map(({ token }) => token)),
        async (token) => {
          const first = await client.resolve(token)
          await client.refresh()
          const second = await client.resolve(token)
          expect(second).toEqual(first)
        },
      ), { numRuns: 200, seed: 20_260_911 })
    } finally {
      await client.close()
    }
  })
})

async function createTransport(): Promise<Readonly<{
  fetch: FetchFunction
  exactTokens: string[]
  capabilityCalls: number
}>> {
  const digests = await buildInvocationDigests(CATALOG)
  const exactTokens: string[] = []
  const transport = {
    exactTokens,
    capabilityCalls: 0,
    fetch: async (_input, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      const message = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (message.method === 'initialize') {
        return rpc(message.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'property-fixture', version: '1' },
        }, true)
      }
      const params = message.params as Record<string, unknown>
      expect(message.method).toBe('tools/call')
      expect(params.name).toBe(DOCS_INVOCATION_TOOL)
      const arguments_ = params.arguments as Record<string, unknown>
      const query = typeof arguments_.query === 'string' ? arguments_.query : ''
      const token = typeof arguments_.token === 'string' ? arguments_.token : ''
      if (token) exactTokens.push(token)
      const invocation = token ? CATALOG.find((candidate) => candidate.token === token) ?? null : null
      const payload = {
        ok: token ? invocation !== null : true,
        sourceRevision: SOURCE_REVISION,
        catalogDigest: digests.catalogDigest,
        routingSchema: INVOCATION_ROUTING_SCHEMA,
        routingDigest: digests.routingDigest,
        counts: COUNTS,
        ...(token ? { token } : {}),
        invocation,
        catalog: query ? CATALOG.filter((candidate) => candidate.token.startsWith(query)) : [],
        truncated: false,
      }
      return rpc(message.id, {
        isError: false,
        structuredContent: payload,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      })
    },
  } satisfies { fetch: FetchFunction; exactTokens: string[]; capabilityCalls: number }
  return transport
}

function rpc(id: unknown, result: unknown, session = false): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, {
    ...(session ? { headers: { 'mcp-session-id': SESSION_ID } } : {}),
  })
}

function entry(token: string, kind: InvocationCatalogEntry['kind']): InvocationCatalogEntry {
  return Object.freeze({ token, kind, label: token, summary: '', sourcePath: `dictionary/${token}` })
}
