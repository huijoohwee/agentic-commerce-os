import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import capabilityMapJson from '../../config/capability-token-map.json' with { type: 'json' }
import { devProviderFetch } from '../../src/dev/provider.ts'
import { createInvocationClient } from '../../src/invocation/index.ts'

import {
  coverageFindings,
  localMcpCoverageFindings,
  readCapabilityMap,
} from '../../src/invocation/capability-map'
import type { InvocationCatalogSnapshot } from '../../src/invocation/catalog'

describe('capability token map', () => {
  it('hydrates the real Dev provider with complete routing coverage and the committed Dev pins', async () => {
    const map = readCapabilityMap(capabilityMapJson)
    if (!map) throw new Error('capability_map_invalid')
    const client = createInvocationClient({
      bearerToken: crypto.randomUUID(),
      fetcher: (input, init) => devProviderFetch(new Request(input, init)),
    })
    try {
      // Hydration recomputes both digests before accepting the provider's entries.
      const catalog = await client.hydrate()
      expect(coverageFindings(map, catalog)).toEqual([])
      const config = JSON.parse(readFileSync(new URL('../../wrangler.core.jsonc', import.meta.url), 'utf8'))
      expect(catalog).toMatchObject({
        sourceRevision: config.env.dev.vars.ACOS_SOURCE_REVISION,
        catalogDigest: config.env.dev.vars.ACOS_CATALOG_DIGEST,
        routingSchema: config.env.dev.vars.ACOS_ROUTING_SCHEMA,
        routingDigest: config.env.dev.vars.ACOS_ROUTING_DIGEST,
        counts: JSON.parse(config.env.dev.vars.ACOS_CATALOG_COUNTS_JSON),
      })
      expect(catalog.entries).toHaveLength(3)
    } finally { await client.close() }
  })

  it('keeps upstream token resolution separate from local MCP reachability', () => {
    const map = readCapabilityMap([{
      capabilityAction: 'catalog.public.read',
      commandToken: '/tool.route',
      semanticTokens: ['#mcp'],
      bindingTokens: ['@mcp-gateway'],
      mcpTool: 'commerce.catalog.public.list',
      httpRoute: '/v1/public/agents',
    }])
    expect(map).not.toBeNull()
    const catalog = Object.freeze({
      sourceRevision: 'a'.repeat(40),
      catalogDigest: 'b'.repeat(64),
      routingSchema: 'agentic-canvas-os-docs-routing/v1',
      routingDigest: 'c'.repeat(64),
      counts: Object.freeze({ command: 1, semantic: 1, binding: 1 }),
      entries: Object.freeze([
        entry('/tool.route', 'command', {
          mcpTools: ['commerce.catalog.public.list'],
          semantics: ['#mcp'],
          bindings: ['@mcp-gateway'],
        }),
        entry('#mcp', 'semantic'),
        entry('@mcp-gateway', 'binding'),
      ]),
    }) satisfies InvocationCatalogSnapshot
    expect(coverageFindings(map ?? [], catalog)).toEqual([])
    expect(localMcpCoverageFindings(map ?? [], ['commerce.catalog.public.list'])).toEqual([])
    expect(localMcpCoverageFindings(map ?? [], [])).toEqual([
      'catalog.public.read: local MCP tool commerce.catalog.public.list is not registered',
    ])

    const unboundCatalog = Object.freeze({
      ...catalog,
      entries: Object.freeze([
        entry('/tool.route', 'command'),
        entry('#mcp', 'semantic'),
        entry('@mcp-gateway', 'binding'),
      ]),
    })
    expect(coverageFindings(map ?? [], unboundCatalog)).toEqual([
      'catalog.public.read: command /tool.route does not bind @mcp-gateway',
      'catalog.public.read: command /tool.route does not bind semantic #mcp',
      'catalog.public.read: expected one upstream command claim for commerce.catalog.public.list, found 0',
    ])
  })
})

function entry(
  token: string,
  kind: 'command' | 'semantic' | 'binding',
  routing: Readonly<{
    mcpTools?: readonly string[]
    semantics?: readonly string[]
    bindings?: readonly string[]
  }> = {},
) {
  return Object.freeze({ token, kind, label: token, summary: '', sourcePath: `dictionary/${token}`, ...routing })
}
