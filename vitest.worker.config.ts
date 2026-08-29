import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig, defineProject } from 'vitest/config'

import {
  CORE_TEST_BINDINGS,
  CORE_TEST_SERVICE_BINDINGS,
  EDGE_INVALID_TEST_BINDINGS,
  EDGE_TEST_BINDINGS,
  EDGE_TEST_SERVICE_BINDINGS,
} from './test/workers/fake-services.ts'

const TEST_COMPATIBILITY_DATE = '2026-08-22'

export default defineConfig({
  test: {
    projects: [
      defineProject({
        plugins: [cloudflareTest({
          remoteBindings: false,
          wrangler: { configPath: './wrangler.core.jsonc' },
          miniflare: {
            compatibilityDate: TEST_COMPATIBILITY_DATE,
            bindings: CORE_TEST_BINDINGS,
            serviceBindings: CORE_TEST_SERVICE_BINDINGS,
          },
        })],
        test: {
          name: 'commerce-core-workerd',
          include: ['test/workers/core.test.ts'],
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
