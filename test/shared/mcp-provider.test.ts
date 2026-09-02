import { describe, expect, it } from 'vitest'

import { callMcpTool, listMcpToolNames } from '../../src/core/mcp-provider.ts'
import { verifyOperationalEvidence } from '../../src/core/provider-operation-gate.ts'
import { CHECKOUT_PROVIDER_CONTRACT, DISCOVERY_PROVIDER_CONTRACT } from '../../src/core/provider-contract.ts'
import { CHECKOUT_EVIDENCE_CHECKS, DISCOVERY_EVIDENCE_CHECKS } from '../../src/core/upstream-evidence.ts'
import { DEV_CHECKOUT_PROVIDER_AUTH_SECRET } from '../../src/dev/provider-evidence.ts'
import { DEV_PROVIDER_PINS, devProviderFetch } from '../../src/dev/provider.ts'

const DISCOVERY_CREDENTIAL = 'commerce-discovery-provider-test-credential'
const ALTERNATE_DISCOVERY_CREDENTIAL = 'commerce-discovery-provider-alternate-credential'

describe('discovery MCP provider boundary', () => {
  it('binds the actual MCP tool call to fresh discovery-gateway evidence and rejects a checkout permit', async () => {
    let observedTransport: Readonly<{
      authorization: string | null
      protocol: string | null
      session: string | null
    }> | null = null
    const provider = requestFetcher(async (request) => {
      if (request.headers.get('x-commerce-contract') === DISCOVERY_PROVIDER_CONTRACT) {
        observedTransport = Object.freeze({
          authorization: request.headers.get('authorization'),
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
      DISCOVERY_CREDENTIAL,
      call,
      { operationalEvidencePermit: discovery.permit },
    )).resolves.toMatchObject({ ok: true, contract: 'commerce.discovery-receipt/v1' })
    expect(observedTransport).toEqual({
      authorization: `Bearer ${DISCOVERY_CREDENTIAL}`,
      protocol: '2025-06-18',
      session: 'commerce-dev-session',
    })

    const checkout = await verifyOperationalEvidence(
      provider,
      'checkout-provider.internal',
      CHECKOUT_PROVIDER_CONTRACT,
      JSON.stringify(DEV_PROVIDER_PINS.checkoutEvidence),
      CHECKOUT_EVIDENCE_CHECKS,
      DEV_CHECKOUT_PROVIDER_AUTH_SECRET,
    )
    expect(checkout.ok).toBe(true)
    if (!checkout.ok) throw new Error('checkout evidence fixture invalid')
    await expect(callMcpTool(
      provider,
      DISCOVERY_CREDENTIAL,
      call,
      { operationalEvidencePermit: checkout.permit },
    )).rejects.toThrow('response binding mismatch')
  })

  it('authenticates every MCP lifecycle request without adding Authorization to the operational digest', async () => {
    const observed: Array<Readonly<{
      authorization: string | null
      method: string
      requestDigest: string | null
    }>> = []
    const provider = requestFetcher(async (request) => {
      const rpc = request.method === 'DELETE'
        ? null
        : await request.clone().json<Record<string, unknown>>().catch(() => null)
      observed.push(Object.freeze({
        authorization: request.headers.get('authorization'),
        method: request.method === 'DELETE' ? 'DELETE' : String(rpc?.method),
        requestDigest: request.headers.get('x-commerce-provider-request-digest'),
      }))
      return devProviderFetch(request)
    })
    const evidence = await verifyOperationalEvidence(
      provider,
      'discovery-provider.internal',
      DISCOVERY_PROVIDER_CONTRACT,
      JSON.stringify(DEV_PROVIDER_PINS.discoveryEvidence),
      DISCOVERY_EVIDENCE_CHECKS,
    )
    expect(evidence.ok).toBe(true)
    if (!evidence.ok) throw new Error('discovery evidence fixture invalid')
    const call = {
      name: 'commerce.flight.discover',
      arguments: {
        commerceContext: {
          intentId: 'intent-auth',
          intentDigest: 'b'.repeat(64),
          agentId: 'agent-auth',
        },
      },
    }
    const results: unknown[] = []
    for (const credential of [DISCOVERY_CREDENTIAL, ALTERNATE_DISCOVERY_CREDENTIAL]) {
      results.push(await callMcpTool(provider, credential, call, { operationalEvidencePermit: evidence.permit }))
    }
    await expect(listMcpToolNames(provider, DISCOVERY_CREDENTIAL)).resolves.toContain('commerce.flight.discover')

    const mcpRequests = observed.filter(({ method }) => method !== 'undefined')
    expect(new Set(mcpRequests.map(({ method }) => method))).toEqual(new Set([
      'initialize', 'notifications/initialized', 'tools/call', 'tools/list', 'DELETE',
    ]))
    const acceptedAuthorization = new Set([
      `Bearer ${DISCOVERY_CREDENTIAL}`,
      `Bearer ${ALTERNATE_DISCOVERY_CREDENTIAL}`,
    ])
    expect(mcpRequests.every(({ authorization }) => (
      authorization !== null && acceptedAuthorization.has(authorization)
    ))).toBe(true)
    expect(JSON.stringify(results)).not.toContain(DISCOVERY_CREDENTIAL)
    expect(JSON.stringify(results)).not.toContain(ALTERNATE_DISCOVERY_CREDENTIAL)
    const operationDigests = mcpRequests
      .filter(({ method }) => method === 'tools/call')
      .map(({ requestDigest }) => requestDigest)
    expect(operationDigests).toHaveLength(2)
    expect(operationDigests[0]).toBe(operationDigests[1])
  })

  it('fails before provider I/O when the required discovery credential is absent or malformed', async () => {
    let calls = 0
    const binding = requestFetcher(async () => {
      calls += 1
      return new Response(null, { status: 500 })
    })
    await expect(callMcpTool(
      binding,
      '',
      { name: 'commerce.flight.discover', arguments: {} },
    )).rejects.toThrow('configuration is invalid')
    expect(calls).toBe(0)
  })

  it('rejects a JSON-RPC response that does not match the request identity', async () => {
    const binding = fixtureBinding(({ id }) => ({
      jsonrpc: '2.0',
      id: Number(id) + 1,
      result: toolResult({ ok: true }),
    }))
    await expect(callMcpTool(binding, DISCOVERY_CREDENTIAL, {
      name: 'commerce.flight.discover', arguments: {},
    }))
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
    await expect(callMcpTool(binding, DISCOVERY_CREDENTIAL, {
      name: 'commerce.flight.discover', arguments: {},
    }))
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
      DISCOVERY_CREDENTIAL,
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
      if (request.headers.get('authorization') !== `Bearer ${DISCOVERY_CREDENTIAL}`) {
        return new Response(null, { status: 401 })
      }
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
