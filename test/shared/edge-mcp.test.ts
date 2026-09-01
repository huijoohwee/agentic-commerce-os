import { describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_TOOL_NAMES,
  PUBLIC_MCP_TOOL_NAMES,
  handleMcpRequest,
  type CorePayload,
} from '../../src/edge/mcp'
import { isRecord } from '../../src/shared/http'

type CoreCall = Readonly<{
  path: string
  body: Readonly<Record<string, unknown>> | undefined
  method: 'GET' | 'POST' | 'DELETE'
}>

const CLAIM_HEADERS = Object.freeze({
  'x-authoring-semantic-scope': 'operator-registry',
  'x-authoring-claim-id': 'mcp-contract-test-claim',
  'x-authoring-lease-epoch': '1',
  'x-authoring-fence-revision': 'mcp-contract-test-fence',
})

describe('edge MCP contract adapters', () => {
  it('lists the exact agent and operator inventories', async () => {
    await expect(listToolNames('agent')).resolves.toEqual(PUBLIC_MCP_TOOL_NAMES)
    await expect(listToolNames('operator')).resolves.toEqual(OPERATOR_MCP_TOOL_NAMES)
  })

  it('maps every agent tool to the current core contract', async () => {
    const cases = [
      { name: 'commerce.runtime.status', arguments: {}, path: '/internal/readyz', method: 'GET' },
      {
        name: 'commerce.invocation.resolve',
        arguments: { tokens: ['/tool.route'] },
        path: '/internal/v1/invocations/resolve',
        method: 'POST',
        body: { tokens: ['/tool.route'] },
      },
      { name: 'commerce.registry.list', arguments: {}, path: '/internal/v1/agents', method: 'GET' },
      { name: 'commerce.catalog.public.list', arguments: {}, path: '/internal/v1/public/agents', method: 'GET' },
      {
        name: 'commerce.catalog.merchant.read',
        arguments: { merchantId: 'merchant/a' },
        path: '/internal/v1/merchants/merchant%2Fa/catalog',
        method: 'GET',
      },
      {
        name: 'commerce.intent.route',
        arguments: { intentId: 'intent-1', category: 'travel', constraints: {} },
        path: '/internal/v1/intents/route',
        method: 'POST',
      },
      {
        name: 'commerce.sync.merge',
        arguments: {
          base: { fields: [], eventLog: [] },
          left: [{
            scope: 'storefront', field: 'selection', value: 'offer-1',
            origin: { deviceId: 'device-1', sequence: 1, recordedAtMs: 1_000 },
          }],
          right: [],
        },
        path: '/internal/v1/sync/merge',
        method: 'POST',
      },
      {
        name: 'commerce.checkout.prepare',
        arguments: {
          checkoutId: 'checkout-1', intentId: 'intent-1', agentId: 'agent-1', offerId: 'offer-1',
          offerReceiptDigest: 'a'.repeat(64), amountMinor: 100, budgetMinor: 100, currency: 'USD',
        },
        path: '/internal/v1/invocations/authorize',
        method: 'POST',
        body: { capabilityAction: 'checkout.prepare' },
      },
      {
        name: 'commerce.checkout.confirm',
        arguments: { checkoutId: 'checkout-1' },
        path: '/internal/v1/invocations/authorize',
        method: 'POST',
        body: { capabilityAction: 'checkout.confirm' },
      },
      {
        name: 'commerce.revenue.period.read',
        arguments: { startInclusiveMs: 1_000, endExclusiveMs: 2_000 },
        path: '/internal/v1/revenue?start=1000&end=2000',
        method: 'GET',
      },
      {
        name: 'commerce.revenue.demand-evidence.read', arguments: {},
        path: '/internal/v1/revenue/demand-evidence', method: 'GET',
      },
      { name: 'commerce.vendor.list', arguments: {}, path: '/internal/v1/vendors', method: 'GET' },
      {
        name: 'commerce.settlement.get',
        arguments: { splitId: 'split/a' },
        path: '/internal/v1/settlements/split%2Fa',
        method: 'GET',
      },
    ] as const

    for (const testCase of cases) {
      const calls = await callTool('agent', testCase.name, testCase.arguments)
      expect(calls.at(-1)).toMatchObject({
        path: testCase.path,
        method: testCase.method,
        ...('body' in testCase ? { body: testCase.body } : {}),
      })
    }
  })

  it('keeps confirmation credentials out of MCP and authorizes visual-only refusals without checkout calls', async () => {
    const { response: inventory } = await mcpRequest('agent', {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, async () => ({ ok: true }))
    expect(JSON.stringify(await inventory.json())).not.toContain('confirmationToken')

    for (const [name, argumentsValue, code, capabilityAction] of [
      ['commerce.checkout.prepare', {
        checkoutId: 'checkout-visual', intentId: 'intent-visual', agentId: 'agent-visual',
        offerId: 'offer-visual', offerReceiptDigest: 'a'.repeat(64), amountMinor: 100,
        budgetMinor: 100, currency: 'USD',
      }, 'visual_handoff_required', 'checkout.prepare'],
      ['commerce.checkout.confirm', { checkoutId: 'checkout-visual' }, 'human_confirmation_required', 'checkout.confirm'],
    ] as const) {
      const calls: CoreCall[] = []
      const { response } = await mcpRequest('agent', {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: argumentsValue },
      }, async (path, body, method = body ? 'POST' : 'GET') => {
        calls.push(Object.freeze({ path, body, method }))
        return Object.freeze({ ok: true })
      })
      expect(calls).toEqual([{
        path: '/internal/v1/invocations/authorize', body: { capabilityAction }, method: 'POST',
      }])
      expect(JSON.stringify(await response.json())).toContain(code)
    }
  })

  it('maps every operator tool and leaves route-derived admission to the core mutation boundary', async () => {
    const expectedContentHash = 'd'.repeat(64)
    const cases = [
      {
        name: 'commerce.agent.register', arguments: { registration: {} },
        path: '/internal/v1/agents', method: 'POST',
      },
      {
        name: 'commerce.agent.deregister', arguments: { agentId: 'agent/a', expectedContentHash },
        path: '/internal/v1/agents/agent%2Fa', method: 'DELETE',
        body: { expectedContentHash },
      },
      {
        name: 'commerce.registry.events', arguments: { afterSequence: 7, limit: 9 },
        path: '/internal/v1/registry/events?after=7&limit=9', method: 'GET',
      },
      {
        name: 'commerce.vendor.transition', arguments: { vendorId: 'vendor/a', transition: { state: 'active' } },
        path: '/internal/v1/vendors/vendor%2Fa/transition', method: 'POST',
      },
      {
        name: 'commerce.theme.deploy', arguments: { merchantId: 'merchant/a', manifest: {} },
        path: '/internal/v1/operator/merchants/merchant%2Fa/theme', method: 'POST',
      },
      {
        name: 'commerce.release.boundary.read', arguments: {},
        path: '/internal/v1/release-boundaries', method: 'GET',
      },
      {
        name: 'commerce.authoring.claim.acquire', arguments: { claim: { semanticScope: 'operator-registry' } },
        path: '/internal/v1/operator/claims/acquire', method: 'POST',
      },
      {
        name: 'commerce.authoring.claim.release', arguments: { claim: { semanticScope: 'operator-registry' } },
        path: '/internal/v1/operator/claims/release', method: 'POST',
      },
      {
        name: 'commerce.authoring.claim.admit', arguments: { claim: { semanticScope: 'operator-registry' } },
        path: '/internal/v1/operator/claims/admit', method: 'POST',
      },
    ] as const

    for (const testCase of cases) {
      const calls = await callTool('operator', testCase.name, testCase.arguments, CLAIM_HEADERS)
      expect(calls.at(-1)).toMatchObject({
        path: testCase.path,
        method: testCase.method,
        ...('body' in testCase ? { body: testCase.body } : {}),
      })
      const admissions = calls.filter((call) => call.path === '/internal/v1/operator/claims/admit')
      expect(admissions.length).toBe(testCase.name.endsWith('.admit') ? 1 : 0)
    }
  })

  it('refuses operator state tools without claim headers before any core call', async () => {
    const calls = await callTool('operator', 'commerce.agent.deregister', {
      agentId: 'agent-1', expectedContentHash: 'e'.repeat(64),
    })
    expect(calls).toEqual([])
  })
})

async function listToolNames(authority: 'agent' | 'operator'): Promise<readonly string[]> {
  const { response } = await mcpRequest(authority, {
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  }, async () => ({ ok: true }))
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) return []
  return payload.result.tools.map((tool) => isRecord(tool) && typeof tool.name === 'string' ? tool.name : '')
}

async function callTool(
  authority: 'agent' | 'operator',
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<readonly CoreCall[]> {
  const calls: CoreCall[] = []
  const core: CorePayload = async (path, body, method = body ? 'POST' : 'GET') => {
    calls.push(Object.freeze({ path, body, method }))
    return Object.freeze({ ok: true })
  }
  const { response } = await mcpRequest(authority, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argumentsValue },
  }, core, headers)
  expect(response.status).toBe(200)
  return Object.freeze(calls)
}

async function mcpRequest(
  authority: 'agent' | 'operator',
  body: Readonly<Record<string, unknown>>,
  core: CorePayload,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ response: Response }>> {
  const pending: Promise<unknown>[] = []
  const context: Pick<ExecutionContext, 'waitUntil'> = {
    waitUntil(promise) { pending.push(promise) },
  }
  const response = await handleMcpRequest(new Request(`https://edge.test/mcp${authority === 'operator' ? '/operator' : ''}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  }), context, 'mcp-contract-test', core, authority)
  await Promise.all(pending)
  return Object.freeze({ response })
}
