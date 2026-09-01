import { describe, expect, it, vi } from 'vitest'

import {
  WEBMCP_REGISTRATION_LIMIT_MS,
  buildRegisteredToolSet,
  registerStorefrontTools,
  storefrontToolDefinitions,
  verifyBeforeExecute,
  type ModelContextLike,
} from '../../src/edge/client/webmcp-tools'
import type { StorefrontActions } from '../../src/edge/client/storefront-actions'

describe('WebMCP storefront tools', () => {
  it('registers the current native shape without checkout confirmation or credential fields', async () => {
    const registered: Readonly<Record<string, unknown>>[] = []
    const native: Array<Readonly<{ name: string; inputSchema: unknown }>> = []
    const modelContext: ModelContextLike = {
      async registerTool(tool, options) {
        registered.push(tool)
        if (!options?.signal.aborted) native.push({ name: tool.name, inputSchema: tool.inputSchema })
      },
      async getTools() { return native },
    }
    const outcome = await registerStorefrontTools(actions(), { modelContext })
    expect(outcome.ok).toBe(true)
    expect(registered.map((tool) => tool.name)).toEqual([
      'commerce.catalog.search',
      'commerce.offer.select',
      'commerce.checkout.initiate',
    ])
    expect(registered.every((tool) => !('outputSchema' in tool))).toBe(true)
    const serialized = JSON.stringify(registered)
    expect(serialized).not.toMatch(/confirmCheckout|confirmationToken|cardToken|authorization/iu)
  })

  it('refuses a changed tool set before invoking an action and records one drift event', async () => {
    const actionSet = actions()
    const definitions = storefrontToolDefinitions(actionSet)
    const registered: Array<Readonly<Record<string, unknown>>> = []
    const native: Array<Readonly<{ name: string; inputSchema: unknown }>> = []
    const evidence: Array<Readonly<Record<string, unknown>>> = []
    const outcome = await registerStorefrontTools(actionSet, {
      modelContext: {
        async registerTool(tool, options) {
          registered.push(tool)
          if (!options?.signal.aborted) native.push({ name: tool.name, inputSchema: tool.inputSchema })
        },
        async getTools() { return native },
      },
      definitions,
      async recordEvidence(event) {
        evidence.push(event)
      },
    })
    expect(outcome.ok).toBe(true)
    const firstDefinition = definitions[0]
    if (!firstDefinition) throw new Error('missing_webmcp_definition')
    native.push({ name: 'commerce.catalog.changed', inputSchema: firstDefinition.inputSchema })
    const execute = registered[0]?.execute
    expect(typeof execute).toBe('function')
    const result = await (execute as (
      input: Readonly<Record<string, unknown>>,
      options: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>)({ query: '', limit: 10 }, { signal: new AbortController().signal })
    expect(result).toMatchObject({ ok: false, code: 'webmcp_registration_drift' })
    expect(actionSet.searchCatalog).not.toHaveBeenCalled()
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ type: 'webmcp_registration_drift' })
  })

  it('aborts native registration so late completions cannot leave a partial tool set', async () => {
    const pending: Array<() => void> = []
    const signals: AbortSignal[] = []
    const native: Array<Readonly<{ name: string; inputSchema: unknown }>> = []
    const outcomePromise = registerStorefrontTools(actions(), {
      modelContext: {
        registerTool(tool, options) {
          const signal = options?.signal
          if (!signal) throw new Error('registration_signal_required')
          signals.push(signal)
          return new Promise((resolve) => pending.push(() => {
            if (!signal.aborted) native.push({ name: tool.name, inputSchema: tool.inputSchema })
            resolve()
          }))
        },
        async getTools() { return native },
      },
      async recordEvidence() {},
    })
    await expect.poll(() => signals.length).toBe(3)
    const outcome = await outcomePromise
    expect(outcome).toMatchObject({ ok: false, code: 'webmcp_registration_timeout' })
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    for (const complete of pending) complete()
    await Promise.resolve()
    expect(native).toEqual([])
  }, WEBMCP_REGISTRATION_LIMIT_MS + 2_000)

  it('computes drift over names, input schemas, output schemas, and count', async () => {
    const definitions = storefrontToolDefinitions(actions())
    const firstDefinition = definitions[0]
    if (!firstDefinition) throw new Error('missing_webmcp_definition')
    const recorded = await buildRegisteredToolSet(definitions)
    const changed = await buildRegisteredToolSet([
      { ...firstDefinition, outputSchema: { type: 'null' } },
      ...definitions.slice(1),
    ])
    await expect(verifyBeforeExecute(recorded, firstDefinition.name, changed)).resolves.toMatchObject({
      code: 'webmcp_registration_drift',
    })
  })
})

function actions(): StorefrontActions & {
  searchCatalog: ReturnType<typeof vi.fn>
  selectOffer: ReturnType<typeof vi.fn>
  initiateCheckout: ReturnType<typeof vi.fn>
} {
  return Object.freeze({
    searchCatalog: vi.fn(async ({ query, limit }: Parameters<StorefrontActions['searchCatalog']>[0]) => ({
      ok: true as const, query, limit, listings: Object.freeze([]),
    })),
    selectOffer: vi.fn(async ({ listingId, offerId }: Parameters<StorefrontActions['selectOffer']>[0]) => ({
      ok: true as const, listingId, offerId, amountMinor: 100, currency: 'USD',
    })),
    initiateCheckout: vi.fn(async () => ({
      ok: true as const, checkoutId: 'checkout-1', state: 'awaiting-human-confirmation' as const,
    })),
  })
}
