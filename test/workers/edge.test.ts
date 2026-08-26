import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { EDGE_MCP_TOKEN, EDGE_OPERATOR_TOKEN } from './fake-services'

describe('commerce edge Worker', () => {
  it('serves a mobile-first browser console without exposing operational authority', async () => {
    const dashboard = await SELF.fetch('https://edge.test/')
    expect(dashboard.status).toBe(200)
    expect(dashboard.headers.get('content-type')).toContain('text/html')
    expect(dashboard.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await dashboard.text()
    expect(html).toContain('Agentic Commerce OS')
    expect(html).toContain('Agents discover. Humans decide.')
    expect(html).toContain('GET /livez')
    expect(html).toContain('GET /readyz')
    expect(html).not.toContain(EDGE_MCP_TOKEN)
    expect(html).not.toContain(EDGE_OPERATOR_TOKEN)
  })

  it('reports production readiness only when secrets and core are ready', async () => {
    const live = await SELF.fetch('https://edge.test/livez')
    expect(live.status).toBe(200)
    await expect(live.json()).resolves.toMatchObject({ ok: true, contract: 'commerce.edge-live/v1' })

    const ready = await SELF.fetch('https://edge.test/readyz')
    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toMatchObject({ ok: true, contract: 'commerce.edge-readiness/v1' })
  })

  it('enforces origin and separates MCP from operator authority', async () => {
    const anonymous = await SELF.fetch('https://edge.test/v1/registry')
    expect(anonymous.status).toBe(401)

    const forbiddenOrigin = await SELF.fetch('https://edge.test/v1/registry', {
      headers: {
        authorization: `Bearer ${EDGE_MCP_TOKEN}`,
        origin: 'https://example.com',
      },
    })
    expect(forbiddenOrigin.status).toBe(403)
    await expect(forbiddenOrigin.json()).resolves.toMatchObject({ ok: false, code: 'origin_forbidden' })

    const registry = await SELF.fetch('https://edge.test/v1/registry', {
      headers: { authorization: `Bearer ${EDGE_MCP_TOKEN}` },
    })
    expect(registry.status).toBe(200)
    await expect(registry.json()).resolves.toMatchObject({ ok: true, agents: [] })

    const wrongAuthority = await operatorTransition(EDGE_MCP_TOKEN)
    expect(wrongAuthority.status).toBe(401)
    const transitioned = await operatorTransition(EDGE_OPERATOR_TOKEN)
    expect(transitioned.status).toBe(200)
    await expect(transitioned.json()).resolves.toMatchObject({ ok: true, vendorId: 'vendor-1', state: 'active' })
  })

  it('protects the MCP transport and negotiates the pinned protocol', async () => {
    const initializeBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'worker-test', version: '1.0.0' },
      },
    }
    const unauthorized = await mcpRequest(initializeBody)
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_001, message: 'Unauthorized' },
    })

    const initialized = await mcpRequest(initializeBody, EDGE_MCP_TOKEN)
    expect(initialized.status).toBe(200)
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'agentic-commerce-os' },
      },
    })
  })
})

function operatorTransition(token: string): Promise<Response> {
  return SELF.fetch('https://edge.test/v1/operator/vendors/vendor-1/transition', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ actorId: 'operator-1', state: 'active' }),
  })
}

function mcpRequest(body: unknown, token = ''): Promise<Response> {
  return SELF.fetch('https://edge.test/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}
