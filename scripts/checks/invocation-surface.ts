import {
  localMcpCoverageFindings,
  readCapabilityMap,
} from '../../src/invocation/capability-map.ts'
import { readJson, report, source, type Assertion } from './common.ts'

const raw = readJson<unknown>('config/capability-token-map.json')
const map = readCapabilityMap(raw)
const registeredTools = readRegisteredToolNames(source('src/edge/mcp.ts'))
const projectedTools = new Set(map?.map(({ mcpTool }) => mcpTool) ?? [])
const merchantCatalog = map?.find(({ capabilityAction }) => capabilityAction === 'catalog.merchant.read')
const syncMerge = map?.find(({ capabilityAction }) => capabilityAction === 'sync.merge')
const demandEvidence = map?.find(({ capabilityAction }) => capabilityAction === 'revenue.demand-evidence.read')
const edgeSource = source('src/edge/index.ts')
const capabilitySource = source('src/invocation/capability-map.ts')
const readinessSource = source('src/core/core-readiness.ts')
const assertions: Assertion[] = [
  { condition: map !== null, detail: 'capability map parses' },
  { condition: Boolean(map?.every((entry) => entry.commandToken === '/tool.route')), detail: 'command projection reuses /tool.route' },
  { condition: Boolean(map?.every((entry) => entry.semanticTokens.includes('#mcp'))), detail: 'semantic projection reuses #mcp' },
  { condition: Boolean(map?.every((entry) => entry.bindingTokens.includes('@mcp-gateway'))), detail: 'binding projection reuses @mcp-gateway' },
  {
    condition: Boolean(map && localMcpCoverageFindings(map, registeredTools).length === 0),
    detail: 'every projected action is reachable through one registered MCP tool',
  },
  {
    condition: registeredTools.every((tool) => projectedTools.has(tool))
      && projectedTools.size === registeredTools.length,
    detail: 'every registered MCP capability is present exactly once in the projection',
  },
  {
    condition: merchantCatalog?.httpRoute === '/v1/public/merchants/{merchantId}/catalog',
    detail: 'merchant catalog projection uses the public edge route contract',
  },
  {
    condition: routeMatchesEdgeSource(syncMerge?.httpRoute, 'POST', edgeSource),
    detail: 'sync merge projection matches the implemented POST edge route',
  },
  {
    condition: routeMatchesEdgeSource(demandEvidence?.httpRoute, 'GET', edgeSource),
    detail: 'demand-evidence projection matches the implemented GET edge route',
  },
  { condition: !capabilitySource.includes('/tool.route'), detail: 'capability reader contains no duplicated token dictionary values' },
  {
    condition: capabilitySource.includes('expected one upstream command claim')
      && capabilitySource.includes('command.semantics?.includes(token)')
      && capabilitySource.includes('command.bindings?.includes(token)'),
    detail: 'coverage requires an action-specific upstream command/tool/semantic/binding association',
  },
  {
    condition: readinessSource.includes("check('invocation_capability_coverage'")
      && edgeSource.includes("'/internal/v1/invocations/authorize'"),
    detail: 'readiness and edge execution fail closed on missing upstream action coverage',
  },
]
report('invocation-surface', assertions)

function readRegisteredToolNames(text: string): readonly string[] {
  const blocks = [...text.matchAll(
    /export const (?:PUBLIC|OPERATOR)_MCP_TOOL_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/gu,
  )]
  const names = blocks.flatMap((match) => (
    [...(match[1] ?? '').matchAll(/'([a-z0-9][a-z0-9._-]+)'/gu)].map((entry) => entry[1] ?? '')
  )).filter(Boolean)
  return Object.freeze([...new Set(names)].sort())
}

function routeMatchesEdgeSource(route: string | null | undefined, method: 'GET' | 'POST', text: string): boolean {
  return Boolean(route && text.includes(`request.method === '${method}' && url.pathname === '${route}'`))
}
