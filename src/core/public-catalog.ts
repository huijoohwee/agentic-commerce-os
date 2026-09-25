import type { AgentRegistryRecord } from './agent-registry.js'
import { canonicalJson, isNonzeroHexIdentity, sha256Hex } from '../shared/digest.ts'

export const PUBLIC_FIELD_ALLOWLIST = Object.freeze([
  'agentId',
  'declaredCategory',
  'declaredCapabilities',
  'trustStatus',
])

export type PublicAgentEntry = Readonly<{
  agentId: string
  declaredCategory: string
  declaredCapabilities: readonly string[]
  trustStatus: 'declared-and-present'
}>

export type AgentRegistrySnapshot = Readonly<{
  revision: number
  digest: string
  agents: readonly CatalogSourceAgent[]
}>

type CatalogSourceAgent = Readonly<Pick<AgentRegistryRecord, 'agentId' | 'category' | 'registrationState'> & {
  admissionInputs: Readonly<{ toolAllowlistEntry?: unknown }>
}>

export function projectPublicCatalog(snapshot: AgentRegistrySnapshot): Readonly<{
  ok: true
  revision: number
  digest: string
  agents: readonly PublicAgentEntry[]
}> {
  const agents = snapshot.agents
    .filter(({ registrationState }) => registrationState === 'active')
    .map((record) => Object.freeze({
      agentId: record.agentId,
      declaredCategory: record.category,
      declaredCapabilities: Object.freeze(readCapabilities(record)),
      trustStatus: 'declared-and-present' as const,
    }))
    .sort((left, right) => compareText(left.agentId, right.agentId))
  return Object.freeze({
    ok: true,
    revision: snapshot.revision,
    digest: snapshot.digest,
    agents: Object.freeze(agents),
  })
}

function readCapabilities(record: CatalogSourceAgent): string[] {
  const allowlist = isRecord(record.admissionInputs.toolAllowlistEntry)
    ? record.admissionInputs.toolAllowlistEntry
    : null
  return Array.isArray(allowlist?.tool_names)
    ? [...new Set(allowlist.tool_names.filter((entry): entry is string => typeof entry === 'string'))].sort(compareText)
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export const CATALOG_ARTIFACT_SCHEMA = 'commerce.public-catalog/v1'
export const CATALOG_MAX_BYTES = 262_144
export const CATALOG_MAX_AGE_MS = 86_400_000
export type PublicCatalogArtifact = Readonly<{
  schema: typeof CATALOG_ARTIFACT_SCHEMA
  sourceRevision: string
  generatedAt: number
  expiresAt: number
  catalog: ReturnType<typeof projectPublicCatalog>
  artifactDigest: string
}>

function requireCatalog(condition: unknown, code = 'catalog_artifact_invalid'): asserts condition {
  if (!condition) throw new Error(code)
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}
function validPublicEntry(value: unknown): value is PublicAgentEntry {
  return isRecord(value) && exact(value, PUBLIC_FIELD_ALLOWLIST) && boundedText(value.agentId, 256)
    && boundedText(value.declaredCategory, 64) && value.trustStatus === 'declared-and-present'
    && Array.isArray(value.declaredCapabilities) && value.declaredCapabilities.length <= 100
    && value.declaredCapabilities.every(entry => boundedText(entry, 128))
    && new Set(value.declaredCapabilities).size === value.declaredCapabilities.length
    && value.declaredCapabilities.every((entry, index, all) => index === 0 || compareText(all[index - 1]!, entry) < 0)
}

/** Export only from an operator-selected native snapshot. Hashes prove integrity, not admission authority. */
export async function createPublicCatalogArtifact(
  raw: unknown, sourceRevision: string, generatedAt = Date.now(),
): Promise<PublicCatalogArtifact> {
  requireCatalog(isRecord(raw) && Number.isSafeInteger(raw.revision) && Number(raw.revision) >= 0
    && isNonzeroHexIdentity(raw.digest, 64) && Array.isArray(raw.agents) && raw.agents.length <= 100,
  'catalog_snapshot_invalid')
  requireCatalog(await sha256Hex(canonicalJson({ revision: raw.revision, agents: raw.agents })) === raw.digest,
    'catalog_snapshot_digest_mismatch')
  const agents: CatalogSourceAgent[] = raw.agents.map((entry: unknown) => {
    requireCatalog(isRecord(entry) && boundedText(entry.agentId, 256) && boundedText(entry.category, 64)
      && ['active', 'inactive'].includes(String(entry.registrationState)) && isRecord(entry.admissionInputs),
    'catalog_snapshot_invalid')
    return { agentId: entry.agentId, category: entry.category,
      registrationState: entry.registrationState === 'active' ? 'active' : 'inactive',
      admissionInputs: { toolAllowlistEntry: entry.admissionInputs.toolAllowlistEntry } }
  })
  requireCatalog(new Set(agents.map(entry => entry.agentId)).size === agents.length, 'catalog_snapshot_invalid')
  const unsigned = { schema: CATALOG_ARTIFACT_SCHEMA, sourceRevision, generatedAt,
    expiresAt: generatedAt + CATALOG_MAX_AGE_MS,
    catalog: projectPublicCatalog({ revision: Number(raw.revision), digest: raw.digest, agents }) }
  return readPublicCatalogArtifact({ ...unsigned, artifactDigest: await sha256Hex(canonicalJson(unsigned)) }, generatedAt)
}

/** Strict allowlist and independent output digest prevent private fields entering the service. */
export async function readPublicCatalogArtifact(raw: unknown, now = Date.now()): Promise<PublicCatalogArtifact> {
  requireCatalog(isRecord(raw) && exact(raw, ['schema', 'sourceRevision', 'generatedAt', 'expiresAt', 'catalog', 'artifactDigest'])
    && raw.schema === CATALOG_ARTIFACT_SCHEMA && isNonzeroHexIdentity(raw.sourceRevision, 40)
    && Number.isSafeInteger(raw.generatedAt) && Number(raw.generatedAt) >= 0 && Number.isSafeInteger(raw.expiresAt)
    && isNonzeroHexIdentity(raw.artifactDigest, 64))
  const generatedAt = Number(raw.generatedAt), expiresAt = Number(raw.expiresAt)
  requireCatalog(expiresAt > generatedAt && expiresAt - generatedAt <= CATALOG_MAX_AGE_MS)
  requireCatalog(generatedAt <= now && now < expiresAt, 'catalog_artifact_expired')
  const value = raw.catalog
  requireCatalog(isRecord(value) && exact(value, ['ok', 'revision', 'digest', 'agents']) && value.ok === true
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && isNonzeroHexIdentity(value.digest, 64)
    && Array.isArray(value.agents) && value.agents.length <= 100 && value.agents.every(validPublicEntry))
  const agents = value.agents as PublicAgentEntry[]
  requireCatalog(agents.every((entry, index) => index === 0 || compareText(agents[index - 1]!.agentId, entry.agentId) < 0))
  const catalog = { ok: true as const, revision: Number(value.revision), digest: value.digest,
    agents: Object.freeze(agents.map(entry => Object.freeze({ ...entry, declaredCapabilities: Object.freeze([...entry.declaredCapabilities]) }))) }
  const unsigned = { schema: CATALOG_ARTIFACT_SCHEMA, sourceRevision: raw.sourceRevision, generatedAt, expiresAt, catalog }
  requireCatalog(new TextEncoder().encode(canonicalJson(raw)).length <= CATALOG_MAX_BYTES, 'catalog_artifact_too_large')
  requireCatalog(await sha256Hex(canonicalJson(unsigned)) === raw.artifactDigest, 'catalog_artifact_digest_mismatch')
  return Object.freeze({ ...unsigned, schema: CATALOG_ARTIFACT_SCHEMA, catalog: Object.freeze(catalog), artifactDigest: raw.artifactDigest })
}
