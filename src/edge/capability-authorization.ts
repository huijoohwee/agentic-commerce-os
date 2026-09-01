import { isRecord } from '../shared/http.js'
import type { CorePayload } from './mcp.js'

const AUTHORIZE_PATH = '/internal/v1/invocations/authorize'

export function capabilityBoundCore(core: CorePayload): CorePayload {
  return async (path, body, method = body ? 'POST' : 'GET') => {
    const capabilityAction = capabilityActionForCoreRequest(path, method)
    if (!capabilityAction) {
      return Object.freeze({ ok: false, code: 'invocation_capability_unmapped', path, method })
    }
    const authorization = await core(AUTHORIZE_PATH, { capabilityAction }, 'POST')
    if (!isRecord(authorization) || authorization.ok !== true) return authorization
    return core(path, body, method)
  }
}

export function capabilityActionForCoreRequest(
  rawPath: string,
  method: 'GET' | 'POST' | 'DELETE',
): string | null {
  const path = new URL(rawPath, 'https://commerce-core.internal').pathname
  if (method === 'GET' && path === '/internal/readyz') return 'runtime.status.read'
  if (method === 'POST' && path === '/internal/v1/invocations/resolve') return 'invocation.resolve'
  if (path === '/internal/v1/agents') {
    if (method === 'GET') return 'registry.read'
    if (method === 'POST') return 'agent.register'
  }
  if (method === 'DELETE' && /^\/internal\/v1\/agents\/[^/]+$/u.test(path)) return 'agent.deregister'
  if (method === 'GET' && path === '/internal/v1/registry/events') return 'registry.events.read'
  if (method === 'GET' && path === '/internal/v1/public/agents') return 'catalog.public.read'
  if (method === 'GET' && /^\/internal\/v1\/merchants\/[^/]+\/catalog$/u.test(path)) return 'catalog.merchant.read'
  if (method === 'POST' && path === '/internal/v1/intents/route') return 'intent.route'
  if (method === 'POST' && path === '/internal/v1/sync/merge') return 'sync.merge'
  if (method === 'POST' && /^\/internal\/v1\/checkouts\/[^/]+\/prepare$/u.test(path)) return 'checkout.prepare'
  if (method === 'POST' && /^\/internal\/v1\/checkouts\/[^/]+\/confirm$/u.test(path)) return 'checkout.confirm'
  if (method === 'GET' && path === '/internal/v1/revenue') return 'revenue.period.read'
  if (method === 'GET' && path === '/internal/v1/revenue/demand-evidence') return 'revenue.demand-evidence.read'
  if (method === 'GET' && path === '/internal/v1/vendors') return 'vendor.read'
  if (method === 'POST' && /^\/internal\/v1\/vendors\/[^/]+\/transition$/u.test(path)) return 'vendor.transition'
  if (method === 'GET' && /^\/internal\/v1\/settlements\/[^/]+$/u.test(path)) return 'settlement.read'
  if (method === 'POST' && /^\/internal\/v1\/operator\/merchants\/[^/]+\/theme$/u.test(path)) return 'theme.deploy'
  if (method === 'GET' && path === '/internal/v1/release-boundaries') return 'release.boundary.read'
  const claim = path.match(/^\/internal\/v1\/operator\/claims\/(acquire|release|admit)$/u)
  return method === 'POST' && claim?.[1] ? `authoring.claim.${claim[1]}` : null
}
