import { canonicalJson } from '../evidence-integrity.ts'
import { PRODUCTION_EDGE_WORKER, PRODUCTION_ROUTE_PATTERN, PRODUCTION_ZONE_NAME } from './contracts.ts'

export const PRODUCTION_ROUTE_AUTHORITY_SCHEMA =
  'agentic-commerce-production-route-authority/v2' as const
export const PRODUCTION_ROUTE_AUTHORITY_PROOF_SCHEMA =
  'agentic-commerce-production-route-authority-proof/v2' as const

export type ProductionRouteAuthority = Readonly<{
  schema: typeof PRODUCTION_ROUTE_AUTHORITY_SCHEMA
  mode: 'bootstrap' | 'steady-state'
  zoneId: string
  zoneName: typeof PRODUCTION_ZONE_NAME
  routeId: string | null
  pattern: typeof PRODUCTION_ROUTE_PATTERN
  script: typeof PRODUCTION_EDGE_WORKER
}>

export type ProductionRouteAuthorityProof = Readonly<{
  schema: typeof PRODUCTION_ROUTE_AUTHORITY_PROOF_SCHEMA
  phase: 'before' | 'after'
  mode: 'bootstrap' | 'steady-state'
  zoneId: string
  state: 'absent' | 'bound'
  routeId: string | null
  pattern: typeof PRODUCTION_ROUTE_PATTERN
  script: typeof PRODUCTION_EDGE_WORKER | null
}>

export function parseProductionRouteAuthority(value: unknown): ProductionRouteAuthority {
  const authority = record(value, 'authority_invalid')
  exactKeys(authority, ['mode', 'pattern', 'routeId', 'schema', 'script', 'zoneId', 'zoneName'])
  const mode = authority.mode
  requireRoute(authority.schema === PRODUCTION_ROUTE_AUTHORITY_SCHEMA
    && (mode === 'bootstrap' || mode === 'steady-state')
    && typeof authority.zoneId === 'string' && /^[0-9a-f]{32}$/u.test(authority.zoneId)
    && authority.zoneName === PRODUCTION_ZONE_NAME
    && (mode === 'bootstrap' ? authority.routeId === null
      : typeof authority.routeId === 'string' && /^[0-9a-f]{32}$/u.test(authority.routeId))
    && authority.pattern === PRODUCTION_ROUTE_PATTERN
    && authority.script === PRODUCTION_EDGE_WORKER, 'authority_identity_invalid')
  return Object.freeze(authority as unknown as ProductionRouteAuthority)
}

export function validateProductionRouteAuthorityProof(
  authority: ProductionRouteAuthority,
  value: unknown,
  phase: 'before' | 'after',
): ProductionRouteAuthorityProof {
  const route = record(value, 'api_route_invalid')
  exactKeys(route, ['id', 'pattern', 'script', 'state'])
  const expectedAbsent = authority.mode === 'bootstrap' && phase === 'before'
  requireRoute(route.pattern === authority.pattern
    && (expectedAbsent
      ? route.state === 'absent' && route.id === null && route.script === null
      : route.state === 'bound'
        && typeof route.id === 'string' && /^[0-9a-f]{32}$/u.test(route.id)
        && route.script === authority.script
        && (authority.routeId === null || route.id === authority.routeId)),
  'api_route_identity_mismatch')
  return Object.freeze({
    schema: PRODUCTION_ROUTE_AUTHORITY_PROOF_SCHEMA,
    phase,
    mode: authority.mode,
    zoneId: authority.zoneId,
    state: expectedAbsent ? 'absent' : 'bound',
    routeId: expectedAbsent ? null : route.id as string,
    pattern: authority.pattern,
    script: expectedAbsent ? null : authority.script,
  })
}

export function validateRecoveryRouteAuthorityProof(
  authority: ProductionRouteAuthority,
  value: unknown,
): ProductionRouteAuthorityProof {
  requireRoute(authority.mode === 'bootstrap', 'recovery_authority_mode_invalid')
  const route = record(value, 'recovery_api_route_invalid')
  exactKeys(route, ['id', 'pattern', 'script', 'state'])
  const absent = route.state === 'absent' && route.id === null && route.script === null
  const bound = route.state === 'bound'
    && typeof route.id === 'string' && /^[0-9a-f]{32}$/u.test(route.id)
    && route.script === authority.script
  requireRoute(route.pattern === authority.pattern && (absent || bound),
    'recovery_api_route_identity_mismatch')
  return Object.freeze({
    schema: PRODUCTION_ROUTE_AUTHORITY_PROOF_SCHEMA,
    phase: 'before',
    mode: 'bootstrap',
    zoneId: authority.zoneId,
    state: absent ? 'absent' : 'bound',
    routeId: absent ? null : route.id as string,
    pattern: authority.pattern,
    script: absent ? null : authority.script,
  })
}

function record(value: unknown, code: string): Record<string, unknown> {
  requireRoute(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  requireRoute(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    'authority_shape_invalid')
}

function requireRoute(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_route_authority:${code}`)
}
