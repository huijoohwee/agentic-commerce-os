import {
  createInvocationClient,
  DOCS_INVOCATION_ENDPOINT,
  DOCS_INVOCATION_TOOL,
  type InvocationCatalogEntry,
  type InvocationCatalogSnapshot,
  type InvocationClient,
} from '../invocation/index.js'
import capabilityMapJson from '../../config/capability-token-map.json' with { type: 'json' }
import {
  coverageFindings,
  readCapabilityMap,
} from '../invocation/capability-map.js'
import { CATALOG_LIMIT } from '../invocation/catalog.js'
import { readSelectionPolicy, type SelectionPolicy } from '../domain/selection-policy.js'
import { isRecord, readJsonResponse } from '../shared/http.js'
import { authenticateCommerceProviderControlRequest } from '../shared/commerce-provider-auth.js'
import { registryStub } from './core-clients.js'
import { listMcpToolNames } from './mcp-provider.js'
import {
  CHECKOUT_PROVIDER_CONTRACT,
  DISCOVERY_PROVIDER_CONTRACT,
  MARKETPLACE_PROVIDER_CONTRACT,
} from './provider-contract.js'
import { probeAcosAdmission, readAcosDeploymentPin } from './acos-admission.js'
import { probeRegistrationSandbox } from './sandbox-registration.js'
import type { InvocationPinProof } from './agent-registry.js'
import { takeRateConfigurationFailure } from './take-rate.js'
import {
  providerAuthenticationConfiguration,
  releaseCandidateConfiguration,
} from './core-readiness-configuration.js'
import {
  CHECKOUT_EVIDENCE_CHECKS,
  COMMERCE_PRD_REVISION,
  DISCOVERY_EVIDENCE_CHECKS,
  MARKETPLACE_EVIDENCE_CHECKS,
  readUpstreamEvidencePin,
  verifyUpstreamRuntimeEvidence,
} from './upstream-evidence.js'
import {
  blockedConvergenceVerdict,
  type ConvergenceVerdict,
} from './convergence-evaluator.js'

const MAXIMUM_PROVIDER_RESPONSE_BYTES = 1_000_000
const TOKEN_PATTERN = /^[/#@][A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}|[A-Za-z0-9._-]{0,125}:)$/u
const MAXIMUM_PRESENTED_TOKENS = CATALOG_LIMIT
const CAPABILITY_MAP = readCapabilityMap(capabilityMapJson)

type InvocationCatalogCache = Readonly<{
  binding: Fetcher
  bearerToken: string
  client: InvocationClient
  snapshot: InvocationCatalogSnapshot
  priorSourceRevision: string | null
}>

let invocationCatalogCache: InvocationCatalogCache | null = null
let invocationCatalogHydration: Promise<InvocationCatalogCache> | null = null

export type CoreReadinessReport = Readonly<{
  ok: boolean
  contract: 'commerce.core-readiness/v2'
  lane: string
  releaseCandidateSha: string
  releaseCandidateDigest: string
  version: WorkerVersionMetadata
  sourceReadiness: Readonly<{ ok: boolean; checks: readonly CheckResult[] }>
  liveReleaseReadiness: Readonly<{
    ok: boolean
    reason: string | null
    servingCandidateSha: string | null
  }>
  convergence: readonly ProviderConvergence[]
}>

export type ProviderConvergence = Readonly<{
  provider: string
  source: ConvergenceVerdict
  live: ConvergenceVerdict
}>

type CheckResult = Readonly<{ name: string; ok: boolean; detail?: unknown; code?: string }>

export async function readiness(env: CoreEnv): Promise<CoreReadinessReport> {
  const requiredTokens = configuredTokens(env)
  const acosDeploymentPin = readAcosDeploymentPin(
    env.ACOS_RUNTIME_SOURCE_REVISION,
    env.ACOS_RUNTIME_CANDIDATE_DIGEST,
  )
  const invocationResolution = resolvePinnedInvocations(env, requiredTokens, { refresh: true })
  const liveReason = env.DEPLOY_LANE.toLowerCase() === 'dev'
    ? 'delivery_route_unauthorized_in_dev'
    : 'delivery_route_live_unknown'
  const checkoutConvergence = probeProviderConvergence(
    env.CHECKOUT_PROVIDER,
    'checkout-provider.internal',
    CHECKOUT_PROVIDER_CONTRACT,
    env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON,
    CHECKOUT_EVIDENCE_CHECKS,
    env.CHECKOUT_PROVIDER_AUTH_SECRET,
    liveReason,
  )
  const discoveryConvergence = probeProviderConvergence(
    env.DOCS_MCP,
    'discovery-provider.internal',
    DISCOVERY_PROVIDER_CONTRACT,
    env.DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON,
    DISCOVERY_EVIDENCE_CHECKS, undefined,
    liveReason,
  )
  const marketplaceConvergence = probeProviderConvergence(
    env.MARKETPLACE_PROVIDER,
    'marketplace-provider.internal',
    MARKETPLACE_PROVIDER_CONTRACT,
    env.MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON,
    MARKETPLACE_EVIDENCE_CHECKS,
    env.MARKETPLACE_PROVIDER_AUTH_SECRET,
    liveReason,
  )
  const checks = await Promise.all([
    check('release_candidate', async () => releaseCandidateConfiguration(
      env.DEPLOY_LANE,
      env.RELEASE_CANDIDATE_SHA,
      env.RELEASE_CANDIDATE_DIGEST,
    )),
    check('take_rate_configuration', async () => takeRateConfigurationFailure(env.AG_TAKE_RATE_BASIS_POINTS)
      ?? Object.freeze({ ok: true })),
    check('selection_policy', async () => Object.freeze({ ok: readSelectionPolicyFromEnv(env) !== null })),
    check('provider_auth_configuration', async () => providerAuthenticationConfiguration(env)),
    check('acos_admission', async () => probeAcosAdmission(
      env.ACOS_ADMISSION, acosDeploymentPin, env.AGENTIC_OS_ADMISSION_AUTH_SECRET,
    )),
    check('registration_sandbox', async () => probeRegistrationSandbox(
      env.COMMERCE_SANDBOX,
      env.DEPLOY_LANE,
      env.RELEASE_CANDIDATE_SHA,
      env.RELEASE_CANDIDATE_DIGEST,
    )),
    check('registry', async () => registryStub(env).health(invocationProofFromResolution(
      await invocationResolution,
      requiredTokens,
    ))),
    check('invocation_catalog', async () => invocationResolution),
    check('invocation_capability_coverage', async () => capabilityCoverage(env)),
    check('mcp_tools', async () => {
      const registered = (await registryStub(env).list()).agents
        .filter(({ registrationState, admissionVerified }) => registrationState === 'active' && admissionVerified)
        .map(({ discoveryTool }) => discoveryTool)
      const names = await listMcpToolNames(env.DOCS_MCP, env.DISCOVERY_PROVIDER_BEARER_TOKEN)
      const missing = [DOCS_INVOCATION_TOOL, ...registered].filter((name) => !names.includes(name))
      return Object.freeze({ ok: missing.length === 0, missing: Object.freeze(missing) })
    }),
    check('discovery_provider_contract', async () => probeCapabilities(
      env.DOCS_MCP,
      'discovery-provider.internal',
      DISCOVERY_PROVIDER_CONTRACT,
      ['mcp-dispatch-evidence-bound'],
    )),
    check('discovery_provider_evidence', async () => convergenceCheck(await discoveryConvergence)),
    check('commerce_provider', async () => probe(env.CHECKOUT_PROVIDER, '/readyz')),
    check('commerce_provider_contract', async () => probeCapabilities(
      env.CHECKOUT_PROVIDER,
      'checkout-provider.internal',
      CHECKOUT_PROVIDER_CONTRACT,
      ['prepare', 'confirm', 'status', 'offer-observe'],
      env.CHECKOUT_PROVIDER_AUTH_SECRET,
    )),
    check('checkout_provider_evidence', async () => convergenceCheck(await checkoutConvergence)),
    check('marketplace_provider', async () => probe(env.MARKETPLACE_PROVIDER, '/readyz')),
    check('marketplace_provider_contract', async () => probeCapabilities(
      env.MARKETPLACE_PROVIDER,
      'marketplace-provider.internal',
      MARKETPLACE_PROVIDER_CONTRACT,
      ['vendor-list', 'vendor-transition-fenced', 'settlement-read'],
      env.MARKETPLACE_PROVIDER_AUTH_SECRET,
    )),
    check('marketplace_provider_evidence', async () => convergenceCheck(await marketplaceConvergence)),
  ])
  const convergence = await Promise.all([discoveryConvergence, checkoutConvergence, marketplaceConvergence])
  const sourceOk = checks.every(({ ok }) => ok)
    && convergence.every(({ source }) => source.state !== 'blocked')
  const liveOk = convergence.every(({ live }) => live.state !== 'blocked')
  const liveReleaseReadiness = Object.freeze({
    ok: liveOk,
    reason: liveOk ? null : liveReason,
    servingCandidateSha: null,
  })
  return Object.freeze({
    ok: sourceOk && liveReleaseReadiness.ok,
    contract: 'commerce.core-readiness/v2',
    lane: env.DEPLOY_LANE,
    releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
    releaseCandidateDigest: env.RELEASE_CANDIDATE_DIGEST,
    version: env.CF_VERSION_METADATA,
    sourceReadiness: Object.freeze({ ok: sourceOk, checks: Object.freeze(checks) }),
    liveReleaseReadiness,
    convergence: Object.freeze(convergence),
  })
}

export async function resolvePinnedInvocations(
  env: CoreEnv,
  tokens: readonly string[],
  options: Readonly<{ refresh?: boolean }> = {},
) {
  const catalog = await pinnedInvocationCatalog(env, options.refresh === true)
  const invocations = tokens.map((token) => {
    if (!TOKEN_PATTERN.test(token)) throw new Error('configured_invocation_tokens_invalid')
    return catalog.snapshot.entries.find((entry) => entry.token === token)
      ?? throwConfiguration('configured_invocation_token_unresolved')
  })
  return Object.freeze({
    ok: true,
    priorSourceRevision: catalog.priorSourceRevision,
    sourceRevision: catalog.snapshot.sourceRevision,
    catalogDigest: catalog.snapshot.catalogDigest,
    routingSchema: catalog.snapshot.routingSchema,
    routingDigest: catalog.snapshot.routingDigest,
    counts: catalog.snapshot.counts,
    invocations: Object.freeze(invocations),
  })
}

export async function resolvePresentedInvocations(env: CoreEnv, tokens: readonly string[]): Promise<unknown> {
  if (tokens.length < 1 || tokens.length > MAXIMUM_PRESENTED_TOKENS) {
    return Object.freeze({ ok: false, code: 'invocation_tokens_malformed' })
  }
  const syntacticallyValid = tokens.filter((token) => TOKEN_PATTERN.test(token))
  let catalog: InvocationCatalogCache | null = null
  if (syntacticallyValid.length > 0) {
    try {
      catalog = await pinnedInvocationCatalog(env, false)
    } catch {
      return Object.freeze({
        ok: false,
        code: 'invocation_catalog_unavailable',
        source: DOCS_INVOCATION_ENDPOINT,
        tokens: Object.freeze([...tokens]),
      })
    }
  }
  const results = tokens.map((token) => {
    const invocation = catalog?.snapshot.entries.find((entry) => entry.token === token) ?? null
    return catalog && invocation
      ? resolvedPresentedInvocation(invocation, catalog)
      : Object.freeze({ ok: false, code: 'invocation_token_unresolved', token })
  })
  return Object.freeze({
    ok: results.every((result) => result.ok),
    priorSourceRevision: catalog?.priorSourceRevision ?? null,
    sourceRevision: catalog?.snapshot.sourceRevision ?? null,
    catalogDigest: catalog?.snapshot.catalogDigest ?? null,
    counts: catalog?.snapshot.counts ?? null,
    results: Object.freeze(results),
    invocations: Object.freeze(results.flatMap((result) => (
      result.ok && 'invocation' in result ? [result.invocation] : []
    ))),
  })
}

export async function authorizeCapabilityAction(env: CoreEnv, capabilityAction: string): Promise<unknown> {
  const entry = CAPABILITY_MAP?.find((candidate) => candidate.capabilityAction === capabilityAction)
  if (!entry) {
    return Object.freeze({ ok: false, code: 'invocation_capability_unmapped', capabilityAction })
  }
  let catalog: InvocationCatalogCache
  try {
    catalog = await pinnedInvocationCatalog(env, false)
  } catch {
    return Object.freeze({
      ok: false,
      code: 'invocation_catalog_unavailable',
      capabilityAction,
      source: DOCS_INVOCATION_ENDPOINT,
    })
  }
  const findings = coverageFindings(Object.freeze([entry]), catalog.snapshot)
  if (findings.length > 0) {
    return Object.freeze({
      ok: false,
      code: 'invocation_capability_upstream_coverage_missing',
      capabilityAction,
      source: DOCS_INVOCATION_ENDPOINT,
      sourceRevision: catalog.snapshot.sourceRevision,
      findings,
    })
  }
  return Object.freeze({
    ok: true,
    capabilityAction,
    commandToken: entry.commandToken,
    semanticTokens: entry.semanticTokens,
    bindingTokens: entry.bindingTokens,
    mcpTool: entry.mcpTool,
    priorSourceRevision: catalog.priorSourceRevision,
    sourceRevision: catalog.snapshot.sourceRevision,
    catalogDigest: catalog.snapshot.catalogDigest,
    counts: catalog.snapshot.counts,
  })
}

export function configuredTokens(env: CoreEnv): readonly string[] {
  return readTokenArray(JSON.parse(env.ACOS_REQUIRED_TOKENS_JSON) as unknown)
    ?? throwConfiguration('configured_invocation_tokens_invalid')
}

export function configuredInvocationProof(env: CoreEnv): InvocationPinProof {
  const counts = JSON.parse(env.ACOS_CATALOG_COUNTS_JSON) as unknown
  if (!isRecord(counts)) throw new Error('invocation_catalog_pin_mismatch')
  return Object.freeze({
    sourceRevision: env.ACOS_SOURCE_REVISION,
    catalogDigest: env.ACOS_CATALOG_DIGEST,
    routingSchema: env.ACOS_ROUTING_SCHEMA,
    routingDigest: env.ACOS_ROUTING_DIGEST,
    counts: Object.freeze({ command: Number(counts.command), semantic: Number(counts.semantic), binding: Number(counts.binding) }),
    requiredTokens: configuredTokens(env),
  })
}

export function invocationProofFromResolution(
  resolution: Awaited<ReturnType<typeof resolvePinnedInvocations>>,
  requiredTokens: readonly string[],
): InvocationPinProof {
  if (JSON.stringify(resolution.invocations.map(({ token }) => token)) !== JSON.stringify(requiredTokens)) {
    throw new Error('invocation_catalog_pin_mismatch')
  }
  return Object.freeze({
    sourceRevision: resolution.sourceRevision,
    catalogDigest: resolution.catalogDigest,
    routingSchema: resolution.routingSchema,
    routingDigest: resolution.routingDigest,
    counts: Object.freeze({ ...resolution.counts }),
    requiredTokens: Object.freeze([...requiredTokens]),
  })
}

export function readSelectionPolicyFromEnv(env: CoreEnv): SelectionPolicy | null {
  try {
    return readSelectionPolicy(JSON.parse(env.AG_SELECTION_POLICY_JSON) as unknown)
  } catch {
    return null
  }
}

export function readTokenArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > CATALOG_LIMIT) return null
  const tokens = value.filter((entry): entry is string => typeof entry === 'string')
  if (tokens.length !== value.length
    || new Set(tokens).size !== tokens.length
    || tokens.some((token) => !TOKEN_PATTERN.test(token))) return null
  return Object.freeze(tokens)
}

function assertPinnedSnapshot(env: CoreEnv, snapshot: InvocationCatalogSnapshot): void {
  const expectedCounts = JSON.parse(env.ACOS_CATALOG_COUNTS_JSON) as unknown
  if (snapshot.sourceRevision !== env.ACOS_SOURCE_REVISION
    || snapshot.catalogDigest !== env.ACOS_CATALOG_DIGEST
    || snapshot.routingSchema !== env.ACOS_ROUTING_SCHEMA
    || snapshot.routingDigest !== env.ACOS_ROUTING_DIGEST
    || JSON.stringify(snapshot.counts) !== JSON.stringify(expectedCounts)) throw new Error('invocation_catalog_pin_mismatch')
}

async function capabilityCoverage(env: CoreEnv): Promise<unknown> {
  if (!CAPABILITY_MAP) {
    return Object.freeze({ ok: false, code: 'invocation_capability_map_invalid' })
  }
  const catalog = await pinnedInvocationCatalog(env, false)
  const findings = coverageFindings(CAPABILITY_MAP, catalog.snapshot)
  return Object.freeze({
    ok: findings.length === 0,
    source: DOCS_INVOCATION_ENDPOINT,
    sourceRevision: catalog.snapshot.sourceRevision,
    actionCount: CAPABILITY_MAP.length,
    findings,
  })
}

async function pinnedInvocationCatalog(env: CoreEnv, refresh: boolean): Promise<InvocationCatalogCache> {
  const current = invocationCatalogCache?.binding === env.DOCS_MCP
    && invocationCatalogCache.bearerToken === env.DISCOVERY_PROVIDER_BEARER_TOKEN
    ? invocationCatalogCache
    : null
  if (current && !refresh) return current
  if (invocationCatalogHydration) return invocationCatalogHydration
  const client = current?.client
    ?? createInvocationClient({
      endpoint: DOCS_INVOCATION_ENDPOINT,
      fetcher: env.DOCS_MCP,
      bearerToken: env.DISCOVERY_PROVIDER_BEARER_TOKEN,
    })
  invocationCatalogHydration = (async () => {
    const snapshot = current
      ? await client.refresh({ signal: AbortSignal.timeout(10_000) })
      : await client.hydrate({ signal: AbortSignal.timeout(10_000) })
    assertPinnedSnapshot(env, snapshot)
    const priorSourceRevision = current && current.snapshot.sourceRevision !== snapshot.sourceRevision
      ? current.snapshot.sourceRevision
      : current?.priorSourceRevision ?? null
    const next = Object.freeze({
      binding: env.DOCS_MCP,
      bearerToken: env.DISCOVERY_PROVIDER_BEARER_TOKEN,
      client,
      snapshot,
      priorSourceRevision,
    })
    invocationCatalogCache = next
    return next
  })().catch(async (error) => {
    invocationCatalogCache = null
    await client.close({ signal: AbortSignal.timeout(1_000) })
    throw error
  }).finally(() => {
    invocationCatalogHydration = null
  })
  return invocationCatalogHydration
}

function resolvedPresentedInvocation(
  invocation: InvocationCatalogEntry,
  catalog: InvocationCatalogCache,
): Readonly<Record<string, unknown> & { ok: true; invocation: InvocationCatalogEntry }> {
  return Object.freeze({
    ok: true,
    token: invocation.token,
    invocation,
    priorSourceRevision: catalog.priorSourceRevision,
    sourceRevision: catalog.snapshot.sourceRevision,
    catalogDigest: catalog.snapshot.catalogDigest,
    counts: catalog.snapshot.counts,
  })
}

async function probe(binding: Fetcher, path: string): Promise<unknown> {
  const response = await binding.fetch(new Request(new URL(path, 'https://dependency.internal'), {
    method: 'GET', signal: AbortSignal.timeout(5_000),
  }))
  const payload = await readProviderResponse(response)
  return Object.freeze({ ok: response.ok && isRecord(payload) && payload.ok === true, status: response.status })
}

async function probeCapabilities(
  binding: Fetcher,
  hostname: string,
  expectedContract: string,
  requiredOperations: readonly string[],
  authenticationSecret?: string,
): Promise<unknown> {
  const unsigned = new Request(`https://${hostname}/v1/capabilities`, {
    method: 'GET', signal: AbortSignal.timeout(5_000),
  })
  const request = authenticationSecret === undefined ? unsigned : await authenticateCommerceProviderControlRequest(
    unsigned, expectedContract, authenticationSecret,
  )
  if (!request) return Object.freeze({ ok: false, missing: Object.freeze([...requiredOperations]) })
  const response = await binding.fetch(request)
  const payload = await readProviderResponse(response)
  const operations = isRecord(payload) && payload.contract === expectedContract && Array.isArray(payload.operations)
    ? payload.operations
    : []
  const missing = requiredOperations.filter((operation) => !operations.includes(operation))
  return Object.freeze({ ok: response.ok && missing.length === 0, missing: Object.freeze(missing) })
}

async function probeRuntimeEvidence(
  binding: Fetcher,
  hostname: string,
  expectedContract: string,
  evidencePinJson: string,
  requiredChecks: readonly string[],
  authenticationSecret?: string,
): Promise<unknown> {
  const unsigned = new Request(`https://${hostname}/v1/runtime-evidence`, {
    method: 'GET', signal: AbortSignal.timeout(5_000),
  })
  const request = authenticationSecret === undefined ? unsigned : await authenticateCommerceProviderControlRequest(
    unsigned, expectedContract, authenticationSecret,
  )
  if (!request) return Object.freeze({ ok: false, code: 'provider_authentication_unavailable' })
  const response = await binding.fetch(request)
  const payload = await readProviderResponse(response)
  const result = await verifyUpstreamRuntimeEvidence(
    payload,
    expectedContract,
    readUpstreamEvidencePin(evidencePinJson),
    requiredChecks,
  )
  return Object.freeze({ ...result, status: response.status, ok: response.ok && result.ok === true })
}

async function probeProviderConvergence(
  binding: Fetcher,
  provider: string,
  expectedContract: string,
  evidencePinJson: string,
  requiredChecks: readonly string[],
  authenticationSecret: string | undefined,
  liveReason: string,
): Promise<ProviderConvergence> {
  let source: ConvergenceVerdict
  try {
    const detail = await probeRuntimeEvidence(
      binding,
      provider,
      expectedContract,
      evidencePinJson,
      requiredChecks,
      authenticationSecret,
    )
    const verdict = readVerdict(detail)
    source = verdict && resultOk(detail)
      ? withProvider(verdict, provider)
      : verdict?.state === 'blocked' && providerResponseSucceeded(detail)
        ? withProvider(verdict, provider)
        : blockedConvergenceVerdict(
          provider,
          COMMERCE_PRD_REVISION,
          requiredChecks,
          providerResponseSucceeded(detail)
            ? readResultCode(detail) ?? 'provider_evidence_unavailable'
            : 'provider_evidence_unavailable',
        )
  } catch {
    source = blockedConvergenceVerdict(
      provider,
      COMMERCE_PRD_REVISION,
      requiredChecks,
      'provider_evidence_unavailable',
    )
  }
  return Object.freeze({
    provider,
    source,
    live: blockedConvergenceVerdict(provider, COMMERCE_PRD_REVISION, requiredChecks, liveReason),
  })
}

function convergenceCheck(convergence: ProviderConvergence): Readonly<Record<string, unknown>> {
  const ok = convergence.source.state !== 'blocked'
  return Object.freeze({ ok, code: ok ? null : convergence.source.reason, verdict: convergence.source })
}

async function readProviderResponse(response: Response): Promise<unknown> {
  try {
    return await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
  } catch {
    return Object.freeze({ ok: false, code: 'provider_response_invalid' })
  }
}

async function check(name: string, operation: () => Promise<unknown>): Promise<CheckResult> {
  try {
    const detail = await operation()
    return Object.freeze({ name, ok: resultOk(detail), detail })
  } catch (error) {
    return Object.freeze({ name, ok: false, code: classifyError(error) })
  }
}

function readVerdict(value: unknown): ConvergenceVerdict | null {
  return isRecord(value) && isRecord(value.verdict)
    ? value.verdict as unknown as ConvergenceVerdict
    : null
}

function withProvider(verdict: ConvergenceVerdict, provider: string): ConvergenceVerdict {
  return Object.freeze({ ...verdict, provider })
}

function readResultCode(value: unknown): string | null {
  return isRecord(value) && typeof value.code === 'string' ? value.code : null
}

function providerResponseSucceeded(value: unknown): boolean {
  return isRecord(value)
    && typeof value.status === 'number'
    && value.status >= 200
    && value.status < 300
}

function resultOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error'
  if (error.message.includes('pin')) return 'dependency_pin_mismatch'
  if (error.message.includes('catalog')) return 'invocation_catalog_unavailable'
  if (error.message.includes('MCP')) return 'mcp_dependency_unavailable'
  return 'dependency_unavailable'
}

function throwConfiguration(message: string): never {
  throw new Error(message)
}
