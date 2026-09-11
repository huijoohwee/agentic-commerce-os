import { merchantPage, merchantNavigation } from './merchant-page'
import { SHOPPER_PAGE } from './shopper-page'
import { EXPERIENCE_STYLES } from './experience-styles'
import { THEME_MANIFEST_DEFAULTS, type ThemeManifest } from '../shared/theme-manifest'
import { graphWorkspaceUrl } from './graph-workspace'

export type ConsoleMetadata = Readonly<{
  lane: string
  releaseCandidateSha: string
  version: Readonly<{ id?: string; tag?: string; timestamp?: string }>
}>

export type ConsoleOptions = Readonly<{
  workspaceRole?: 'admin' | 'vendor'
  basePath?: string
  catalogPath?: string
  clientModulePath?: string
  deliveryBoundary?: 'open' | 'closed'
  graphWorkspaceUrl?: string
}>

export function consoleResponse(metadata: ConsoleMetadata, manifest: ThemeManifest = THEME_MANIFEST_DEFAULTS, options: ConsoleOptions = {}): Response {
  const nonce = crypto.randomUUID().replace(/-/gu, '')
  const base = options.basePath ?? ''
  const home = escapeHtml(base ? `${base}/` : '/')
  const role = options.workspaceRole
  const closed = options.deliveryBoundary === 'closed'
  const brand = escapeHtml(manifest.copy.brand)
  const modulePath = escapeHtml(options.clientModulePath ?? `${base}/assets/${role ? 'merchant' : 'storefront'}.js`)
  const workspaceUrl = closed ? null : graphWorkspaceUrl(options.graphWorkspaceUrl, metadata.lane)
  const canvas = workspaceUrl ? `<a class="route" href="${escapeHtml(workspaceUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Open in canvas (new tab)">Open in canvas ↗</a>` : ''
  const navigation = closed ? '' : `<nav class="workspace-nav" aria-label="Runtime navigation"><a href="${home}" ${!role ? 'aria-current="page"' : ''}>Shop</a><a href="${escapeHtml(base)}/vendor" ${role === 'vendor' ? 'aria-current="page"' : ''}>Vendor</a><a href="${escapeHtml(base)}/admin" ${role === 'admin' ? 'aria-current="page"' : ''}>Admin</a></nav>`
  const runtime = role === 'admin' && !closed ? `<section data-views="runtime" hidden><article class="card"><h2>Release identity</h2><dl><dt>Lane</dt><dd>${escapeHtml(metadata.lane)}</dd><dt>Candidate</dt><dd>${escapeHtml(metadata.releaseCandidateSha)}</dd><dt>Version</dt><dd>${escapeHtml(metadata.version.id ?? 'local')}</dd><dt>Created</dt><dd>${escapeHtml(metadata.version.timestamp ?? 'local development')}</dd></dl></article><article class="card"><h2>Machine probes</h2><p class="hint">Inspect availability and runtime dependencies.</p><div class="actions"><a class="route" href="${escapeHtml(base)}/livez">GET /livez</a><a class="route" href="${escapeHtml(base)}/readyz">GET /readyz</a></div></article></section>` : ''
  const content = closed ? `<article class="card"><h1>Delivery boundary</h1><p class="hint">Delivery boundary closed. This exact route exposes no nested storefront, API, WebMCP, or Sandbox authority.</p></article>` : role
    ? `<header class="page-heading"><div><p class="eyebrow">${role} workspace</p><h1 id="workspace-heading" tabindex="-1">${role === 'vendor' ? 'Storefront' : 'Overview'}</h1><p class="hint">${role === 'vendor' ? 'Build a store your first customer can trust.' : 'A clear view of your marketplace and the changes that need you.'}</p></div><span class="badge">${escapeHtml(metadata.lane)}</span></header>${merchantPage(role)}${runtime}`
    : `<section class="hero" aria-labelledby="storefront-heading"><div class="hero-copy"><p class="eyebrow">Independent businesses · Agent-powered discovery</p><h1 id="storefront-heading">${escapeHtml(manifest.copy.headline)}</h1><p class="hint">${escapeHtml(manifest.copy.subhead)}</p><a class="button" href="#catalog">Explore offers <span aria-hidden="true">↗</span></a></div><div class="hero-art"><p class="eyebrow">Good work starts here</p><ol class="journey"><li><b>01</b>Find an offer for your next step</li><li><b>02</b>Compare the details and total</li><li><b>03</b>You confirm every purchase</li></ol></div></section>${SHOPPER_PAGE}`
  return new Response(`<!doctype html><html lang="${escapeHtml(manifest.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="${manifest.palette.background}"><meta name="ag-catalog-path" content="${escapeHtml(options.catalogPath ?? `${base}/v1/public/agents`)}"><meta name="ag-runtime-base-path" content="${escapeHtml(base)}"><meta name="ag-workspace-role" content="${role ?? 'shopper'}"><title>${role ? role[0]?.toUpperCase() + role.slice(1) + ' · ' : ''}${brand}</title>
  <style>:root { --ink: ${manifest.palette.ink}; --muted: ${manifest.palette.muted}; --line: ${manifest.palette.line}; --panel: ${manifest.palette.panel}; --accent: ${manifest.palette.accent}; --background: ${manifest.palette.background}; }${EXPERIENCE_STYLES}</style></head><body class="${role ? 'workspace' : 'shopper'}">
  <a href="#main-content" class="skip-link button">Skip to content</a><header class="topbar"><a class="brand" href="${home}" aria-label="${brand} home">${manifest.logo.href ? `<img class="logo" src="${escapeHtml(manifest.logo.href)}" alt="${escapeHtml(manifest.logo.alt)}">` : `<span class="brand-symbol" aria-hidden="true">a↗</span>${brand}`}</a>${navigation}</header>
  <div class="${role ? 'workspace-shell' : ''}">${role && !closed ? merchantNavigation(role) : ''}<main id="main-content" class="${role ? 'workspace-main' : 'shop-main'}"><p id="offline-indicator" role="status" hidden>Offline — showing the last completed synchronization. Settlement is unavailable.</p>${content}<footer><span>${escapeHtml(manifest.copy.footer)}</span>${canvas}<span>${role ? 'Your changes, reviewed.' : 'Browse · choose · review'}</span></footer></main></div>
  ${closed ? '' : `<script type="module" nonce="${nonce}" src="${modulePath}"></script>`}</body></html>`, { headers: {
    'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': closed ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" : `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'referrer-policy': 'no-referrer',
  } })
}

export function dashboardResponse(metadata: ConsoleMetadata, options: ConsoleOptions = {}): Response {
  return consoleResponse(metadata, THEME_MANIFEST_DEFAULTS, options)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}
