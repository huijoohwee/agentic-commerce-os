import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildReleaseAuthorityRefusal } from '../../scripts/production-release/release-authority.ts'

const CANDIDATE = 'c'.repeat(40)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('Workflow isolates dry verification from authenticated Production mutation', () => {
  const workflow = fs.readFileSync(`${ROOT}/.github/workflows/production-release.yml`, 'utf8')
  const verifyStart = workflow.indexOf('  verify:')
  const releaseStart = workflow.indexOf('  release:')
  const verifyJob = workflow.slice(verifyStart, releaseStart)
  const releaseJob = workflow.slice(releaseStart)
  assert.ok(workflow.split('\n').length < 600)
  assert.ok(verifyStart >= 0 && releaseStart > verifyStart)
  assert.doesNotMatch(workflow,
    /wrangler (?:versions upload|versions deploy|rollback|triggers deploy)|--secrets-file/u)
  assert.doesNotMatch(verifyJob,
    /DISCOVERY_PROVIDER_BEARER_TOKEN|MCP_BEARER_TOKEN|OPERATOR_BEARER_TOKEN|STOREFRONT_SESSION_SECRET/u)
  assert.doesNotMatch(verifyJob, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID|ZONE_ID)|secrets\./u)
  assert.equal(workflow.match(/--dry-run --minify/g)?.length, 2)
  assert.match(releaseJob, /environment: production/u)
  assert.match(releaseJob, /test "\$GITHUB_RUN_ATTEMPT" = 1/u)
  assert.match(releaseJob, /git ls-remote origin refs\/heads\/main/u)
  assert.match(releaseJob, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u)
  assert.equal(releaseJob.match(/run-production-release\.ts execute/g)?.length, 1)
  assert.ok(releaseJob.indexOf('Recheck protected candidate after human authorization')
    < releaseJob.indexOf('run-production-release.ts execute'))
})

test('Repository Production entrypoints cannot chain into Wrangler deploy', () => {
  const manifest = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8')) as {
    scripts: Record<string, string>
  }
  for (const [name, command] of Object.entries(manifest.scripts)
    .filter(([name]) => name.startsWith('deploy:production:'))) {
    assert.match(command, /^node scripts\/release-controller\.ts guard/u, name)
    assert.doesNotMatch(command, /\bwrangler\s+deploy\b/u, name)
  }
  for (const [name, command] of Object.entries(manifest.scripts)) {
    assert.doesNotMatch(command, /\bwrangler\s+deploy\b/u, name)
  }
  assert.equal(manifest.scripts['deploy:dev:dry'], 'node scripts/dry-deploy-controller.ts')
})

test('Incomplete Cloudflare provenance surfaces are not exposed as release evidence', () => {
  for (const file of ['cloudflare-route.ts', 'cloudflare-zone.ts']) {
    assert.equal(fs.existsSync(`${ROOT}/scripts/production-release/${file}`), false, file)
  }
  const contracts = fs.readFileSync(`${ROOT}/scripts/production-release/contracts.ts`, 'utf8')
  const lifecycle = fs.readFileSync(`${ROOT}/scripts/production-release/lifecycle.ts`, 'utf8')
  assert.doesNotMatch(contracts, /production-release\/v3|prior-receipt/u)
  assert.doesNotMatch(lifecycle,
    /bootstrap-success|command === 'release'|rollback-receipt|production-rollback|secrets-file|EDGE_SECRET_NAMES/u)
})

test('Release authority emits a typed pre-mutation refusal for missing platform contracts', () => {
  const json = (value: string) => new TextEncoder().encode(`{"value":"${value}"}\n`)
  const refusal = buildReleaseAuthorityRefusal({
    releaseMode: 'steady-state',
    candidateSha: CANDIDATE,
    runId: 42,
    runAttempt: 1,
    humanAuthorization: json('human'),
    coreBundleProof: json('core'),
    edgeBundleProof: json('edge'),
  })
  assert.equal(refusal.mutationAttempted, false)
  assert.equal(refusal.mutationCredentialExposed, false)
  assert.deepEqual(refusal.reasons, [
    'external-transition-cas-unavailable',
    'externally-attested-evidence-unavailable',
    'remote-migration-identity-unavailable',
    'mixed-worker-version-compatibility-unproven',
  ])
  assert.throws(() => buildReleaseAuthorityRefusal({
    releaseMode: 'bootstrap', candidateSha: CANDIDATE, runId: 42, runAttempt: 2,
    humanAuthorization: json('human'),
    coreBundleProof: json('core'), edgeBundleProof: json('edge'),
  }), /run_attempt_not_authorizable/u)
})
