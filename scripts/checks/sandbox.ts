import { spawnSync } from 'node:child_process'

import { verifySandboxProvisionReceiptFiles } from '../sandbox-provision-receipt.ts'
import { fileContains, readJson, report } from './common.ts'

const argumentsValue = process.argv.slice(2)
const sourceOnly = argumentsValue.length === 1 && argumentsValue[0] === '--source-only'
const argumentsValid = argumentsValue.length === 0 || sourceOnly

const manifest = readJson<Readonly<{ dependencies?: Readonly<Record<string, string>> }>>('package.json')
const sandboxVersion = manifest.dependencies?.['@cloudflare/sandbox'] ?? ''
const boundary = readJson<Readonly<{
  boundaries: readonly Readonly<{ id: string; state: string }>[]
  webMcp: Readonly<{
    supportedBrowsers: readonly Readonly<{ name: string; minimumVersion: number }>[]
    testedBrowserHarnesses: readonly Readonly<{ name: string; minimumVersion: number }>[]
  }>
}>>('docs/deploy-boundary-register.json')
const minimumChromiumVersion = boundary.webMcp.testedBrowserHarnesses
  .find(({ name }) => name === 'Chromium')?.minimumVersion ?? 0
const provision = verifySandboxProvisionReceiptFiles({
  workspaceRoot: process.cwd(),
  receiptPath: process.env.AG_SANDBOX_PROVISION_RECEIPT_PATH,
  trustAnchorPath: process.env.AG_SANDBOX_PROVISION_TRUST_ANCHOR_PATH,
  trustedGitExecutable: process.env.AG_TRUSTED_GIT_EXECUTABLE,
  sandboxPackageVersion: sandboxVersion,
  sandboxImage: `docker.io/cloudflare/sandbox:${sandboxVersion}`,
  supportedBrowsers: boundary.webMcp.supportedBrowsers.map(({ name, minimumVersion }) => ({ name, minimumVersion })),
  minimumChromiumVersion,
  resourceBounds: Object.freeze({ wallClockSeconds: 300, memoryMegabytes: 256, terminationGraceSeconds: 5 }),
})
const integration = spawnSync(process.execPath, [
  './node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts',
  'test/shared/sandbox-concurrency.test.ts',
  'test/shared/sandbox-executor.test.ts',
  'test/shared/sandbox-live-proof.test.ts',
  'test/shared/sandbox-provision-receipt.test.ts',
  'test/shared/sandbox-preview.test.ts',
  'test/shared/sandbox-registration-target.test.ts',
  'test/shared/sandbox-source-package.test.ts',
  'test/shared/sandbox-theme-build.test.ts',
  'test/shared/sandbox-webmcp.test.ts',
], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4_000_000, timeout: 40_000 })
if (integration.status !== 0) {
  if (integration.stdout) process.stderr.write(integration.stdout)
  if (integration.stderr) process.stderr.write(integration.stderr)
}

report(sourceOnly ? 'sandbox-source' : 'sandbox', [
  { condition: argumentsValid, detail: 'only the explicit source-only boundary is accepted' },
  fileContains('src/sandbox/executor.ts', '@cloudflare/sandbox'),
  fileContains('src/sandbox/executor.ts', 'getSandbox'),
  fileContains('src/sandbox/executor.ts', 'sandbox_call_not_allowlisted'),
  fileContains('src/sandbox/preview.ts', 'preview_revoked'),
  fileContains('wrangler.sandbox.jsonc', '"image": "./config/sandbox.Dockerfile"'),
  fileContains('config/sandbox.Dockerfile', `FROM docker.io/cloudflare/sandbox:${sandboxVersion}`),
  fileContains('docs/deploy-boundary-register.json', 'dev-proven'),
  fileContains('src/sandbox/isolation.ts', 'memoryMegabytes !== SANDBOX_CONTAINER_MEMORY_MEGABYTES'),
  fileContains('src/sandbox/isolation.ts', 'const MAXIMUM_WALL_CLOCK_SECONDS = 300'),
  fileContains('src/sandbox/isolation.ts', 'const TERMINATION_LIMIT_MS = 5_000'),
  {
    condition: boundary.boundaries.some(({ id, state }) => id === 'sandbox-executor-to-delivery' && state === 'closed'),
    detail: 'Sandbox delivery boundary remains closed',
  },
  {
    condition: boundary.webMcp.supportedBrowsers.every(({ name, minimumVersion }) => (
      name.length > 0 && Number.isSafeInteger(minimumVersion) && minimumVersion > 0
    )) && boundary.webMcp.supportedBrowsers.length > 0,
    detail: 'browser support names and minimum versions recorded',
  },
  {
    condition: boundary.webMcp.testedBrowserHarnesses.some(({ name, minimumVersion }) => (
      name === 'Chromium' && Number.isSafeInteger(minimumVersion) && minimumVersion >= 151
    )),
    detail: 'real Chromium harness recorded separately from container evidence',
  },
  ...(sourceOnly ? [] : [{
    condition: provision.ok,
    detail: provision.findings[0]?.detail
      ?? 'external receipt attests task 12.4 and 12.7 in one terminated provisioned Sandbox instance',
  }]),
  { condition: integration.status === 0, detail: 'source-level isolated harness examples passed' },
])
