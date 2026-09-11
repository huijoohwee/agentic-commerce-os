export type CoreRoute = Readonly<{
  path: string
  capabilityAction: string
  authority: 'agent' | 'operator' | 'session-or-agent' | 'storefront-read-or-agent'
  copySearch?: true
  authoringClaimRequired?: true
  checkoutAction?: 'prepare' | 'confirm'
}>

export function routeToCore(request: Request, url: URL): CoreRoute | null {
  if (request.method === 'GET' && url.pathname === '/v1/registry') {
    return { path: '/internal/v1/agents', capabilityAction: 'registry.read', authority: 'agent' }
  }
  if (request.method === 'POST' && url.pathname === '/v1/intents/route') {
    return { path: '/internal/v1/intents/route', capabilityAction: 'intent.route', authority: 'storefront-read-or-agent' }
  }
  if (request.method === 'POST' && url.pathname === '/v1/sync/merge') {
    return { path: '/internal/v1/sync/merge', capabilityAction: 'sync.merge', authority: 'storefront-read-or-agent' }
  }
  const checkout = url.pathname.match(/^\/v1\/checkouts\/([^/]+)\/(prepare|confirm)$/u)
  if (checkout?.[1] && checkout[2]) {
    return {
      path: `/internal/v1/checkouts/${checkout[1]}/${checkout[2]}`,
      capabilityAction: `checkout.${checkout[2]}`,
      authority: checkout[2] === 'prepare' ? 'session-or-agent' : 'agent',
      checkoutAction: checkout[2] === 'prepare' ? 'prepare' : 'confirm',
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/revenue') {
    return { path: '/internal/v1/revenue', capabilityAction: 'revenue.period.read', authority: 'agent', copySearch: true }
  }
  if (request.method === 'GET' && url.pathname === '/v1/revenue/demand-evidence') {
    return { path: '/internal/v1/revenue/demand-evidence', capabilityAction: 'revenue.demand-evidence.read', authority: 'agent' }
  }
  if (request.method === 'GET' && url.pathname === '/v1/vendors') {
    return { path: '/internal/v1/vendors', capabilityAction: 'vendor.read', authority: 'agent' }
  }
  if (request.method === 'GET' && /^\/v1\/settlements\/[^/]+$/u.test(url.pathname)) {
    return { path: `/internal${url.pathname}`, capabilityAction: 'settlement.read', authority: 'agent' }
  }
  if (url.pathname === '/v1/operator/agents') {
    return {
      path: '/internal/v1/agents',
      capabilityAction: request.method === 'POST' ? 'agent.register' : 'registry.read',
      authority: 'operator',
      ...(request.method === 'POST' ? { authoringClaimRequired: true as const } : {}),
    }
  }
  const agent = url.pathname.match(/^\/v1\/operator\/agents\/([^/]+)$/u)
  if (agent?.[1]) return {
    path: `/internal/v1/agents/${agent[1]}`,
    capabilityAction: 'agent.deregister',
    authority: 'operator',
    ...(request.method === 'DELETE' ? { authoringClaimRequired: true as const } : {}),
  }
  if (request.method === 'GET' && url.pathname === '/v1/operator/registry/events') {
    return { path: '/internal/v1/registry/events', capabilityAction: 'registry.events.read', authority: 'operator', copySearch: true }
  }
  const vendor = url.pathname.match(/^\/v1\/operator\/vendors\/([^/]+)\/transition$/u)
  if (vendor?.[1]) return {
    path: `/internal/v1/vendors/${vendor[1]}/transition`,
    capabilityAction: 'vendor.transition',
    authority: 'operator',
    ...(request.method === 'POST' ? { authoringClaimRequired: true as const } : {}),
  }
  const theme = url.pathname.match(/^\/v1\/operator\/merchants\/([^/]+)\/theme$/u)
  if (request.method === 'POST' && theme?.[1]) {
    return {
      path: `/internal/v1/operator/merchants/${theme[1]}/theme`,
      capabilityAction: 'theme.deploy',
      authority: 'operator',
      authoringClaimRequired: true,
    }
  }
  const claim = url.pathname.match(/^\/v1\/operator\/claims\/(acquire|release|admit)$/u)
  if (request.method === 'POST' && claim?.[1]) {
    return {
      path: `/internal/v1/operator/claims/${claim[1]}`,
      capabilityAction: `authoring.claim.${claim[1]}`,
      authority: 'operator',
      ...(claim[1] === 'release' ? { authoringClaimRequired: true as const } : {}),
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/operator/release-boundaries') {
    return { path: '/internal/v1/release-boundaries', capabilityAction: 'release.boundary.read', authority: 'operator' }
  }
  return null
}

