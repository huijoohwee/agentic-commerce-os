import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateSandboxContainerDeployment } from '../../scripts/production-release/container-release.ts'
import { evidenceDigest } from '../../scripts/production-release/controller-receipts.ts'
import {
  executeProductionRelease,
  type ProductionControllerInput,
  type ProductionReleaseAdapter,
} from '../../scripts/production-release/production-controller.ts'
import {
  parsePriorReleaseAuthority,
  PRIOR_RELEASE_AUTHORITY_SCHEMA,
  RECOVERY_RELEASE_AUTHORITY_PROOF_SCHEMA,
} from '../../scripts/production-release/prior-release-authority.ts'
import {
  parseProductionRouteAuthority,
  PRODUCTION_ROUTE_AUTHORITY_SCHEMA,
  type ProductionRouteAuthority,
} from '../../scripts/production-release/route-authority.ts'
import {
  PRODUCTION_EDGE_WORKER,
  PRODUCTION_ROUTE_PATTERN,
  PRODUCTION_ZONE_NAME,
} from '../../scripts/production-release/contracts.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CANDIDATE = 'a'.repeat(40)
const DIGEST = 'b'.repeat(64)
const BUILD_INPUT = 'c'.repeat(64)
const ROUTE_ID = 'd'.repeat(32)
const WORKERS = ['sandbox', 'core', 'edge'] as const
type Kind = typeof WORKERS[number]
type Failure = 'after-sandbox' | 'container' | 'after-core' | 'after-edge' | 'after-route' | 'live'

test('bootstrap controller deploys the exact candidate and emits a non-atomic live receipt', async () => {
  const adapter = new FakeReleaseAdapter()
  const outcome = await executeProductionRelease(input('bootstrap', adapter))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.receipt.disposition, 'deployed-and-live-verified')
  assert.equal(outcome.receipt.releaseSemantics.atomic, false)
  assert.deepEqual(outcome.receipt.workerVersions.candidates, {
    sandbox: 'sandbox-candidate', core: 'core-candidate', edge: 'edge-candidate',
  })
})

test('authenticated preserve recovery converges after every remote mutation boundary', async () => {
  for (const failure of [
    'after-sandbox', 'container', 'after-core', 'after-edge', 'after-route', 'live',
  ] as const) {
    const adapter = new FakeReleaseAdapter(failure)
    const first = await executeProductionRelease(input('bootstrap', adapter))
    assert.equal(first.ok, false, failure)
    if (first.ok) throw new Error(`expected ${failure} to preserve`)
    assert.equal(first.receipt.disposition, 'preserve-and-forward-recover', failure)
    if (failure === 'after-sandbox') {
      assert.equal(first.receipt.candidates.sandbox, undefined)
      assert.equal(first.receipt.observedActive.sandbox, 'sandbox-candidate')
      assert.equal(first.receipt.sandboxMutationStarted, true)
    }
    const recovery = await executeProductionRelease(input('recovery', adapter, first.receipt))
    assert.equal(recovery.ok, true, `${failure}: ${recovery.ok ? '' : recovery.cause}`)
    if (!recovery.ok) continue
    assert.equal(recovery.receipt.releaseMode, 'recovery')
    assert.equal(recovery.receipt.disposition, 'deployed-and-live-verified')
    assert.deepEqual(adapter.active, {
      sandbox: 'sandbox-candidate', core: 'core-candidate', edge: 'edge-candidate',
    })
  }
})

test('authority and container parsers reject unknown identity and shape drift', () => {
  const authority = parseProductionRouteAuthority(routeAuthority())
  assert.equal(authority.pattern, PRODUCTION_ROUTE_PATTERN)
  assert.throws(() => parseProductionRouteAuthority({ ...routeAuthority(), extra: true }), /authority_shape_invalid/u)
  assert.throws(() => parsePriorReleaseAuthority({
    schema: PRIOR_RELEASE_AUTHORITY_SCHEMA,
    repository: 'owner/repository',
    workflowRunId: 1,
    artifactId: 2,
    artifactName: `production-release-bootstrap-${CANDIDATE}`,
    artifactDigest: DIGEST,
    extra: true,
  }), /authority_shape_invalid/u)
  assert.equal(validateSandboxContainerDeployment(containerInventory(), BUILD_INPUT).applicationVersion, 1)
  const malformed = structuredClone(containerInventory()) as Array<Record<string, unknown>>
  malformed[0]!.extra = true
  assert.throws(() => validateSandboxContainerDeployment(malformed, BUILD_INPUT), /container_application_shape_invalid/u)
})

function input(
  releaseMode: 'bootstrap' | 'recovery',
  adapter: FakeReleaseAdapter,
  recoveryReceipt: ProductionControllerInput['recoveryReceipt'] = null,
): ProductionControllerInput {
  const runId = releaseMode === 'bootstrap' ? 1 : 2
  return Object.freeze({
    releaseMode,
    identity: Object.freeze({
      candidateSha: CANDIDATE,
      candidateTree: 'e'.repeat(40),
      packageLockDigest: '1'.repeat(64),
      coreConfigDigest: '2'.repeat(64),
      coreServicesManifestDigest: '7'.repeat(64),
      edgeConfigDigest: '3'.repeat(64),
      sandboxConfigDigest: '4'.repeat(64),
      sandboxContainerBuildInputDigest: BUILD_INPUT,
      durableObjectStorageCompatibilityRevision: '5'.repeat(64),
      sandboxStorageCompatibilityRevision: '6'.repeat(64),
      candidateDigest: DIGEST,
    }),
    runId,
    humanAuthorization: Object.freeze({
      schema: 'agentic-commerce-production-human-authorization/v1',
      decision: 'approved',
      environment: 'production',
      releaseMode,
      candidateSha: CANDIDATE,
      runId,
      runAttempt: 1,
      approver: Object.freeze({ login: 'release-reviewer', id: 7, type: 'User' }),
      observedAt: '2026-09-03T00:00:00.000Z',
      source: 'github-actions-run-approval-history',
    }),
    operatorPins: PINS,
    routeAuthority: routeAuthority(),
    secrets: Object.freeze(Object.fromEntries([
      'DISCOVERY_PROVIDER_BEARER_TOKEN', 'AGENTIC_OS_ADMISSION_AUTH_SECRET',
      'CHECKOUT_PROVIDER_AUTH_SECRET', 'MARKETPLACE_PROVIDER_AUTH_SECRET',
      'MCP_BEARER_TOKEN', 'OPERATOR_BEARER_TOKEN', 'STOREFRONT_SESSION_SECRET',
    ].map((name) => [name, `${name}-secret-value-longer-than-thirty-two`]))),
    priorReceipt: null,
    priorAuthorityProof: recoveryReceipt ? Object.freeze({
      schema: RECOVERY_RELEASE_AUTHORITY_PROOF_SCHEMA,
      repository: 'owner/repository', workflowRunId: 1, workflowRunAttempt: 1,
      workflowHeadSha: CANDIDATE, artifactId: 1,
      artifactName: `production-release-failed-bootstrap-${CANDIDATE}-1`,
      artifactDigest: '7'.repeat(64), receiptDigest: evidenceDigest(recoveryReceipt),
      humanAuthorizationDigest: recoveryReceipt.evidence.humanAuthorizationDigest,
    }) : null,
    recoveryReceipt,
    configs: CONFIGS,
    adapter,
  })
}

const PINS = Object.freeze({
  acosSourceRevision: 'f'.repeat(40),
  acosCandidateDigest: '8'.repeat(64),
  discoveryProviderEvidencePinJson: '{"pin":"discovery"}',
  checkoutProviderEvidencePinJson: '{"pin":"checkout"}',
  marketplaceProviderEvidencePinJson: '{"pin":"marketplace"}',
  humanPresenceTrustAnchorJson: '{"anchor":"human"}',
})

const CONFIGS = Object.freeze({
  sandbox: config('sandbox'), core: config('core'), edge: config('edge'),
})

function config(kind: Kind): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(`${ROOT}/wrangler.${kind}.jsonc`, 'utf8')
    .replace(/^\s*\/\/.*$/gmu, '')) as Record<string, unknown>
}

function routeAuthority(): ProductionRouteAuthority {
  return Object.freeze({
    schema: PRODUCTION_ROUTE_AUTHORITY_SCHEMA,
    mode: 'bootstrap',
    zoneId: '9'.repeat(32),
    zoneName: PRODUCTION_ZONE_NAME,
    routeId: null,
    pattern: PRODUCTION_ROUTE_PATTERN,
    script: PRODUCTION_EDGE_WORKER,
  })
}

class FakeReleaseAdapter implements ProductionReleaseAdapter {
  readonly active: Record<Kind, string | null> = { sandbox: null, core: null, edge: null }
  private readonly versions: Record<Kind, Array<Record<string, unknown>>> = {
    sandbox: [], core: [], edge: [],
  }
  private container: unknown[] = []
  private routeBound = false
  private failed = false
  private readonly failure: Failure | null
  constructor(failure: Failure | null = null) { this.failure = failure }

  async activeVersion(kind: Kind): Promise<string | null> { return this.active[kind] }
  async listVersions(kind: Kind): Promise<unknown> { return structuredClone(this.versions[kind]) }
  async uploadInactive(kind: 'core' | 'edge'): Promise<void> { this.addVersion(kind) }
  async deploySandbox(): Promise<void> {
    this.addVersion('sandbox')
    this.active.sandbox = 'sandbox-candidate'
    this.container = containerInventory()
    this.failOnce('after-sandbox')
  }
  async viewVersion(kind: Kind, versionId: string): Promise<unknown> {
    assert.equal(versionId, `${kind}-candidate`)
    return workerVersion(kind, versionId)
  }
  async activate(kind: 'core' | 'edge', versionId: string): Promise<void> {
    this.active[kind] = versionId
    this.failOnce(kind === 'core' ? 'after-core' : 'after-edge')
  }
  async waitForSandboxContainer(): Promise<unknown> {
    this.failOnce('container')
    return structuredClone(this.container)
  }
  async containerInventory(): Promise<unknown> { return structuredClone(this.container) }
  async readRouteAuthority(
    _authority: ProductionRouteAuthority,
    _phase: 'before' | 'after' | 'recovery',
  ): Promise<unknown> {
    return this.routeBound
      ? { state: 'bound', id: ROUTE_ID, pattern: PRODUCTION_ROUTE_PATTERN, script: PRODUCTION_EDGE_WORKER }
      : { state: 'absent', id: null, pattern: PRODUCTION_ROUTE_PATTERN, script: null }
  }
  async activateBootstrapRoute(): Promise<void> {
    this.routeBound = true
    this.failOnce('after-route')
  }
  async proveLiveRoute(): Promise<unknown> {
    this.failOnce('live')
    return Object.freeze({ ok: true, schema: 'test-live-route/v1', candidateSha: CANDIDATE })
  }
  private addVersion(kind: Kind): void {
    if (this.versions[kind].some(({ id }) => id === `${kind}-candidate`)) return
    this.versions[kind].push({ id: `${kind}-candidate`, annotations: { 'workers/tag': CANDIDATE } })
  }
  private failOnce(stage: Failure): void {
    if (this.failure === stage && !this.failed) {
      this.failed = true
      throw new Error(`injected-${stage}`)
    }
  }
}

function workerVersion(kind: Kind, versionId: string): Record<string, unknown> {
  const configValue = CONFIGS[kind] as any
  const production = configValue.env.production
  const overrides: Record<string, string> = {
    RELEASE_CANDIDATE_SHA: CANDIDATE,
    RELEASE_CANDIDATE_DIGEST: DIGEST,
    ACOS_RUNTIME_SOURCE_REVISION: PINS.acosSourceRevision,
    ACOS_RUNTIME_CANDIDATE_DIGEST: PINS.acosCandidateDigest,
    DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON: PINS.discoveryProviderEvidencePinJson,
    CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON: PINS.checkoutProviderEvidencePinJson,
    MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON: PINS.marketplaceProviderEvidencePinJson,
    HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON: PINS.humanPresenceTrustAnchorJson,
  }
  return {
    id: versionId,
    annotations: { 'workers/tag': CANDIDATE },
    resources: {
      bindings: [
        ...Object.entries(production.vars).map(([name, value]) => ({
          name, type: 'plain_text', text: overrides[name] ?? value,
        })),
        ...(production.services ?? []).map((value: any) => ({ name: value.binding, type: 'service', ...value })),
        ...(production.durable_objects?.bindings ?? []).map((value: any) => ({
          ...value, type: 'durable_object_namespace',
        })),
        { name: production.version_metadata.binding, type: 'version_metadata' },
        ...((production.secrets?.required ?? []) as string[]).map((name) => ({ name, type: 'secret_text' })),
      ],
      script: { handlers: ['fetch'] },
      script_runtime: {
        compatibility_date: configValue.compatibility_date,
        compatibility_flags: configValue.compatibility_flags,
      },
    },
  }
}

function containerInventory(): Array<Record<string, unknown>> {
  return [{
    id: '123e4567-e89b-42d3-a456-426614174000',
    name: 'agentic-commerce-sandbox-production-sandbox',
    image: `registry.example/sandbox@sha256:${'a'.repeat(64)}`,
    version: 1,
    state: 'active',
    instances: 1,
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:01:00.000Z',
  }]
}
