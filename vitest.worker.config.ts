import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig, defineProject } from 'vitest/config'

import {
  CORE_TEST_BINDINGS,
  CORE_TEST_SERVICE_BINDINGS,
  EDGE_INVALID_TEST_BINDINGS,
  EDGE_TEST_BINDINGS,
  EDGE_TEST_SERVICE_BINDINGS,
} from './test/workers/fake-services.ts'
import { devProviderFetch } from './src/dev/provider.ts'
import { operationalEvidenceResponseHeaders } from './src/core/provider-operation-gate.ts'
import { discoveryOperationBinding } from './src/dev/provider-evidence.ts'

const TEST_COMPATIBILITY_DATE = '2026-08-22'

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
  if (request.method === 'POST') {
    const body = await request.clone().json<Record<string, unknown>>().catch(() => null)
    const params = isRecord(body?.params) ? body.params : null
    if (body?.method === 'tools/call' && params?.name === 'commerce.test.timeout') {
      const binding = await discoveryOperationBinding(request)
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32_000, message: 'simulated dispatch timeout' },
      }, { headers: binding ? operationalEvidenceResponseHeaders(binding) : {} })
    }
  }
  return devProviderFetch(request)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
