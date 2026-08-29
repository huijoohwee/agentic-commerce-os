type DashboardMetadata = Readonly<{
  lane: string
  releaseCandidateSha: string
  version: Readonly<{ id?: string; tag?: string; timestamp?: string }>
}>

export function dashboardResponse(metadata: DashboardMetadata): Response {
  const lane = escapeHtml(metadata.lane)
  const releaseCandidateSha = escapeHtml(metadata.releaseCandidateSha)
  const versionId = escapeHtml(metadata.version.id ?? 'local')
  const versionTimestamp = escapeHtml(formatTimestamp(metadata.version.timestamp))

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101713">
  <meta http-equiv="refresh" content="30">
  <title>Agentic Commerce OS</title>
  <style>
    :root { color-scheme: dark; --ink: #f3f0e8; --muted: #a9b2aa; --line: #34443a; --panel: #172019; --lime: #c6f36b; --mint: #7ee2ad; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #101713; color: var(--ink); font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .16; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(to bottom, black, transparent 75%); }
    main { position: relative; width: min(1120px, 100%); margin: auto; padding: 22px 18px 48px; }
    nav, .status-row, .card-head, footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    nav { padding-bottom: 22px; border-bottom: 1px solid var(--line); }
    .brand { color: var(--ink); text-decoration: none; font-weight: 800; letter-spacing: -.04em; }
    .brand span { color: var(--lime); }
    .lane { padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .1em; }
    .hero { padding: 58px 0 36px; }
    .eyebrow { margin: 0 0 12px; color: var(--mint); font-size: 12px; letter-spacing: .16em; text-transform: uppercase; }
    h1 { max-width: 820px; margin: 0; font: 700 clamp(42px, 9vw, 96px)/.93 system-ui, sans-serif; letter-spacing: -.075em; }
    .hero p { max-width: 640px; margin: 24px 0 0; color: var(--muted); font: 18px/1.6 system-ui, sans-serif; }
    .status-row { justify-content: flex-start; margin-top: 28px; flex-wrap: wrap; }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 0 6px #c6f36b1c; }
    .status-row strong { color: var(--lime); }
    .status-row span:last-child { color: var(--muted); font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 14px; }
    .card { min-width: 0; padding: 22px; border: 1px solid var(--line); border-radius: 18px; background: color-mix(in srgb, var(--panel) 92%, transparent); }
    .card-head { margin-bottom: 32px; }
    .card h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .12em; }
    .index { color: var(--muted); font-size: 12px; }
    dl { display: grid; grid-template-columns: minmax(120px, .7fr) minmax(0, 1.3fr); gap: 14px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { color: var(--mint); }
    .routes { display: grid; gap: 10px; }
    .route { display: flex; justify-content: space-between; gap: 12px; padding: 14px; color: var(--ink); text-decoration: none; border: 1px solid var(--line); border-radius: 12px; transition: border-color .15s, transform .15s; }
    .route:hover, .route:focus-visible { border-color: var(--lime); transform: translateY(-1px); outline: none; }
    .route span { color: var(--muted); }
    .invocations { grid-column: 1 / -1; }
    .tokens { display: flex; flex-wrap: wrap; gap: 10px; }
    .token { padding: 10px 12px; border-radius: 9px; background: #0d120f; color: var(--muted); }
    .token b { color: var(--lime); }
    footer { margin-top: 14px; padding: 18px 4px; color: var(--muted); font-size: 12px; }
    @media (max-width: 720px) { .hero { padding-top: 44px; } .grid { grid-template-columns: 1fr; } .invocations { grid-column: auto; } dl { grid-template-columns: 1fr; gap: 5px; } dd { margin-bottom: 12px; } footer { align-items: flex-start; flex-direction: column; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <main>
    <nav aria-label="Runtime navigation">
      <a class="brand" href="/"><span>AC</span>/OS</a>
      <span class="lane">${lane} lane</span>
    </nav>
    <section class="hero">
      <p class="eyebrow">Edge commerce runtime</p>
      <h1>Agents discover. Humans decide.</h1>
      <p>A local-first control surface for MCP-native discovery, guarded checkout, and evidence-bound settlement.</p>
      <div class="status-row" role="status"><span class="pulse" aria-hidden="true"></span><strong>Edge live</strong><span>Auto-refreshes every 30 seconds</span></div>
    </section>
    <section class="grid" aria-label="Runtime details">
      <article class="card">
        <div class="card-head"><h2>Release identity</h2><span class="index">01</span></div>
        <dl>
          <dt>Candidate</dt><dd><code>${releaseCandidateSha}</code></dd>
          <dt>Worker version</dt><dd>${versionId}</dd>
          <dt>Observed</dt><dd>${versionTimestamp}</dd>
        </dl>
      </article>
      <article class="card">
        <div class="card-head"><h2>Machine probes</h2><span class="index">02</span></div>
        <div class="routes">
          <a class="route" href="/livez"><code>GET /livez</code><span>liveness →</span></a>
          <a class="route" href="/readyz"><code>GET /readyz</code><span>dependencies →</span></a>
        </div>
      </article>
      <article class="card invocations">
        <div class="card-head"><h2>Canonical invocation surface</h2><span class="index">03</span></div>
        <div class="tokens" aria-label="Invocation tokens">
          <span class="token"><b>/</b> commerce tool</span>
          <span class="token"><b>@</b> execution target</span>
          <span class="token"><b>#</b> capability context</span>
          <span class="token"><b>MCP</b> authenticated transport</span>
        </div>
      </article>
    </section>
    <footer><span>Agentic Commerce OS · browser shell</span><span>Operational routes remain bearer-protected.</span></footer>
  </main>
</body>
</html>`, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
    },
  })
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
