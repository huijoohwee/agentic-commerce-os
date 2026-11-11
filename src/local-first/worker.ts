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
const sharedPackFiles = 'commerce-shell.css workspace-layout.js dashboard-columns.js toolbar-icons.js commerce-toolbar.js dropdown-menus.js graph-ui-tokens.css commerce-theme.css shared-ui-profile.css floating-panel.css toolbar.css'.split(' ')
const primaryFiles = [
  'app.js drafts.js checkout.js launch.js workspace.js workspace-graph.js agentic-base-data-view.js agentic-base-data-view.css graph-data-view.js graph-data-view.css style.css sw.js workflow.js workspace-capabilities.js workspace-tools.js storage-management/index.html storage-management/style.css storage-management/guide.js storage-management/sources.json',
  ...(import.meta.commerceLiveCheckout === false ? ['dropdown-menus.js graph-ui-tokens.css'] : [
    sharedPackFiles.join(' '),
    'favicon.svg workspace-tour.js workspace-navigation.js workspace-pack.route.js workspace-view-styles.js workspace-singleton.js shopper-demo-detail.js workspace-shell.css sme-business-pack.js sme-business-pack.css sme-business-pack-core.js sme-workflow-editor.js sme-pack-dictionary.js sme-pack-business-plan.js housing-comparison.js housing-engine.js housing-sample.js housing-comparison.css sme-review-workflow.js graph-gantt-timeline.js graph-gantt-timeline.css',
  ]),
].join(' ').split(' ')
const ASSET_PATHS = new Map<string,string>([['/', '/'], [packDirectory, '/workspace-pack.html']])
for (const file of primaryFiles) ASSET_PATHS.set('/' + file, '/' + file)
ASSET_PATHS.set('/storage-management/', '/storage-management/index.html')
for (const file of [...sharedPackFiles, ...['js', 'simulation.js', 'console.js', 'css'].map(ext => 'workspace-pack.' + ext)]) {
  ASSET_PATHS.set(packDirectory + file, '/' + file)
}
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
    const head = request.method === 'HEAD'
    const finish = (response: Response) => secured(response, env.RELEASE_CANDIDATE_SHA, head)
    const notFound = () => finish(Response.json({ ok: false, code: 'not_found' }, { status: 404 }))
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return notFound()
    }
    // The durable listing host shares this router but must omit the public SME service.
    // Its build sets import.meta.commerceLiveCheckout=false; Worker/dev builds leave it undefined.
    if (import.meta.commerceLiveCheckout !== false) {
      if ([prefix + '/dashboard-layout', prefix + '/dashboard-layout/session'].includes(url.pathname)) {
        const { dashboardLayout } = await import('./dashboard-layout.ts')
        return finish(await dashboardLayout(request, env.RELEASE_CANDIDATE_SHA, env.DASHBOARD_LAYOUT_SERVICE))
      }
      if (['GET', 'HEAD'].includes(request.method) && [WORKSPACE_PACK_PATH, WORKSPACE_PACK_PATH + '/'].includes(url.pathname)) {
        url.pathname = prefix + '/'; url.searchParams.set('workspace-pack', '')
        return finish(Response.redirect(url.href, 302))
      }
      const smePackRoute = `${prefix}/services/sme-business-pack`
      if ([smePackRoute, `${smePackRoute}/`].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
        url.pathname = `${prefix}/`; url.hash = 'sme'; url.search = ''
        return finish(Response.redirect(url.href, 308))
      }
      if (url.pathname.startsWith(`${smePackRoute}/`)) {
        const route = url.pathname.slice(smePackRoute.length)
        if (['/service.json', '/api', '/mcp'].includes(route)) {
          const { handleSmeBusinessPackRequest } = await import('./sme-business-pack.ts')
          const response = await handleSmeBusinessPackRequest(request, env.RELEASE_CANDIDATE_SHA)
          if (response) return finish(response)
        }
      }
    }
    if ((url.pathname === WORKSPACE_PACK_PATH || url.pathname === prefix) && ['GET', 'HEAD'].includes(request.method)) {
      if (url.pathname === WORKSPACE_PACK_PATH) url.search = ''
      url.pathname += '/'; return finish(Response.redirect(url.href, 308))
    }
    const workspace = await handleWorkspaceService(request, env.RELEASE_CANDIDATE_SHA,
      signal => readiness(env, runtime, signal ?? request.signal))
    if (workspace) return finish(workspace)
    const pack = await handleWorkspacePack(request, env.RELEASE_CANDIDATE_SHA)
    if (pack) return finish(pack)
    const fulfillment = await handleFulfillment(request, env.STOREFRONT_SESSION_SECRET, runtime)
    if (fulfillment) return finish(fulfillment)
    const checkout = await handleCheckout(request, env, transport, runtime)
    if (checkout) return finish(checkout)
    if (!['GET', 'HEAD'].includes(request.method)) {
      return finish(Response.json({ ok: false, code: 'checkout_deferred', profile: 'local-first',
        message: 'Agent writes are unavailable. Use the reviewed offer and human-operated sandbox checkout.' }, { status: 501 }))
    }
    const relative = url.pathname.slice(prefix.length)
    if (relative === '/storage-management' && ['GET', 'HEAD'].includes(request.method)) {
      url.pathname = `${prefix}/storage-management/`
      return finish(Response.redirect(url.href, 308))
    }
    if (['/vendor', '/admin'].includes(relative)) {
      url.pathname = `${prefix}/`; url.hash = relative.slice(1); url.search = '';
      return finish(Response.redirect(url.href, 308));
    }
    if (relative === '/readyz') {
      const value = await readiness(env, runtime, request.signal)
      return finish(Response.json(value, { status: value.ok ? 200 : 503 }))
    }
    const versionPrefix = `/assets/${env.RELEASE_CANDIDATE_SHA}/`
    const assetPath = relative.startsWith(versionPrefix) ? '/' + relative.slice(versionPrefix.length) : relative
    const asset = ASSET_PATHS.get(assetPath)
    if (!asset) return notFound()
    const assetUrl = new URL(asset, url.origin)
    // Do not forward user headers, cookies or credentials to the static asset service.
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }))
    if (!response.ok) return finish(new Response('Asset unavailable', { status: 503 }))
    if (assetPath === '/sw.js' || assetPath === '/') {
      const source = env.RELEASE_CANDIDATE_SHA
      if (!/^(?:[0-9a-f]{40}|local-unreleased)$/u.test(source)) return finish(new Response('Invalid release', { status: 503 }))
      const headers = new Headers({ 'content-type': assetPath === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8' })
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
const unavailableRuntime: FulfillmentRuntime = Object.freeze({
  async ready() { throw Error('fulfillment_unavailable') },
  async invoke() { throw Error('fulfillment_unavailable') },
})
export default { fetch: async (request: Request, env: LocalFirstEnv) => {
  let runtime: FulfillmentRuntime | undefined
  try { runtime = createFulfillmentRelay(env) } catch { runtime = unavailableRuntime }
  return fetchLocalFirst(request, env, undefined, runtime)
} }
