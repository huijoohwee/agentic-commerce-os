export const EXPERIENCE_STYLES = String.raw`
* { box-sizing: border-box; }
:root { color-scheme: light; }
body { margin: 0; min-width: 0; background: var(--background); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font: inherit; color: inherit; min-height: 44px; min-width: 44px; border: 1px solid var(--line); border-radius: 8px; }
input, select, textarea { background: var(--panel); padding: 10px 12px; max-width: 100%; }
input { width: 100%; min-width: 0; }
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; padding: 10px 16px; font-weight: 600; background: var(--ink); color: var(--panel); min-height: 44px; border-radius: 8px; }
button.secondary, .button.secondary { background: var(--panel); color: var(--ink); border: 1px solid var(--line); }
button.quiet { background: transparent; color: var(--muted); border-color: transparent; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:hover:enabled, .button:hover { filter: brightness(.94); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
[hidden] { display: none !important; }
h1, h2, h3, p { margin-top: 0; }
h1 { font-size: clamp(30px, 4vw, 48px); line-height: 1.12; letter-spacing: -.04em; font-weight: 600; margin-bottom: 16px; overflow-wrap: anywhere; }
h2 { font-size: 20px; letter-spacing: -.025em; font-weight: 600; margin-bottom: 8px; }
h3 { font-size: 16px; margin-bottom: 6px; font-weight: 600; }
p { margin-bottom: 16px; }
.hint, .muted { color: var(--muted); font-size: 14px; }
.eyebrow { color: var(--muted); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .12em; margin-bottom: 12px; }
.topbar { min-height: 76px; padding: 12px 32px; border-bottom: 1px solid var(--line); background: var(--panel); display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { display: inline-flex; align-items: center; min-height: 44px; gap: 10px; font-size: 20px; letter-spacing: -.045em; font-weight: 750; }
.brand-symbol { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--ink); border-radius: 9px; font-size: 18px; }
.logo { max-width: 150px; max-height: 40px; object-fit: contain; }
.workspace-nav { display: flex; align-items: center; gap: 6px; }
.workspace-nav a { display: inline-flex; justify-content: center; align-items: center; min-width: 44px; min-height: 44px; padding: 8px 12px; font-size: 13px; color: var(--muted); border-radius: 7px; }
.workspace-nav a[aria-current] { color: var(--ink); background: var(--background); box-shadow: inset 0 0 0 1px var(--line); }
.skip-link { position: absolute; top: -100px; left: 12px; z-index: 20; }
.skip-link:focus { top: 12px; }
.shop-main { max-width: 1380px; padding: 32px; margin: auto; }
.hero { display: grid; grid-template-columns: 1.5fr 1fr; border: 1px solid var(--line); border-radius: 14px; margin-bottom: 32px; overflow: hidden; background: var(--panel); }
.hero-copy { padding: clamp(24px, 4vw, 52px); }
.hero-copy > p { max-width: 580px; }
.hero-art { background: color-mix(in srgb, var(--accent) 9%, var(--background)); display: flex; flex-direction: column; justify-content: center; padding: 36px; border-left: 1px solid var(--line); }
.journey { display: grid; gap: 16px; list-style: none; padding: 0; margin: 0; }
.journey li { display: flex; align-items: center; gap: 16px; font-size: 14px; }
.journey b { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: var(--panel); border: 1px solid var(--line); font-size: 12px; font-weight: 500; }
.catalog-heading, .section-head, .toolbar, .actions, .pagination, footer { display: flex; gap: 16px; justify-content: space-between; align-items: center; }
.catalog-heading { margin-bottom: 20px; }
.catalog-heading h2 { margin: 0; font-size: 25px; }
#catalog-search { display: flex; gap: 8px; width: min(100%, 460px); }
.catalog-layout { display: grid; grid-template-columns: 196px minmax(0, 1fr); gap: 24px; align-items: start; }
.filters { padding: 20px; border: 1px solid var(--line); background: var(--panel); border-radius: 10px; display: grid; gap: 20px; }
.filters summary { display: none; }
label { display: grid; gap: 7px; font-size: 13px; font-weight: 550; }
.filters label { margin-bottom: 14px; }
.toolbar { margin-bottom: 18px; font-size: 13px; flex-wrap: wrap; }
.toolbar select { min-height: 44px; }
#catalog-results { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.listing { min-width: 0; overflow-wrap: anywhere; }
.product-card { border: 1px solid var(--line); border-radius: 11px; background: var(--panel); overflow: hidden; display: flex; flex-direction: column; }
.product-art { min-height: 136px; background: color-mix(in srgb, var(--accent) 8%, var(--background)); display: flex; align-items: center; justify-content: center; position: relative; }
.product-art span { font-size: 42px; letter-spacing: -.09em; opacity: .65; font-weight: 300; }
.product-art small { position: absolute; top: 12px; left: 12px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.product-copy { padding: 18px; display: grid; gap: 6px; flex: 1; }
.product-copy p { margin-bottom: 4px; }
.product-copy .summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.product-copy .actions { margin-top: 8px; flex-wrap: wrap; gap: 6px; align-items: stretch; }
.product-copy button { flex: 1; font-size: 12px; padding: 8px; }
button[aria-pressed=true] { box-shadow: 0 0 0 2px var(--accent); }
.empty-state { grid-column: 1 / -1; padding: 48px 24px; text-align: center; border: 1px dashed var(--line); border-radius: 10px; background: var(--panel); }
.empty-state p { max-width: 460px; margin-inline: auto; }
.pagination { justify-content: flex-end; font-size: 13px; margin-top: 18px; }
.checkout-bar { margin-top: 28px; padding: 20px; border: 1px solid var(--line); background: var(--panel); border-radius: 12px; display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; }
.checkout-bar p { margin-bottom: 0; }
.checkout-bar h3 { margin-bottom: 4px; }
.confirmation { margin-top: 20px; padding: 28px; border: 1px solid var(--accent); border-radius: 12px; background: var(--panel); }
.confirmation dl { margin: 20px 0; }
dl { display: grid; grid-template-columns: minmax(90px, .5fr) minmax(0, 1fr); gap: 10px 24px; font-size: 14px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
#offline-indicator { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; background: var(--panel); }
.workspace { --ink: #202723; --muted: #5d6861; --line: #dfe4e0; --panel: #ffffff; --accent: #316a50; --background: #f7f8f7; }
.workspace-shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: calc(100vh - 76px); }
.sidebar { padding: 28px 16px; background: var(--panel); border-right: 1px solid var(--line); }
.sidebar .eyebrow { padding: 0 12px; margin-bottom: 18px; }
.sidebar nav { display: grid; gap: 5px; }
.sidebar a { display: flex; align-items: center; gap: 12px; padding: 11px 12px; min-height: 44px; border-radius: 7px; color: var(--muted); font-size: 14px; }
.sidebar a[aria-current] { background: var(--background); color: var(--ink); font-weight: 600; }
.nav-icon { width: 18px; text-align: center; font-size: 16px; }
.sidebar-note { border-top: 1px solid var(--line); margin: 28px 12px; padding-top: 20px; font-size: 12px; color: var(--muted); }
.workspace-main { padding: 32px clamp(20px, 4vw, 52px); max-width: 1500px; width: 100%; min-width: 0; margin: 0 auto; }
.page-heading { display: flex; align-items: start; justify-content: space-between; margin-bottom: 24px; gap: 16px; }
.page-heading h1 { font-size: 30px; margin-bottom: 8px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: var(--background); font-size: 11px; white-space: nowrap; }
.badge[data-status=pending] { color: #835f0d; background: #fff9e8; border-color: #ecdcaf; }
.badge[data-status=applied], .badge[data-status=active] { color: #286348; background: #edf7f0; border-color: #c4dfcd; }
.badge[data-status=uncertain] { color: #974031; background: #fff2ec; border-color: #e9cfc4; }
.panel, .card { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); margin-bottom: 20px; min-width: 0; }
.panel-body, .card { padding: 24px; }
.section-head { padding: 20px 24px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.section-head h2, .section-head p { margin-bottom: 0; }
.editor-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(260px, .85fr); gap: 24px; align-items: start; }
.stack { display: grid; gap: 20px; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field-note { font-size: 12px; font-weight: 400; color: var(--muted); }
.panel-footer { border-top: 1px solid var(--line); padding: 16px 24px; }
.preview { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.preview-top { display: flex; justify-content: space-between; padding: 12px 16px; font-size: 12px; border-bottom: 1px solid var(--line); }
.preview-body { padding: 40px 24px; background: color-mix(in srgb, var(--accent) 7%, var(--panel)); overflow-wrap: anywhere; }
.preview-body h3 { font-size: 28px; line-height: 1.2; letter-spacing: -.045em; }
.preview-bottom { padding: 20px; }
.preview .product-art { min-height: 84px; border-radius: 7px; }
.stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
.stat { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 20px; }
.stat p { margin-bottom: 12px; font-size: 13px; color: var(--muted); }
.stat strong { font-size: 28px; font-weight: 550; letter-spacing: -.04em; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
caption { text-align: left; padding: 12px 24px; color: var(--muted); font-size: 12px; }
th { font-weight: 500; color: var(--muted); background: var(--background); }
th, td { padding: 12px 24px; border-top: 1px solid var(--line); vertical-align: middle; }
tbody tr:hover { background: var(--background); }
td:first-child { min-width: 170px; } td small { display: block; color: var(--muted); }
td button { font-size: 12px; }
.table-toolbar { display: flex; padding: 16px 24px; gap: 12px; flex-wrap: wrap; }
.table-toolbar input { flex: 1; width: auto; min-width: 150px; }
.proposal-card { border-bottom: 1px solid var(--line); padding: 22px 24px; }
.proposal-card:last-child { border-bottom: 0; }
.proposal-card .section-head { padding: 0; border: 0; margin-bottom: 12px; }
.proposal-card .actions { justify-content: flex-start; flex-wrap: wrap; }
.proposal-card details { margin: 12px 0; }
summary { cursor: pointer; min-height: 44px; padding: 10px 0; font-size: 13px; }
pre { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; border-radius: 8px; background: var(--background); }
.notice { font-size: 13px; color: var(--muted); border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; border-radius: 8px; }
#merchant-status:empty { display: none; }
#merchant-status { position: sticky; bottom: 16px; z-index: 5; box-shadow: 0 6px 25px #00000012; color: var(--ink); }
#operator-connect { display: flex; gap: 10px; max-width: 620px; }
#operator-disconnect { margin-top: 12px; }
.route { display: inline-flex; align-items: center; min-height: 44px; gap: 10px; font-size: 13px; text-decoration: underline; text-underline-offset: 4px; }
footer { border-top: 1px solid var(--line); margin-top: 36px; padding-top: 20px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
dialog { border: 1px solid var(--line); border-radius: 14px; padding: 0; width: min(640px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); color: var(--ink); background: var(--panel); }
dialog::backdrop { background: #12251a66; }
dialog .panel-body { overflow-wrap: anywhere; }
dialog .section-head { position: sticky; top: 0; background: var(--panel); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 1100px) { #catalog-results { grid-template-columns: repeat(2, minmax(0, 1fr)); } .workspace-shell { grid-template-columns: 188px minmax(0,1fr); } .editor-grid { grid-template-columns: 1fr; } }
@media (max-width: 720px) {
  .topbar { padding: 10px 16px; gap: 8px; } .brand { font-size: 17px; } .brand-symbol { display: none; } .workspace-nav a { padding: 8px; }
  .shop-main { padding: 20px 16px; } .hero { grid-template-columns: 1fr; margin-bottom: 28px; } .hero-copy { padding: 28px 24px; } .hero-art { border-left: 0; border-top: 1px solid var(--line); padding: 18px 24px; } .journey { gap: 10px; }
  .catalog-heading { display: grid; gap: 16px; } #catalog-search { width: 100%; } .catalog-layout { grid-template-columns: 1fr; gap: 16px; } .filters { padding: 8px 16px; display: block; } .filters summary { display: list-item; } .filters label { margin-top: 12px; }
  #catalog-results { gap: 10px; } .product-copy { padding: 12px; } .product-art { min-height: 116px; } .product-copy h3 { font-size: 14px; } .product-copy .summary { font-size: 12px; } .product-copy .actions { flex-direction: column; }
  .workspace-shell { display: block; } .sidebar { border-right: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; } .sidebar > .eyebrow, .sidebar-note { display: none; } .sidebar nav { display: flex; gap: 4px; overflow-x: auto; } .sidebar a { white-space: nowrap; padding: 10px; font-size: 13px; } .nav-icon { display: none; }
  .workspace-main { padding: 24px 16px; } .page-heading { margin-bottom: 18px; } .page-heading h1 { font-size: 27px; } .page-heading .badge { display: none; }
  .section-head, .panel-body, .card { padding: 18px; } .editor-grid { gap: 0; } .field-grid { grid-template-columns: 1fr; } .stat-grid { gap: 8px; } .stat { padding: 14px 10px; } .stat p { font-size: 11px; } .stat strong { font-size: 24px; }
  .proposal-card { padding: 18px; } .table-toolbar { padding: 12px 18px; } th, td { padding: 12px 18px; } .checkout-bar { grid-template-columns: 1fr; } .checkout-bar button { width: 100%; } .pagination { gap: 8px; justify-content: space-between; }
  .table-wrap table, .table-wrap tbody { display: block; } .table-wrap caption { display: block; padding: 12px 18px; }
  .table-wrap thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  .table-wrap tr { display: grid; grid-template-columns: 1fr 1fr; padding: 14px 18px; border-top: 1px solid var(--line); gap: 12px; }
  .table-wrap td { display: block; min-width: 0; padding: 0; border: 0; overflow-wrap: anywhere; }
  .table-wrap td:first-child, .table-wrap td:last-child { grid-column: 1 / -1; } .table-wrap td:first-child { font-weight: 600; }
  .table-wrap td:not(:first-child):not(:last-child)::before { content: attr(data-label); display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .table-wrap td button { width: 100%; }
  .confirmation { padding: 20px; } #operator-connect { flex-wrap: wrap; } #operator-connect input { flex: 1; min-width: 180px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
`
