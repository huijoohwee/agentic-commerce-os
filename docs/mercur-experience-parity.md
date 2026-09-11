---
title: "Native commerce experience — Mercur comparison"
doc_type: "validation"
version: "0.4.0"
continuity_id: "edge-commerce-agent-mvp"
date: "2026-09-12"
owner: "agentic-commerce-os"
load_policy: "on-demand"
lifecycle_status: "implemented-candidate"
---

# Native commerce experience

Scope and acceptance remain in [the combined PRD/TAD/ADR/MVP/GTM](prd-tad-adr-mvp-gtm-edge-commerce-agent.md)
at `edge-commerce-agent-mvp@0.4.0`. This is native UI/UX coverage for the existing first-dollar
contracts, not a claim of Mercur's entire marketplace feature set or production deployment.

## Reference and ownership

The comparison inspected the [Mercur shopper demo](https://demo.mercurjs.com/de/categories), its
home/catalog screens and the source at immutable revision
[`143258bcc73a14e01c8d8a7a41bb38fefd5180df`](https://github.com/mercurjs/mercur/tree/143258bcc73a14e01c8d8a7a41bb38fefd5180df).
The reference shows catalog grids, category filters, pagination and product detail navigation.
The [admin shell](https://github.com/mercurjs/mercur/blob/143258bcc73a14e01c8d8a7a41bb38fefd5180df/packages/admin/src/components/layout/main-layout/main-layout.tsx),
[vendor shell](https://github.com/mercurjs/mercur/blob/143258bcc73a14e01c8d8a7a41bb38fefd5180df/packages/vendor/src/components/layout/main-layout/main-layout.tsx)
and [product table](https://github.com/mercurjs/mercur/blob/143258bcc73a14e01c8d8a7a41bb38fefd5180df/packages/admin/src/pages/products/product-list/components/product-list-table/product-list-table.tsx)
ground role navigation, permission-aware actions, searchable tables and detail views. Admin/vendor
comparison is source-grounded; no authenticated Mercur account was accessed.

No reference code, CSS, images, icons, templates or dependencies were imported. The implementation
uses existing Workers, native browser modules, semantic HTML, CSS, dialog focus management and the
same WebMCP/manual action functions. Category art is native typography, not product photography.

## Coverage

| Experience pattern | Native behavior and evidence | Boundary |
|---|---|---|
| Shopper landing and catalog | Clear buyer headline, browse entry, category cards, provider identity, price and details; initial GET loads up to 100 listings | No fabricated offers, ratings, sales or inventory. Initial browsing invokes no agent discovery. |
| Filtering and pagination | Category and available-offer filters, name sorting, reset, 12 listings/page and matching count | Availability describes loaded offers. No cross-currency numeric price sorting or unsupported product attributes. |
| Product/offer detail | Native modal, complete summary, category/provider/listing and offer selection; Escape restores focus | Detail is the existing listing projection, not physical-product variants or inventory CRUD. |
| Checkout and confirmation | One chosen offer, exact minor-unit total, visible human review; confirmed total/offer/reference remain visible | Existing provider and human-presence authority; no multi-vendor cart, shipping/address or customer account service. Confirmation is shown only after backend acceptance. |
| Vendor workspace | Storefront, Catalog and Proposals navigation with reloadable hash views; edit form and immediate safe-text preview; live catalog lookup | Vendor is an authoring role for a solo operator, not authenticated tenant RBAC. Draft preview is labelled. |
| Admin workspace | Overview, Agents, Reviews and Runtime; connected agent count; local review counts; searchable/state-filtered/paginated registry, detail dialog | Up to first 100 agents displayed with explicit truncation count. No invented GMV, conversion, payout or order metrics. |
| Reviews | Search brand/store, filter pending/applied/rejected/uncertain/applying; timestamps and exact-change disclosure; explicit publish/reject and interrupted-publication checks | Existing local 20-proposal bound, operator credential and claim/CAS enforcement; no bulk financial writes. |
| Mobile and keyboard | Responsive navigation, two-column shopper cards, mobile record cards, labelled native controls, 44px targets, skip link and dialog focus | Browser tests cover Chromium at 360px plus 1440px screenshots. No claim of every browser or native WebMCP availability. |

The remaining Mercur features need source-owned backend contracts: catalog/inventory CRUD,
customer identity and addresses, order/fulfillment history, returns, promotions, commissions and
payouts. Adding menu placeholders or synthetic data would not implement these workflows. Graph
continues to own authoritative offers, payments, orders and settlement; Commerce does not create
a second ledger.

## Source and validation

- [Dashboard composition](../src/edge/dashboard.ts), [shared styles](../src/edge/experience-styles.ts),
  [shopper markup](../src/edge/shopper-page.ts), [role markup/navigation](../src/edge/merchant-page.ts).
- [Shopper composition](../src/edge/client/browser-module.ts) loads native Text owners for state,
  actions, view, checkout and boot; [merchant composition](../src/edge/client/merchant-module.ts)
  reuses the shared [navigation/dialog primitives](../src/edge/client/experience.client.js).
- [Merchant view](../src/edge/client/merchant-view.client.js) reads existing local proposals and
  authenticated registry data; [merchant actions](../src/edge/client/merchant.client.js) retain
  the existing transient credential and guarded publication path.
- [Experience behavior tests](../test/browser/commerce-experience.spec.ts) cover browse without
  eager discovery, filtering/pagination, detail selection/focus, safe preview, published catalog,
  review navigation, registry search, credential redaction and disconnect. The latest catalog snapshot
  is accepted offline only for its exact storefront path; another store’s snapshot is never substituted.
- [Existing browser safety tests](../test/browser/merchant-workspace.spec.ts),
  [checkout/offline/mobile checks](../test/browser/template-pack.spec.ts) and
  [real Dev paid loop](../test/e2e/dev-paid-loop.spec.ts) remain release checks.

Default theme colors/copy changed. The generated storage-compatibility fingerprint must be reviewed
under the existing release classifier; no Durable Object schema, migration, identity or ledger changed.
Deployment and merge retain their separate authorization gates.
