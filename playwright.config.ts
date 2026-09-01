import { randomUUID } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'

const ephemeralSecret = (): string => `${randomUUID()}${randomUUID()}`.replaceAll('-', '')

export default defineConfig({
  testDir: './test/browser',
  timeout: 90_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: 'node_modules/.cache/agentic-commerce-playwright',
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5187',
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'mobile-chromium-1.6mbit',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 360, height: 800 },
    },
  }],
  webServer: {
    command: 'node ./node_modules/wrangler/bin/wrangler.js dev -c wrangler.edge.jsonc --env dev --port 5187',
    url: 'http://127.0.0.1:5187/livez',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      MCP_BEARER_TOKEN: ephemeralSecret(),
      OPERATOR_BEARER_TOKEN: ephemeralSecret(),
      STOREFRONT_SESSION_SECRET: ephemeralSecret(),
    },
  },
})
