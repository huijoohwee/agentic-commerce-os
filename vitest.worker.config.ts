import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig, defineProject } from 'vitest/config'

import {
  CORE_TEST_BINDINGS,
  CORE_TEST_SERVICE_BINDINGS,
  CORE_DISCOVERY_PROVIDER_CREDENTIAL,
  EDGE_INVALID_TEST_BINDINGS,
  EDGE_TEST_BINDINGS,
  EDGE_TEST_SERVICE_BINDINGS,
  authenticatedDiscoveryProvider,
} from './test/workers/fake-services.ts'
import { operationalEvidenceResponseHeaders } from './src/core/provider-operation-gate.ts'
import { discoveryOperationBinding } from './src/dev/provider-evidence.ts'
import { DOCS_INVOCATION_ENDPOINT } from './src/invocation/catalog.ts'

const TEST_COMPATIBILITY_DATE = '2026-08-22'
const DOCS_INVOCATION_PATH = new URL(DOCS_INVOCATION_ENDPOINT).pathname

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      defineProject({
        plugins: [cloudflareTest({
          remoteBindings: false,
          wrangler: { configPath: './wrangler.core.jsonc' },
          miniflare: {
            compatibilityDate: TEST_COMPATIBILITY_DATE,
            bindings: CORE_TEST_BINDINGS,
            serviceBindings: {
              ...CORE_TEST_SERVICE_BINDINGS,
              DOCS_MCP: propertyAwareDocsMcp,
            },
          },
        })],
        test: {
          name: 'commerce-core-workerd',
          include: ['test/workers/core.test.ts', 'test/workers/*.property.test.ts'],
        },
      }),
      defineProject({
        plugins: [cloudflareTest({
          remoteBindings: false,
          wrangler: { configPath: './wrangler.edge.jsonc' },
          miniflare: {
            compatibilityDate: TEST_COMPATIBILITY_DATE,
            bindings: EDGE_TEST_BINDINGS,
            serviceBindings: EDGE_TEST_SERVICE_BINDINGS,
          },
        })],
        test: {
          name: 'commerce-edge-workerd',
          include: ['test/workers/edge.test.ts'],
        },
      }),
      defineProject({
        plugins: [cloudflareTest({
          remoteBindings: false,
          wrangler: { configPath: './wrangler.edge.jsonc' },
          miniflare: {
            compatibilityDate: TEST_COMPATIBILITY_DATE,
            bindings: EDGE_INVALID_TEST_BINDINGS,
            serviceBindings: EDGE_TEST_SERVICE_BINDINGS,
          },
        })],
        test: {
          name: 'commerce-edge-invalid-config-workerd',
          include: ['test/workers/edge-invalid-config.test.ts'],
        },
      }),
    ],
  },
})

async function propertyAwareDocsMcp(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === DOCS_INVOCATION_PATH
    && request.headers.get('authorization') !== `Bearer ${CORE_DISCOVERY_PROVIDER_CREDENTIAL}`) {
    return authenticatedDiscoveryProvider(request)
  }
  if (request.method === 'POST') {
    const body = await request.clone().json<Record<string, unknown>>().catch(() => null)
    const params = isRecord(body?.params) ? body.params : null
    if (body?.method === 'tools/call' && params?.name === 'commerce.test.timeout') {
      const operation = await discoveryOperationBinding(request)
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32_000, message: 'simulated dispatch timeout' },
      }, { headers: operation ? operationalEvidenceResponseHeaders(operation.binding) : {} })
    }
  }
  return authenticatedDiscoveryProvider(request)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
