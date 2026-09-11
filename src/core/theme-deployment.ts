import type { AgentRegistry } from './agent-registry.js'
import type { ThemeDeployment, ActivatedTheme } from './theme-deployment-store.js'
import type { ClaimMutationPermit } from '../domain/authoring-claim-policy.js'
import type { FencedMutationRefusal } from './authoring-mutation-fence.js'
import {
  validateThemeAssetUrl,
  validateThemeManifest,
  type ThemeViolation,
} from '../shared/theme-manifest.js'

export type AssetFetchFailure = Readonly<{
  href: string
  attempts: 3
  lastStatus: number | null
}>

export type DeploymentResult =
  | Readonly<{
      ok: true
      merchantId: string
      manifestDigest: string
      deployedAt: string
      resolvedCatalogScope: readonly string[]
      defaultedFields: readonly string[]
      idempotent: boolean
    }>
  | Readonly<{ ok: false; code: 'theme_manifest_invalid'; violations: readonly ThemeViolation[] }>
  | Readonly<{ ok: false; code: 'theme_merchant_mismatch' }>
  | Readonly<{ ok: false; code: 'theme_scope_agent_not_registered'; agentIds: readonly string[] }>
  | Readonly<{ ok: false; code: 'theme_asset_unreachable'; failures: readonly AssetFetchFailure[] }>
  | Readonly<{ ok: false; code: 'theme_activation_failed' }>
  | Readonly<{ ok: false; code: 'theme_review_invalid' | 'theme_review_stale' }>
  | FencedMutationRefusal

type RegistryClient = Readonly<{ list: AgentRegistry['list'] }>
type DeploymentClient = Readonly<{
  activate: ThemeDeployment['activate']
  current: ThemeDeployment['current']
}>

export type PreparedThemeDeployment = Readonly<{ ok: true; record: ActivatedTheme; expectedPreviousManifestDigest?: string | null }>
  | Exclude<DeploymentResult, { ok: true }>

const ASSET_ATTEMPT_TIMEOUT_MS = 9_000

export async function prepareThemeDeployment(
  env: CoreEnv,
  merchantId: string,
  value: unknown,
): Promise<PreparedThemeDeployment> {
  let expectedPreviousManifestDigest: string | null | undefined
  if (value && typeof value === 'object' && 'manifest' in value) {
    const envelope = value as Record<string, unknown>
    const expected = envelope.expectedPreviousManifestDigest
    if (Object.keys(envelope).sort().join(',') !== 'expectedPreviousManifestDigest,manifest'
      || (expected !== null && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/u.test(expected)))) {
      return Object.freeze({ ok: false, code: 'theme_review_invalid' })
    }
    expectedPreviousManifestDigest = expected as string | null
    value = envelope.manifest
  }
  const verdict = await validateThemeManifest(value)
  if (!verdict.ok) return Object.freeze({ ok: false, code: 'theme_manifest_invalid', violations: verdict.violations })
  if (verdict.manifest.merchantId !== merchantId) {
    return Object.freeze({ ok: false, code: 'theme_merchant_mismatch' })
  }
  const registry = env.AGENT_REGISTRY.getByName(env.REGISTRY_ID) as unknown as RegistryClient
  const snapshot = await registry.list()
  const activeIds = new Set(snapshot.agents
    .filter(({ registrationState, admissionVerified }) => registrationState === 'active' && admissionVerified)
    .map(({ agentId }) => agentId))
  const missing = verdict.manifest.catalogScope.filter((agentId) => !activeIds.has(agentId)).sort(compareText)
  if (missing.length > 0) {
    return Object.freeze({ ok: false, code: 'theme_scope_agent_not_registered', agentIds: Object.freeze(missing) })
  }
  const failures = await validateAssets(verdict.manifest.logo.href)
  if (failures.length > 0) {
    return Object.freeze({ ok: false, code: 'theme_asset_unreachable', failures: Object.freeze(failures) })
  }
  const deployedAtMs = Date.now()
  const record: ActivatedTheme = Object.freeze({
    merchantId,
    manifestDigest: verdict.digest,
    manifest: verdict.manifest,
    resolvedCatalogScope: Object.freeze([...verdict.manifest.catalogScope]),
    defaultedFields: Object.freeze([...verdict.defaultedFields]),
    deployedAtMs,
    deployedAt: new Date(deployedAtMs).toISOString(),
  })
  return Object.freeze({ ok: true, record,
    ...(expectedPreviousManifestDigest !== undefined ? { expectedPreviousManifestDigest } : {}),
  })
}

export async function activatePreparedTheme(
  env: CoreEnv,
  prepared: Extract<PreparedThemeDeployment, { ok: true }>,
  permit: ClaimMutationPermit,
): Promise<DeploymentResult> {
  const { record } = prepared
  const store = env.THEME_DEPLOYMENT.getByName(record.merchantId) as unknown as DeploymentClient
  const activation = await store.activate(record, permit, prepared.expectedPreviousManifestDigest)
  if (isFencedMutationRefusal(activation)) return activation
  if (activation && typeof activation === 'object' && 'code' in activation && activation.code === 'theme_review_stale') {
    return Object.freeze({ ok: false, code: 'theme_review_stale' })
  }
  if (!isActivation(activation, record.merchantId, record.manifestDigest)) {
    return Object.freeze({ ok: false, code: 'theme_activation_failed' })
  }
  const activated = activation.record
  return Object.freeze({
    ok: true,
    merchantId: activated.merchantId,
    manifestDigest: activated.manifestDigest,
    deployedAt: activated.deployedAt,
    resolvedCatalogScope: activated.resolvedCatalogScope,
    defaultedFields: activated.defaultedFields,
    idempotent: activation.idempotent,
  })
}

function isFencedMutationRefusal(value: unknown): value is FencedMutationRefusal {
  return value !== null
    && typeof value === 'object'
    && 'ok' in value
    && value.ok === false
    && 'code' in value
    && ['claim_malformed', 'mutation_out_of_write_set', 'mutation_request_mismatch', 'lease_expired', 'fence_stale'].includes(String(value.code))
    && 'holdingClaimId' in value
    && (value.holdingClaimId === null || typeof value.holdingClaimId === 'string')
    && 'holdingLeaseEpoch' in value
    && (value.holdingLeaseEpoch === null || Number.isSafeInteger(value.holdingLeaseEpoch))
    && 'holdingFenceRevision' in value
    && (value.holdingFenceRevision === null || typeof value.holdingFenceRevision === 'string')
}

export async function deployTheme(
  env: CoreEnv,
  merchantId: string,
  value: unknown,
  permit: ClaimMutationPermit,
): Promise<DeploymentResult> {
  const prepared = await prepareThemeDeployment(env, merchantId, value)
  return prepared.ok ? activatePreparedTheme(env, prepared, permit) : prepared
}

export async function currentTheme(env: CoreEnv, merchantId: string): Promise<ActivatedTheme | null> {
  const store = env.THEME_DEPLOYMENT.getByName(merchantId) as unknown as DeploymentClient
  return (await store.current()).record
}

async function validateAssets(href: string | null): Promise<AssetFetchFailure[]> {
  if (href === null) return []
  let lastStatus: number | null = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchAssetWithValidatedRedirects(href, AbortSignal.timeout(ASSET_ATTEMPT_TIMEOUT_MS))
      lastStatus = response.status
      await response.body?.cancel()
      if (response.ok) return []
    } catch {
      lastStatus = null
    }
  }
  return [Object.freeze({ href, attempts: 3, lastStatus })]
}

async function fetchAssetWithValidatedRedirects(href: string, signal: AbortSignal): Promise<Response> {
  let current = readPublicAssetUrl(href)
  if (!current) throw new Error('theme_asset_url_unsafe')
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(current, {
      method: 'GET',
      headers: { range: 'bytes=0-0' },
      redirect: 'manual',
      signal,
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirect === 3) throw new Error('theme_asset_redirect_invalid')
    current = readPublicAssetUrl(new URL(location, current).href)
    if (!current) throw new Error('theme_asset_redirect_unsafe')
  }
  throw new Error('theme_asset_redirect_limit')
}

function readPublicAssetUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return validateThemeAssetUrl(url.href) ? url : null
  } catch {
    return null
  }
}

function isActivation(
  value: unknown,
  merchantId: string,
  manifestDigest: string,
): value is Readonly<{ ok: true; idempotent: boolean; record: ActivatedTheme }> {
  return value !== null
    && typeof value === 'object'
    && 'ok' in value
    && value.ok === true
    && 'idempotent' in value
    && typeof value.idempotent === 'boolean'
    && 'record' in value
    && value.record !== null
    && typeof value.record === 'object'
    && 'merchantId' in value.record
    && value.record.merchantId === merchantId
    && 'manifestDigest' in value.record
    && value.record.manifestDigest === manifestDigest
    && 'resolvedCatalogScope' in value.record
    && Array.isArray(value.record.resolvedCatalogScope)
    && value.record.resolvedCatalogScope.every((entry) => typeof entry === 'string')
    && 'defaultedFields' in value.record
    && Array.isArray(value.record.defaultedFields)
    && value.record.defaultedFields.every((entry) => typeof entry === 'string')
    && 'deployedAtMs' in value.record
    && Number.isSafeInteger(value.record.deployedAtMs)
    && 'deployedAt' in value.record
    && typeof value.record.deployedAt === 'string'
    && new Date(Number(value.record.deployedAtMs)).toISOString() === value.record.deployedAt
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
