import { filesWithExtension, packAssets, packEntries } from './pack-assets.ts'
import { handleWorkspaceService } from './workspace-service.ts'
import { handleCheckout, checkoutConfigured, checkoutMode, type CheckoutEnv } from './checkout.ts'
import type { PaymentFetch } from './stripe-checkout.ts'
import { renderStorefrontTemplate } from './checkout-offer.ts'
import { PRODUCTION_STOREFRONT_PREFIX } from '../edge/production-prefix.ts'
import { handleWorkspacePack, WORKSPACE_PACK_PATH } from './workspace-pack.ts'
import { handleFulfillment } from './fulfillment.ts'
import type { FulfillmentRuntime } from './fulfillment-contract.ts'
import { createFulfillmentRelay, type ListingRelayEnv } from './fulfillment-relay.ts'
import { LOCAL_FIRST_CSP, LOCAL_FIRST_DEV_CSP } from './content-security-policy.ts'

export type LocalFirstEnv = Readonly<CheckoutEnv & ListingRelayEnv & {
  RELEASE_CANDIDATE_SHA: string
  DASHBOARD_LAYOUT_SERVICE?: import('./dashboard-layout.ts').LayoutBinding
  CF_VERSION_METADATA?: { id?: string }
}>
const packDirectory = '/services/workspace-pack/'
// A bounded, exact allowlist: shared files get the same asset at both route prefixes.
const sharedPackFiles = import.meta.commerceLiveCheckout === false ? packAssets : [...packAssets, 'viewer-surface.js', 'viewer-surface.css']
const primaryFiles = [
  ...filesWithExtension('app drafts listing-geo checkout launch workspace workspace-graph agentic-base-data-view graph-data-view sw workflow workspace-capabilities workspace-tools', 'js'),
  'agentic-geo-core.mjs', 'agentic-base-data-view.css', 'graph-data-view.css', 'style.css',
  ...(import.meta.commerceLiveCheckout === false ? ['dropdown-menus.js', 'graph-ui-tokens.css'] : [
    ...sharedPackFiles,
    ...filesWithExtension('workspace-tour workspace-navigation workspace-pack.route workspace-view-styles workspace-singleton shopper-demo-detail sme-business-pack sme-business-pack-core sme-decision-contract sme-workflow-editor key-type-value hover hover-text sme-pack-dictionary sme-pack-business-plan housing-comparison housing-engine housing-sample sme-review-workflow graph-gantt-timeline', 'js'),
    ...filesWithExtension('workspace-shell sme-business-pack hover housing-comparison graph-gantt-timeline', 'css'), 'favicon.svg',
  ]),
]
const ASSET_PATHS = new Map<string,string>([['/', '/index.html'], [packDirectory, '/workspace-pack.html']])
for (const file of primaryFiles) ASSET_PATHS.set('/' + file, '/' + file)
for (const file of [...sharedPackFiles, ...packEntries]) ASSET_PATHS.set(packDirectory + file, '/' + file)
function secured(response: Response, source: string, head: boolean): Response {
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', source === 'local-unreleased' && headers.get('content-type')?.startsWith('text/html')
    ? LOCAL_FIRST_DEV_CSP : LOCAL_FIRST_CSP)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  headers.set('cache-control', 'no-store, no-transform')
  headers.set('x-commerce-profile', 'local-first')
  headers.set('x-commerce-source', source)
  headers.delete('etag')
  return new Response(head ? null : response.body, { status: response.status, headers })
}

export async function fetchLocalFirst(request: Request, env: LocalFirstEnv, transport?: PaymentFetch,
  runtime?: FulfillmentRuntime): Promise<Response> {
    const url = new URL(request.url), prefix = PRODUCTION_STOREFRONT_PREFIX
    const revision = env.RELEASE_CANDIDATE_SHA
    const head = request.method === 'HEAD', read = head || request.method === 'GET'
    const finish = (response: Response) => secured(response, revision, head)
    const notFound = () => finish(Response.json({ ok: false, code: 'not_found' }, { status: 404 }))
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return notFound()
    }
    // The durable listing host shares this router but must omit the public SME service.
    // Its build sets import.meta.commerceLiveCheckout=false; Worker/dev builds leave it undefined.
    if (import.meta.commerceLiveCheckout !== false) {
      if ([prefix + '/dashboard-layout', prefix + '/dashboard-layout/session'].includes(url.pathname)) {
        const { dashboardLayout } = await import('./dashboard-layout.ts')
        return finish(await dashboardLayout(request, revision, env.DASHBOARD_LAYOUT_SERVICE))
      }
      if (read && [WORKSPACE_PACK_PATH, WORKSPACE_PACK_PATH + '/'].includes(url.pathname)) {
        url.pathname = prefix + '/'; url.searchParams.set('workspace-pack', '')
        return finish(Response.redirect(url.href, 302))
      }
      const smePackRoute = `${prefix}/services/sme-business-pack`
      if ([smePackRoute, `${smePackRoute}/`].includes(url.pathname) && read) {
        url.pathname = `${prefix}/`; url.hash = 'sme'; url.search = ''
        return finish(Response.redirect(url.href, 308))
      }
      if (url.pathname.startsWith(`${smePackRoute}/`)) {
        const route = url.pathname.slice(smePackRoute.length)
        if (['/service.json', '/api', '/mcp'].includes(route)) {
          const { handleSmeBusinessPackRequest } = await import('./sme-business-pack.ts')
          const response = await handleSmeBusinessPackRequest(request, revision)
          if (response) return finish(response)
        }
      }
    }
    if ((url.pathname === WORKSPACE_PACK_PATH || url.pathname === prefix) && read) {
      if (url.pathname === WORKSPACE_PACK_PATH) url.search = ''
      url.pathname += '/'; return finish(Response.redirect(url.href, 308))
    }
    const workspace = await handleWorkspaceService(request, revision,
      signal => readiness(env, runtime, signal ?? request.signal))
    if (workspace) return finish(workspace)
    const pack = await handleWorkspacePack(request, revision)
    if (pack) return finish(pack)
    const fulfillment = await handleFulfillment(request, env.STOREFRONT_SESSION_SECRET, runtime)
    if (fulfillment) return finish(fulfillment)
    const checkout = await handleCheckout(request, env, transport, runtime)
    if (checkout) return finish(checkout)
    if (!read) {
      return finish(Response.json({ ok: false, code: 'checkout_deferred', profile: 'local-first',
        message: 'Agent writes are unavailable. Use the reviewed offer and human-operated sandbox checkout.' }, { status: 501 }))
    }
    const relative = url.pathname.slice(prefix.length)
    if (['/vendor', '/admin'].includes(relative)) {
      url.pathname = `${prefix}/`; url.hash = relative.slice(1); url.search = '';
      return finish(Response.redirect(url.href, 308));
    }
    if (relative === '/readyz') {
      const value = await readiness(env, runtime, request.signal)
      return finish(Response.json(value, { status: value.ok ? 200 : 503 }))
    }
    const versionPrefix = `/assets/${revision}/`
    const assetPath = relative.startsWith(versionPrefix) ? '/' + relative.slice(versionPrefix.length) : relative
    const asset = ASSET_PATHS.get(assetPath)
    if (!asset) return notFound()
    const assetUrl = new URL(assetPath === '/' ? '/__local-first-index.html' : asset, url.origin)
    // Do not forward user headers, cookies or credentials to the static asset service.
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }))
    if (!response.ok) return finish(new Response('Asset unavailable', { status: 503 }))
    if (assetPath === '/sw.js' || assetPath === '/') {
      const source = revision
      if (!/^(?:[0-9a-f]{40}|local-unreleased)$/u.test(source)) return finish(new Response('Invalid release', { status: 503 }))
      const headers = new Headers({ 'content-type': (assetPath === '/' ? 'text/html' : 'application/javascript') + '; charset=utf-8' })
      if (assetPath === '/sw.js') headers.set('service-worker-allowed', `${prefix}/`)
      return finish(new Response(renderStorefrontTemplate(await response.text(), source, env.CHECKOUT_MODE), { headers }))
    }
    return finish(response)
}
async function readiness(env: LocalFirstEnv, runtime: FulfillmentRuntime | undefined, signal: AbortSignal) {
  const valid = /^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA) && checkoutConfigured(env)
  let fulfillment: 'disabled' | 'ready' | 'unavailable' = runtime ? 'unavailable' : 'disabled'
  if (valid && runtime?.ready && !signal.aborted) {
    // Only the existing relay verifies host identity. No session, job or model call is created.
    const deadline = new AbortController(), probe = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), 3000)
    let cancel: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(Error('fulfillment_readiness_unavailable'))
      probe.addEventListener('abort', cancel, { once: true })
    })
    try { await Promise.race([runtime.ready(probe), aborted]); if (!probe.aborted) fulfillment = 'ready' }
    catch { /* Availability is public; transport errors, credentials and host pins are not. */ }
    finally { clearTimeout(timer); probe.removeEventListener('abort', cancel) }
  }
  const live = checkoutMode(env) === 'live'
  return { ok: valid && fulfillment !== 'unavailable' && !signal.aborted,
    readinessScope: 'configured-capabilities', fulfillment, profile: 'local-first', checkout: valid ? env.CHECKOUT_MODE : 'unavailable',
    storage: 'browser-only', paymentStorage: live ? 'stripe-live' : 'stripe-test', paymentProvider: 'stripe', realMoney: live,
    sourceRevision: env.RELEASE_CANDIDATE_SHA, workerVersionId: env.CF_VERSION_METADATA?.id ?? null }
}
const unavailable = async () => { throw Error('fulfillment_unavailable') }
const unavailableRuntime: FulfillmentRuntime = Object.freeze({ ready: unavailable, invoke: unavailable })
export default { fetch: async (request: Request, env: LocalFirstEnv) => {
  let runtime: FulfillmentRuntime | undefined
  try { runtime = createFulfillmentRelay(env) } catch { runtime = unavailableRuntime }
  return fetchLocalFirst(request, env, undefined, runtime)
} }
