import type { InvocationCatalogSnapshot } from './catalog'

export type CapabilityTokens = Readonly<{
  capabilityAction: string
  commandToken: string
  semanticTokens: readonly string[]
  bindingTokens: readonly string[]
  mcpTool: string
  httpRoute: string | null
}>

const ACTION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/u
const TOOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const TOKEN_PATTERN = /^[/#@][a-z0-9][a-z0-9._-]*:?$/u

export function readCapabilityMap(value: unknown): readonly CapabilityTokens[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null
  const entries = value.map(readEntry)
  if (entries.some((entry) => entry === null)) return null
  const parsed = entries as CapabilityTokens[]
  if (new Set(parsed.map((entry) => entry.capabilityAction)).size !== parsed.length
    || new Set(parsed.map((entry) => entry.mcpTool)).size !== parsed.length) return null
  return Object.freeze(parsed)
}

export function coverageFindings(
  map: readonly CapabilityTokens[],
  catalog: InvocationCatalogSnapshot,
): readonly string[] {
  const byToken = new Map(catalog.entries.map((entry) => [entry.token, entry]))
  const findings: string[] = []
  for (const entry of map) {
    const command = byToken.get(entry.commandToken)
    if (!command || command.kind !== 'command') {
      findings.push(`${entry.capabilityAction}: missing command ${entry.commandToken}`)
    }
    for (const token of entry.semanticTokens) {
      if (byToken.get(token)?.kind !== 'semantic') {
        findings.push(`${entry.capabilityAction}: missing semantic ${token}`)
      }
    }
    for (const token of entry.bindingTokens) {
      if (byToken.get(token)?.kind !== 'binding') {
        findings.push(`${entry.capabilityAction}: missing binding ${token}`)
      }
    }
    const toolClaims = catalog.entries.filter((candidate) => (
      candidate.kind === 'command' && commandTools(candidate).includes(entry.mcpTool)
    ))
    if (toolClaims.length !== 1) {
      findings.push(`${entry.capabilityAction}: expected one upstream command claim for ${entry.mcpTool}, found ${toolClaims.length}`)
    } else if (toolClaims[0]?.token !== entry.commandToken) {
      findings.push(`${entry.capabilityAction}: ${entry.mcpTool} is claimed by ${toolClaims[0]?.token ?? 'unknown'}`)
    }
    if (command?.kind === 'command') {
      for (const token of entry.semanticTokens) {
        if (!command.semantics?.includes(token)) {
          findings.push(`${entry.capabilityAction}: command ${entry.commandToken} does not bind semantic ${token}`)
        }
      }
      for (const token of entry.bindingTokens) {
        if (!command.bindings?.includes(token)) {
          findings.push(`${entry.capabilityAction}: command ${entry.commandToken} does not bind ${token}`)
        }
      }
    }
  }
  return Object.freeze(findings.sort())
}

export function localMcpCoverageFindings(
  map: readonly CapabilityTokens[],
  registeredToolNames: readonly string[],
): readonly string[] {
  const registered = new Set(registeredToolNames)
  return Object.freeze(map
    .filter((entry) => !registered.has(entry.mcpTool))
    .map((entry) => `${entry.capabilityAction}: local MCP tool ${entry.mcpTool} is not registered`)
    .sort())
}

function readEntry(value: unknown): CapabilityTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry)
  if (keys.some((key) => ![
    'capabilityAction', 'commandToken', 'semanticTokens', 'bindingTokens', 'mcpTool', 'httpRoute',
  ].includes(key))) return null
  if (typeof entry.capabilityAction !== 'string' || !ACTION_PATTERN.test(entry.capabilityAction)
    || typeof entry.commandToken !== 'string' || !validToken(entry.commandToken, '/')
    || !validTokenArray(entry.semanticTokens, '#')
    || !validTokenArray(entry.bindingTokens, '@')
    || typeof entry.mcpTool !== 'string' || !TOOL_PATTERN.test(entry.mcpTool)
    || (entry.httpRoute !== null
      && (typeof entry.httpRoute !== 'string' || !entry.httpRoute.startsWith('/')))) return null
  return Object.freeze({
    capabilityAction: entry.capabilityAction,
    commandToken: entry.commandToken,
    semanticTokens: Object.freeze(entry.semanticTokens),
    bindingTokens: Object.freeze(entry.bindingTokens),
    mcpTool: entry.mcpTool,
    httpRoute: entry.httpRoute,
  }) as CapabilityTokens
}

function validTokenArray(value: unknown, sigil: '#' | '@'): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 500
    && value.every((entry) => typeof entry === 'string' && validToken(entry, sigil))
    && new Set(value).size === value.length
}

function validToken(value: string, sigil: '/' | '#' | '@'): boolean {
  return value.length <= 128 && value.startsWith(sigil) && TOKEN_PATTERN.test(value)
}

function commandTools(entry: InvocationCatalogSnapshot['entries'][number]): readonly string[] {
  if (entry.mcpTools) return entry.mcpTools
  return entry.mcpTool ? Object.freeze([entry.mcpTool]) : Object.freeze([])
}
