import type { AgentRegistryRecord } from './agent-registry.js'

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
  agents: readonly AgentRegistryRecord[]
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

function readCapabilities(record: AgentRegistryRecord): string[] {
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
