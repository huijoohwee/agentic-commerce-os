---
title: "Native Commerce Workspaces"
doc_type: "Implementation"
version: "0.3.0"
date: "2026-09-12"
lang: "en-US"
frontmatter_contract: "required"
owner: "agentic-commerce-os"
continuity_id: "edge-commerce-agent-mvp"
local_rung: "dev-proven"
delivered_rung: "undocumented"
load_policy: "on-demand"
---

# Native commerce workspaces

This increment implements the same CID, RAO and SVO as the
[grounded PRD/TAD/ADR/MVP/GTM](prd-tad-adr-mvp-gtm-edge-commerce-agent.md).
The near-built buyer problem is a solo operator having to translate a reviewed offer into
privileged API calls before a shopper can use it. The new path is vendor proposal → admin
review → existing merchant storefront → human-confirmed provider checkout.

## Human flow

1. Use `/vendor` to enter buyer-facing copy and the merchant/registered-agent IDs, or import
   the offline workspace's `commerce.merchant-launch/v1` pack. Imports populate the supported
   copy and single-agent scope; they do not execute the pack's suggested action.
2. Stage the proposal. A live public catalog read captures the current manifest digest, or a
   confirmed missing theme. The exact normalized manifest and that base version are retained
   on this browser. Identical submissions reuse one proposal, with a maximum of 20 records.
3. Open `/admin`, connect with an existing operator credential and inspect the registry and
   the proposal's exact change. Approve/publish or reject using the visible controls.
4. Open `/s/{merchantId}`. Search, compare quoted totals, select an offer and review checkout.
   The existing human-presence/payment provider boundaries still control settlement.

Both new pages also work under `/agentic-commerce-os/`. Public page access grants no operator
authority. Vendor/admin describe workflow views for a solo operator; this is not a new tenant
identity system, vendor credential model, payout service, order ledger or RBAC implementation.
Provider admission/registration continues to use the existing operator API.

## Agent contract

Shopper tools retain `commerce.catalog.search`, `commerce.offer.select` and
`commerce.checkout.initiate`. The same actions now render catalog results, prices, selection
and checkout review for the person. Checkout preparation refuses overlapping preparations;
selection/search changes cannot silently replace the offer during preparation.

Merchant pages expose three optional tools through `document.modelContext`:

| Tool | Effect |
|---|---|
| `commerce.merchant.catalog` | Read a public merchant catalog and manifest version |
| `commerce.merchant.theme.stage` | Save a bounded proposal and render it in the visible review queue |
| `commerce.merchant.proposals.read` | Read this browser's visible local queue |

No tool connects an operator credential, approves/publishes a proposal or confirms payment.
The source-owned [WebMCP guard](../src/edge/client/webmcp-runtime.ts) is shared by both clients
and the existing sandbox proof. It feature-detects the native API, bounds registration, verifies
the live tool catalog before invocation and respects cancellation. Page exit aborts registrations.
No polyfill, model SDK or upstream prompt/code was adopted. Browsers without the experimental
API retain the complete manual flow. The Chromium contract fixture is not evidence of native
WebMCP availability in every browser.

## Write and recovery boundary

The operator credential remains in tab memory and is removed from the form after connection.
Disconnect/reload clears it; an obsolete connection response cannot reconnect a newer session.
Proposals never enter the shopper's automatic sync queue. IndexedDB atomically consumes a pending
proposal before a write, and BroadcastChannel updates other tabs without polling.

Human approval acquires the existing merchant authoring claim, submits the conditional theme
request and releases the exact claim. A stale lease epoch permits one bounded reacquisition
after a definitive refusal; publication is never automatically retried after an unknown result.
Another tab cannot consume the same proposal. The theme Durable Object checks the reviewed base
inside the same fenced SQLite transaction as activation. The base is included in the mutation
permit digest, preventing it from being changed after reservation. A newer, different live theme
produces `theme_review_stale`; an already identical live theme is an idempotent success.

Interrupted or failed publication retains an unresolved record. After the one-minute lease window,
**Check publication** reads the live version and compares it with the reviewed manifest. It does
not repeat the write. If versions differ, inspect the store and stage a fresh review. Completed,
rejected and unresolved local records can be explicitly removed to free capacity. A tab crash
during `applying` leaves the same read-only recovery path after reload.

Local proposal storage is shared between tabs on one browser/origin, not synchronized between
devices. Already loaded pages allow field edits and saved queue reads offline; staging needs a live base and
publication needs connectivity. This adds no offline page-navigation or remote backup guarantee.
The visible trusted-event check is a browser UI boundary, not a cryptographic human-presence
proof. Existing trusted operator HTTP/MCP APIs remain available to authorized operators.

## Source and validation

| Owner | Responsibility / check |
|---|---|
| [Dashboard](../src/edge/dashboard.ts), [role content](../src/edge/merchant-page.ts) | Shared mobile layout; no merchant client load on shopper pages |
| [Merchant state](../src/edge/client/merchant-state.client.js), [merchant client](../src/edge/client/merchant.client.js) | Existing IndexedDB, bounded proposals, human review and claim lifecycle |
| [Client composer](../src/edge/client/merchant-module.ts) | Native Worker text assets composed only when requested; shared database/WebMCP owners |
| [Theme preparation](../src/core/theme-deployment.ts), [store](../src/core/theme-deployment-store.ts) | Conditional envelope validation and atomic version guard |
| [Browser checks](../test/browser/merchant-workspace.spec.ts) | Staging/abort/privacy, two-tab approval, XSS-safe rendering, prefix, reload and shopper agent UI |
| [SQLite check](../test/workers/theme-review.property.test.ts) | Create, update, stale proposal, tampered permit and identical replay |
| [Dev loop](../test/e2e/dev-paid-loop.spec.ts) | Import, human publish, second reviewed edit, discovery, one confirmation/settlement/markup and replay |

No package dependency, service, database namespace, provider, wallet or payment rail was added.
The browser assets remain separate from the worker's executable chunk; every emitted JavaScript
file stays subject to the existing 500,000-byte cap. Authored owners stay below 600 lines.
Observed suite results and release boundaries are retained in the [handoff](edge-commerce-mvp-handoff.md).

## Inspiration, not implementation dependencies

Reviewed on 2026-09-12; the linked source commits pin the comparison:

| Reference | Adopted idea and native boundary |
|---|---|
| [Mercur at 143258b](https://github.com/mercurjs/mercur/tree/143258bcc73a14e01c8d8a7a41bb38fefd5180df) | Distinct shopper/vendor/admin tasks. Its framework, database stack and marketplace implementation were not imported. |
| [Commerce agents at fd4d592](https://github.com/anthropics/commerce-agents/tree/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf) | Shopping preparation and merchant proposals handed to a person before consequential writes. Existing Commerce actions provide execution. |
| [WebMCP at 97da8f5](https://github.com/webmachinelearning/webmcp/tree/97da8f515427594c856307e3476c0a0db9698fbb), [API draft](https://webmachinelearning.github.io/webmcp/) | Native browser registration, abort lifecycle and advisory tool annotations; existing local guard remains the owner. |

No repository was forked, cloned into the product, copied or added to the dependency graph.
