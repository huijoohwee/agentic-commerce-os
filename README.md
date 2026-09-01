# Agentic Commerce OS

Cloudflare-native commerce control plane for a solo-operated, AI-native product.
It is split into an authenticated MCP/HTTP edge and a private core Worker with
SQLite Durable Objects. The core stores ACOS admission receipts, owns exclusive
intent routing, and enforces receipt-bound checkout and reconciliation fences. Existing upstream services remain the sole
owners of discovery execution, graph state, guardrails, issuance, settlement,
vendor D1 state, and payout dispatch.

This repository implements the committed `v0.3.0` requirements in
`knowgrph-agentic-commerce-platform-prd-tad-adr.md` at Knowgrph commit
`1acbbcc3b06534f9712f5b05b781010f749fa842`. Uncommitted revisions of that
document were deliberately excluded from the implementation baseline.

## Runtime shape

```text
browser or MCP client
        |
        v
authenticated edge Worker
        |  private Service Binding
        v
commerce core Worker
  | AgentRegistry DO
  | IntentRoute DO
  | CheckoutSession DO
  |
  +--> authoritative ACOS admission provider
  +--> canonical docs MCP projection
  +--> checkout/guardrail provider
  +--> marketplace/settlement provider
```

The logical bindings are `ACOS_ADMISSION`, `DOCS_MCP`, `CHECKOUT_PROVIDER`, and
`MARKETPLACE_PROVIDER`. Current Cloudflare service target names still use their
pre-migration upstream names; they are config-only identities, not new aliases or
public contracts. A later upstream rename changes the service targets and pinned
proof, not application code or duplicated invocation dictionaries.

## Start and verify

Requires Node.js 22.22 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

`npm run dev` runs edge, core, and one explicitly demo-only provider Worker
locally, including a minimal three-token invocation fixture. It performs no
cloud or payment mutation. `npm run dev:offline` runs the same boundaries under
the complete local workerd test harness in watch mode.

Open the edge root (Wrangler defaults to `http://localhost:8787/`) for the
read-only, mobile-first runtime console. The console exposes only sanitized
release identity and links to the machine-readable probes; operational routes
remain bearer-protected.

The release gate is:

```bash
npm run check
```

It regenerates binding types, compiles strictly, runs domain and invocation
tests, runs real Workers plus SQLite Durable Objects under workerd, and bundles
both Dev and Production targets without deploying.

## Repository lifecycle

This repository consumes the universal ADLC contracts pinned from `agentic-os`.
Use `npm run lane -- <intent>` to open isolated work, `npm run land` to publish
its exact head for protected review, and `npm run reap` to classify exact
integration. `npm run sync:canonical` only plans a guarded synchronization of a
clean canonical checkout; applying that plan requires its printed authorization
and exclusive-operation tokens.

The repository profile is retain-only. A green check, merged pull request, or
successful `reap` result is evidence, not cleanup authority. Worktree, branch,
tracking-ref, and object retirement remain separate owner-authenticated effects
and require target-specific clean-detachment and no-remaining-value receipts.
Product deployment, rollback, and Production authorization remain governed by
the Commerce runtime contracts below.

## Readiness boundary

`GET /livez` proves only that the edge code is executing. `GET /readyz` is
fail-closed and requires all of the following:

- distinct, sufficiently strong Production bearer secrets;
- an exact release-candidate SHA shared by edge and core;
- a healthy private ACOS admission provider advertising the exact
  `acos-adapter-registration/v1` receipt schema;
- exactly one verified active `flight` and one verified active `shopping`
  admission, each bound to the current invocation proof;
- the pinned full `/`, `#`, and `@` invocation catalog and exact token rows;
- every registered discovery MCP tool;
- healthy checkout and marketplace providers with their exact capability
  contracts; and
- immutable provider-version evidence matching the configured PRD, source,
  storage-compatibility, receipt digest, and complete VCC check sets.

Source checks do not imply a live Production release. Protected integration,
Cloudflare resources, upstream contract convergence, agent registration,
consumer binding, a human-approved Production deployment, live probes, and a
rollback receipt are separate evidence.

See [runtime API](docs/runtime-api.md) and
[Production runtime contract](docs/production-runtime.md).
