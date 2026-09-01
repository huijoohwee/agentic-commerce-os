import { describe, expect, it } from 'vitest'

import { callMcpTool } from '../../src/core/mcp-provider.ts'
import { verifyOperationalEvidence } from '../../src/core/provider-operation-gate.ts'
import { CHECKOUT_PROVIDER_CONTRACT, DISCOVERY_PROVIDER_CONTRACT } from '../../src/core/provider-contract.ts'
import { CHECKOUT_EVIDENCE_CHECKS, DISCOVERY_EVIDENCE_CHECKS } from '../../src/core/upstream-evidence.ts'
import { DEV_PROVIDER_PINS, devProviderFetch } from '../../src/dev/provider.ts'

describe('discovery MCP provider boundary', () => {
  it('binds the actual MCP tool call to fresh discovery-gateway evidence and rejects a checkout permit', async () => {
    let observedTransport: Readonly<{ protocol: string | null; session: string | null }> | null = null
    const provider = requestFetcher(async (request) => {
      if (request.headers.get('x-commerce-contract') === DISCOVERY_PROVIDER_CONTRACT) {
        observedTransport = Object.freeze({
          protocol: request.headers.get('mcp-protocol-version'),
          session: request.headers.get('mcp-session-id'),
        })
      }
      return devProviderFetch(request)
    })
    const discovery = await verifyOperationalEvidence(
      provider,
      'discovery-provider.internal',
      DISCOVERY_PROVIDER_CONTRACT,
      JSON.stringify(DEV_PROVIDER_PINS.discoveryEvidence),
      DISCOVERY_EVIDENCE_CHECKS,
    )
    expect(discovery.ok).toBe(true)
    if (!discovery.ok) throw new Error('discovery evidence fixture invalid')
    const call = {
      name: 'commerce.flight.discover',
      arguments: {
        commerceContext: {
          intentId: 'intent-evidence',
          intentDigest: 'a'.repeat(64),
          agentId: 'agent-evidence',
        },
      },
    }
    await expect(callMcpTool(
      provider,
      call,
      { operationalEvidencePermit: discovery.permit },
    )).resolves.toMatchObject({ ok: true, contract: 'commerce.discovery-receipt/v1' })
    expect(observedTransport).toEqual({ protocol: '2025-06-18', session: 'commerce-dev-session' })

    const checkout = await verifyOperationalEvidence(
      provider,
      'checkout-provider.internal',
      CHECKOUT_PROVIDER_CONTRACT,
      JSON.stringify(DEV_PROVIDER_PINS.checkoutEvidence),
      CHECKOUT_EVIDENCE_CHECKS,
    )
    expect(checkout.ok).toBe(true)
    if (!checkout.ok) throw new Error('checkout evidence fixture invalid')
    await expect(callMcpTool(
      provider,
      call,
      { operationalEvidencePermit: checkout.permit },
    )).rejects.toThrow('response binding mismatch')
  })

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

  it('applies one caller deadline across initialization, dispatch, and cleanup', async () => {
    const deadline = new AbortController()
    const signals: AbortSignal[] = []
    const binding = Object.freeze({
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const request = new Request(input, init)
        signals.push(request.signal)
        if (request.method === 'DELETE') throw request.signal.reason
        const rpc = await request.json<Record<string, unknown>>()
        if (rpc.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'test', version: '1.0.0' },
            },
          }, { headers: { 'mcp-session-id': 'deadline-test-session' } })
        }
        if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204 })
        deadline.abort(new DOMException('dispatch deadline elapsed', 'TimeoutError'))
        await Promise.resolve()
        throw request.signal.reason
      },
    }) as unknown as Fetcher

    await expect(callMcpTool(
      binding,
      { name: 'commerce.flight.discover', arguments: {} },
      { signal: deadline.signal },
    )).rejects.toThrow('dispatch deadline elapsed')
    expect(signals).toHaveLength(4)
    expect(signals.every(({ aborted }) => aborted)).toBe(true)
  })
})

function requestFetcher(handler: (request: Request) => Promise<Response>): Fetcher {
  return Object.freeze({
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      return handler(new Request(input, init))
    },
  }) as unknown as Fetcher
}

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
