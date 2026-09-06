import { defineConfig, devices } from '@playwright/test'
import { DEV_PAID_LOOP_TIMEOUT_MS, devRuntimeEnvironment } from './test/e2e/dev-runtime.ts'

const runtime = devRuntimeEnvironment()

export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'dev-paid-loop.spec.ts',
  timeout: DEV_PAID_LOOP_TIMEOUT_MS,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: 'node_modules/.cache/agentic-commerce-dev-e2e',
  reporter: 'line',
  use: {
    baseURL: runtime.baseUrl,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 360, height: 800 },
  },
  projects: [{ name: 'four-worker-dev-paid-loop' }],
})
