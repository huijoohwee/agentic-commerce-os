import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildReleaseAuthorityRefusal } from '../../scripts/production-release/release-authority.ts'

import { describeProductionSetup } from '../../scripts/production-release/run-production-release.ts'
import { readAcosDeploymentIdentity, readAcosDeploymentPin, validAcosDeploymentPin }
  from '../../src/core/acos-deployment-identity.ts'

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


test('Production preflight reports every input and never leaks malformed secret values', () => {
  const empty = describeProductionSetup({})
  assert.equal(empty.inputs.length, 16)
  assert.ok(empty.inputs.every(input => input.status === 'missing'))
  assert.equal(empty.configurationValid, false)
  const sensitive = 'operator-private-value-'.repeat(3)
  const report = describeProductionSetup({
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: sensitive,
    HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON: `{invalid:${sensitive}`,
    PRODUCTION_ROUTE_AUTHORITY_JSON: sensitive, MCP_BEARER_TOKEN: '',
  })
  const statuses = Object.fromEntries(report.inputs.map(input => [input.name, input.status]))
  assert.equal(statuses.CLOUDFLARE_API_TOKEN, 'valid')
  assert.equal(statuses.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON, 'invalid')
  assert.equal(statuses.PRODUCTION_ROUTE_AUTHORITY_JSON, 'invalid')
  assert.equal(statuses.MCP_BEARER_TOKEN, 'invalid')
  assert.ok(!JSON.stringify(report).includes(sensitive))
})

test('Valid configuration shape cannot claim authenticated production readiness', () => {
  const env: Record<string, string> = Object.fromEntries(
    describeProductionSetup({}).inputs.map(input => [input.name, 'f'.repeat(64)]))
  env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32)
  env.ACOS_RUNTIME_SOURCE_REVISION = CANDIDATE
  const pin = JSON.stringify({ sourceRevision: CANDIDATE, receiptDigest: 'd'.repeat(64),
    storageCompatibilityRevision: 'v1', providerVersionId: 'provider-1' })
  for (const name of ['DISCOVERY', 'CHECKOUT', 'MARKETPLACE']) env[`${name}_PROVIDER_EVIDENCE_PIN_JSON`] = pin
  env.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON = JSON.stringify({
    schema: 'agentic-graph-human-presence-trust-anchor/v1', issuer: 'test-only-issuer',
    publicKeySpkiBase64: Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
  })
  env.PRODUCTION_ROUTE_AUTHORITY_JSON = JSON.stringify({
    schema: 'agentic-commerce-production-route-authority/v2', mode: 'bootstrap',
    zoneId: 'b'.repeat(32), zoneName: 'airvio.co', routeId: null,
    pattern: 'airvio.co/agentic-commerce-os*', script: 'agentic-commerce-edge-production',
  })
  const report = describeProductionSetup(env)
  assert.deepEqual(report.inputs.filter(input => input.status !== 'valid'), [])
  assert.equal(report.configurationValid, true)
  assert.equal(report.grantsAuthority, false)
  assert.equal(report.remoteStateObserved, false)
  assert.equal(report.productionRuntimeReady, false)
  assert.ok(report.requiredExternalEvidence.length > 0)
  env.AGENTIC_OS_ADMISSION_AUTH_SECRET = 'f'.repeat(257)
  assert.equal(describeProductionSetup(env).inputs.find(input =>
    input.name === 'AGENTIC_OS_ADMISSION_AUTH_SECRET')?.status, 'invalid')
})

test('Production setup rejects undeployed identity sentinels', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
    ACOS_RUNTIME_SOURCE_REVISION: '0'.repeat(40),
    ACOS_RUNTIME_CANDIDATE_DIGEST: '0'.repeat(64),
    DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify({ sourceRevision: '0'.repeat(40),
      receiptDigest: 'd'.repeat(64), storageCompatibilityRevision: 'v1', providerVersionId: 'provider-1' }),
  }
  const report = describeProductionSetup(env)
  assert.equal(report.configurationValid, false)
  for (const name of Object.keys(env)) {
    assert.equal(report.inputs.find(input => input.name === name)?.status, 'invalid', name)
  }
})

test('Admission refuses zero identities even when the expected pin matches the sentinel', () => {
  const valid = { sourceRevision: CANDIDATE, candidateDigest: 'd'.repeat(64) }
  for (const [field, length] of [['sourceRevision', 40], ['candidateDigest', 64]] as const) {
    const pin = { ...valid, [field]: '0'.repeat(length) }
    assert.equal(readAcosDeploymentPin(pin.sourceRevision, pin.candidateDigest), null)
    assert.equal(validAcosDeploymentPin(pin), false)
    assert.equal(readAcosDeploymentIdentity({ schema: 'acos-cloudflare-deployment-identity/v1',
      ...pin, versionId: '11223344-5566-4788-99aa-bbccddeeff00',
      versionTag: `acos-prod-${pin.candidateDigest}`, versionTimestamp: '2026-09-09T00:00:00Z' }, pin), null)
    const leadingZero = { ...valid, [field]: `${'0'.repeat(length - 1)}1` }
    assert.deepEqual(readAcosDeploymentPin(leadingZero.sourceRevision, leadingZero.candidateDigest), leadingZero)
  }
})

test('Preflight CLI works without Git or credentials and refuses extra arguments', () => {
  const script = `${ROOT}/scripts/production-release/run-production-release.ts`
  const result = spawnSync(process.execPath, [script, 'preflight'], {
    cwd: '/', env: { PATH: '/unavailable' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  assert.ok(JSON.parse(result.stdout).inputs.every((input: { status: string }) => input.status === 'missing'))
  const extra = spawnSync(process.execPath, [script, 'preflight', 'execute'], {
    cwd: '/', env: { PATH: '/unavailable' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(extra.status, 1)
  assert.match(extra.stderr, /arguments_invalid/u)
})
