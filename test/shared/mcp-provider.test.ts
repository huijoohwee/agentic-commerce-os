import { describe, expect, it } from 'vitest'

import { callMcpTool } from '../../src/core/mcp-provider.ts'

describe('discovery MCP provider boundary', () => {
  it('rejects a JSON-RPC response that does not match the request identity', async () => {
    const binding = fixtureBinding(({ id }) => ({
      jsonrpc: '2.0',
      id: Number(id) + 1,
      result: toolResult({ ok: true }),
    }))
    await expect(callMcpTool(binding, { name: 'commerce.flight.discover', arguments: {} }))
      .rejects.toThrow('identity')
  })

  it('rejects disagreement between structured and text tool payloads', async () => {
    const binding = fixtureBinding(({ id }) => ({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ ok: false }) }],
        structuredContent: { ok: true },
        isError: false,
      },
    }))
    await expect(callMcpTool(binding, { name: 'commerce.flight.discover', arguments: {} }))
      .rejects.toThrow('disagree')
  })
})

function fixtureBinding(
  toolResponse: (rpc: Record<string, unknown>) => Record<string, unknown>,
): Fetcher {
  const binding = Object.freeze({
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init)
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      const rpc = await request.json<Record<string, unknown>>()
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204 })
      if (rpc.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'test-session' } })
      }
      return Response.json(toolResponse(rpc))
    },
  })
  return binding as unknown as Fetcher
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  }
}
