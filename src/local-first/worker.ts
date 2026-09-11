import { PRODUCTION_STOREFRONT_PREFIX } from '../edge/production-prefix.ts'

export type LocalFirstEnv = Readonly<{
  ASSETS: { fetch(request: Request): Promise<Response> }
  RELEASE_CANDIDATE_SHA: string
  CF_VERSION_METADATA?: { id?: string }
}>
const ASSET_PATHS = new Map([
  ['/', '/index.html'], ['/app.js', '/app.js'], ['/drafts.js', '/drafts.js'],
  ['/launch.js', '/launch.js'], ['/workspace.js', '/workspace.js'],
  ['/style.css', '/style.css'], ['/sw.js', '/sw.js'],
])
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function secured(response: Response, source: string, head: boolean): Response {
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', CSP)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  headers.set('cache-control', 'no-store, no-transform')
  headers.set('x-commerce-profile', 'local-first')
  headers.set('x-commerce-source', source)
  headers.delete('etag')
  return new Response(head ? null : response.body, { status: response.status, headers })
}

export default {
  async fetch(request: Request, env: LocalFirstEnv): Promise<Response> {
    const url = new URL(request.url), prefix = PRODUCTION_STOREFRONT_PREFIX
    const head = request.method === 'HEAD'
    const finish = (response: Response) => secured(response, env.RELEASE_CANDIDATE_SHA, head)
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return finish(Response.json({ ok: false, code: 'not_found' }, { status: 404 }))
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return finish(Response.json({ ok: false, code: 'checkout_deferred', profile: 'local-first',
        message: 'This release stores drafts only in your browser. Server mutations and checkout are unavailable.' }, { status: 501 }))
    }
    if (url.pathname === prefix) {
      url.pathname += '/'
      return finish(Response.redirect(url.href, 308))
    }
    const relative = url.pathname.slice(prefix.length)
    if (['/vendor', '/admin'].includes(relative)) {
      url.pathname = `${prefix}/`; url.hash = relative.slice(1); url.search = '';
      return finish(Response.redirect(url.href, 308));
    }
    if (relative === '/readyz') {
      const valid = /^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA)
      return finish(Response.json({ ok: valid, profile: 'local-first', checkout: 'deferred',
        storage: 'browser-only', sourceRevision: env.RELEASE_CANDIDATE_SHA,
        workerVersionId: env.CF_VERSION_METADATA?.id ?? null }, { status: valid ? 200 : 503 }))
    }
    const versionPrefix = `/assets/${env.RELEASE_CANDIDATE_SHA}/`
    const assetPath = relative.startsWith(versionPrefix) ? '/' + relative.slice(versionPrefix.length) : relative
    const asset = ASSET_PATHS.get(assetPath)
    if (!asset) return finish(Response.json({ ok: false, code: 'not_found' }, { status: 404 }))
    const assetUrl = new URL(asset, url.origin)
    // Do not forward user headers, cookies or credentials to the static asset service.
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }))
    if (!response.ok) return finish(new Response('Asset unavailable', { status: 503 }))
    if (assetPath === '/sw.js' || assetPath === '/') {
      const source = env.RELEASE_CANDIDATE_SHA
      if (!/^(?:[0-9a-f]{40}|local-unreleased)$/u.test(source)) return finish(new Response('Invalid release', { status: 503 }))
      const headers = new Headers({ 'content-type': assetPath === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8' })
      if (assetPath === '/sw.js') headers.set('service-worker-allowed', `${prefix}/`)
      return finish(new Response((await response.text()).replaceAll('__RELEASE__', source), { headers }))
    }
    return finish(response)
  },
}
