import { THEME_MANIFEST_DEFAULTS, type ThemeManifest } from '../shared/theme-manifest'
import { graphWorkspaceUrl } from './graph-workspace'

export type ConsoleMetadata = Readonly<{
  lane: string
  releaseCandidateSha: string
  version: Readonly<{ id?: string; tag?: string; timestamp?: string }>
}>

export type ConsoleOptions = Readonly<{
  basePath?: string
  catalogPath?: string
  clientModulePath?: string
  deliveryBoundary?: 'open' | 'closed'
  graphWorkspaceUrl?: string
}>

export function consoleResponse(
  metadata: ConsoleMetadata,
  manifest: ThemeManifest = THEME_MANIFEST_DEFAULTS,
  options: ConsoleOptions = {},
): Response {
  const nonce = crypto.randomUUID().replace(/-/gu, '')
  const lane = escapeHtml(metadata.lane)
  const releaseCandidateSha = escapeHtml(metadata.releaseCandidateSha)
  const versionId = escapeHtml(metadata.version.id ?? 'local')
  const versionTimestamp = escapeHtml(formatTimestamp(metadata.version.timestamp))
  const basePath = options.basePath ?? ''
  const catalogPath = escapeHtml(options.catalogPath ?? `${basePath}/v1/public/agents`)
  const modulePath = escapeHtml(options.clientModulePath ?? `${basePath}/assets/storefront.js`)
  const homePath = escapeHtml(basePath ? `${basePath}/` : '/')
  const deliveryClosed = options.deliveryBoundary === 'closed'
  const workspaceUrl = deliveryClosed ? null : graphWorkspaceUrl(options.graphWorkspaceUrl, metadata.lane)
  const workspace = workspaceUrl
    ? `<article class="card" aria-labelledby="canvas-workspace-heading">
        <div class="card-head"><h2 id="canvas-workspace-heading">Canvas workspace</h2></div>
        <p class="hint">Arrange agents and review workflows in your canvas workspace.</p>
        <a class="route" href="${escapeHtml(workspaceUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Open in canvas (new tab)">Open in canvas <span aria-hidden="true">↗</span></a>
      </article>`
    : ''
  const brand = escapeHtml(manifest.copy.brand)
  const headline = escapeHtml(manifest.copy.headline)
  const subhead = escapeHtml(manifest.copy.subhead)
  const footer = escapeHtml(manifest.copy.footer)
  const logo = manifest.logo.href
    ? `<img class="logo" src="${escapeHtml(manifest.logo.href)}" alt="${escapeHtml(manifest.logo.alt)}">`
    : `<span class="brand-mark">${brand}</span>`
  const storefront = deliveryClosed
    ? `<article class="card storefront"><div class="card-head"><h2>Delivery boundary</h2><span class="index">01</span></div><p class="hint">Delivery boundary closed. This exact route exposes no nested storefront, API, WebMCP, or Sandbox authority.</p></article>`
    : `<article class="card storefront">
        <div class="card-head"><h2>Catalog</h2><span class="index">01</span></div>
        <form id="catalog-search" role="search">
          <label class="sr-only" for="catalog-query">Search catalog</label>
          <input id="catalog-query" name="query" type="search" maxlength="280" placeholder="Search offers" aria-label="Search catalog">
          <button type="submit" aria-label="Search catalog">Search</button>
        </form>
        <div id="catalog-results" aria-live="polite"><p class="hint">Search to load the current catalog.</p></div>
        <div class="checkout-row"><button id="initiate-checkout" type="button" disabled aria-label="Initiate guarded checkout">Initiate guarded checkout</button></div>
        <section id="checkout-confirmation" class="confirmation" aria-labelledby="checkout-confirmation-heading" hidden>
          <h3 id="checkout-confirmation-heading">Review and confirm</h3>
          <p id="checkout-confirmation-summary" class="hint" aria-live="polite"></p>
          <dl><dt>Offer</dt><dd id="confirmation-offer"></dd><dt>Total</dt><dd id="confirmation-total"></dd><dt>Proof expires</dt><dd id="confirmation-expiry"></dd></dl>
          <button id="confirm-checkout" type="button" aria-label="Confirm checkout after reviewing the total">Confirm checkout</button>
        </section>
      </article>`
  const probes = deliveryClosed
    ? ''
    : `<article class="card">
        <div class="card-head"><h2>Machine probes</h2><span class="index">03</span></div>
        <div class="routes"><a class="route" href="${escapeHtml(`${basePath}/livez`)}"><code>GET /livez</code><span>liveness →</span></a><a class="route" href="${escapeHtml(`${basePath}/readyz`)}"><code>GET /readyz</code><span>dependencies →</span></a></div>
      </article>`
  const clientModule = deliveryClosed ? '' : `<script type="module" nonce="${nonce}" src="${modulePath}"></script>`
  const contentSecurityPolicy = deliveryClosed
    ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

  return new Response(`<!doctype html>
<html lang="${escapeHtml(manifest.locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="${escapeHtml(manifest.palette.background)}">
  <meta name="ag-catalog-path" content="${catalogPath}">
  <meta name="ag-runtime-base-path" content="${escapeHtml(basePath)}">
  <title>${brand}</title>
  <style>
    :root { color-scheme: dark; --ink: ${manifest.palette.ink}; --muted: ${manifest.palette.muted}; --line: ${manifest.palette.line}; --panel: ${manifest.palette.panel}; --accent: ${manifest.palette.accent}; --background: ${manifest.palette.background}; }
    * { box-sizing: border-box; }
    html { overflow-x: hidden; background: var(--background); }
    body { margin: 0; min-width: 0; min-height: 100vh; overflow-x: hidden; background: var(--background); color: var(--ink); font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .16; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(to bottom, black, transparent 75%); }
    main { position: relative; width: min(1120px, 100%); margin: auto; padding: 22px 18px 48px; }
    nav, .status-row, .card-head, footer, form { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    nav { min-height: 44px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
    .brand { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; color: var(--ink); text-decoration: none; font-weight: 800; letter-spacing: -.04em; }
    .brand-mark { color: var(--accent); }
    .logo { display: block; max-width: 180px; max-height: 44px; object-fit: contain; }
    .lane { padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .1em; }
    .hero { padding: 58px 0 36px; }
    .eyebrow { margin: 0 0 12px; color: var(--accent); font-size: 12px; letter-spacing: .16em; text-transform: uppercase; }
    h1 { max-width: 820px; margin: 0; overflow-wrap: anywhere; font: 700 clamp(42px, 9vw, 96px)/.93 system-ui, sans-serif; letter-spacing: -.075em; }
    .hero p { max-width: 640px; margin: 24px 0 0; color: var(--muted); font: 18px/1.6 system-ui, sans-serif; }
    .status-row { justify-content: flex-start; margin-top: 28px; flex-wrap: wrap; }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 15%, transparent); }
    .status-row strong { color: var(--accent); }
    .status-row span:last-child { color: var(--muted); font-size: 13px; }
    #offline-indicator[hidden] { display: none; }
    #offline-indicator { margin: 18px 0 0; padding: 12px 14px; border: 1px solid var(--accent); border-radius: 12px; color: var(--accent); }
    .grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 14px; }
    .card { min-width: 0; padding: 22px; border: 1px solid var(--line); border-radius: 18px; background: color-mix(in srgb, var(--panel) 92%, transparent); }
    .card-head { margin-bottom: 24px; }
    .card h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .12em; }
    .index { color: var(--muted); font-size: 12px; }
    dl { display: grid; grid-template-columns: minmax(120px, .7fr) minmax(0, 1.3fr); gap: 14px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { color: var(--accent); }
    .routes { display: grid; gap: 10px; }
    .route { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; color: var(--ink); text-decoration: none; border: 1px solid var(--line); border-radius: 12px; transition: border-color .15s, transform .15s; }
    .route:hover, .route:focus-visible { border-color: var(--accent); transform: translateY(-1px); outline: none; }
    .route span, .hint { color: var(--muted); }
    .storefront { grid-column: 1 / -1; }
    form { align-items: stretch; }
    input, button { min-height: 44px; border: 1px solid var(--line); border-radius: 10px; font: inherit; }
    input { min-width: 0; flex: 1; padding: 10px 12px; background: var(--background); color: var(--ink); }
    button { min-width: 44px; padding: 10px 16px; background: var(--accent); color: var(--background); cursor: pointer; font-weight: 800; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    button:focus-visible, input:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 2px; }
    #catalog-results { display: grid; gap: 10px; margin-top: 18px; }
    .listing { padding: 14px; border: 1px solid var(--line); border-radius: 12px; overflow-wrap: anywhere; }
    .listing h3 { margin: 0 0 6px; font: 700 18px/1.3 system-ui, sans-serif; }
    .listing p { margin: 0 0 12px; color: var(--muted); }
    .checkout-row { margin-top: 18px; }
    .confirmation { margin-top: 18px; padding: 16px; border: 2px solid var(--accent); border-radius: 12px; }
    .confirmation[hidden] { display: none; }
    .confirmation h3 { margin: 0 0 10px; font: 700 18px/1.3 system-ui, sans-serif; }
    .confirmation dl { margin: 12px 0; }
    footer { margin-top: 14px; padding: 18px 4px; color: var(--muted); font-size: 12px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @media (max-width: 720px) { main { padding-inline: 14px; } .hero { padding-top: 44px; } .grid { grid-template-columns: minmax(0, 1fr); } .storefront { grid-column: auto; } dl { grid-template-columns: 1fr; gap: 5px; } dd { margin-bottom: 12px; } footer, form { align-items: stretch; flex-direction: column; } button { width: 100%; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <main>
    <nav aria-label="Runtime navigation">
      <a class="brand" href="${homePath}" aria-label="${brand} home">${logo}</a>
      <span class="lane">${lane} lane</span>
    </nav>
    <section class="hero" aria-labelledby="storefront-heading">
      <p class="eyebrow">Edge commerce runtime</p>
      <h1 id="storefront-heading">${headline}</h1>
      <p>${subhead}</p>
      <div class="status-row" role="status"><span class="pulse" aria-hidden="true"></span><strong>Edge live</strong><span>Local-first storefront</span></div>
      <p id="offline-indicator" role="status" hidden>Offline — showing the last completed synchronization. Settlement is unavailable.</p>
    </section>
    <section class="grid" aria-label="Storefront and runtime details">
      ${storefront}
      ${workspace}
      <article class="card">
        <div class="card-head"><h2>Release identity</h2><span class="index">02</span></div>
        <dl><dt>Candidate</dt><dd><code>${releaseCandidateSha}</code></dd><dt>Worker version</dt><dd>${versionId}</dd><dt>Observed</dt><dd>${versionTimestamp}</dd></dl>
      </article>
      ${probes}
    </section>
    <footer><span>${footer}</span><span>Operational routes remain bearer-protected.</span></footer>
  </main>
  ${clientModule}
</body>
</html>`, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': contentSecurityPolicy,
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'referrer-policy': 'no-referrer',
    },
  })
}

export function dashboardResponse(metadata: ConsoleMetadata, options: ConsoleOptions = {}): Response {
  return consoleResponse(metadata, THEME_MANIFEST_DEFAULTS, options)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}

function formatTimestamp(value?: string): string {
  if (!value) return 'local development'
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString()
}
