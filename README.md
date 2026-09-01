# Agentic Commerce OS

Cloudflare-native commerce control plane for a solo-operated, AI-native product.
It is split into a public storefront plus authenticated MCP/HTTP edge and a
private core Worker with SQLite Durable Objects. The core stores ACOS admission
receipts, performs deterministic neutral routing, holds receipt-bound checkout
and offer-change fences, records derived markup, activates merchant themes, and
guards concurrent authoring. Existing upstream services remain the sole owners
of discovery execution, graph state, guardrails, issuance, authoritative money
and vendor ledgers, settlement, and payout dispatch.

This repository implements the committed `v0.3.0` requirements in
`knowgrph-agentic-commerce-platform-prd-tad-adr.md` at Knowgrph commit
`1acbbcc3b06534f9712f5b05b781010f749fa842`. Uncommitted revisions of that
document were deliberately excluded from the implementation baseline.

## Runtime shape

```text
browser or MCP client
        |
        v
public storefront + authenticated edge Worker
        |  private Service Binding
        v
commerce core Worker
  | AgentRegistry DO       | RevenueLedger DO
  | IntentRoute DO         | ThemeDeployment DO
  | CheckoutSession DO     | AuthoringClaim DO
  |
  +--> authoritative ACOS admission provider
  +--> canonical docs MCP projection
  +--> checkout/guardrail provider
  +--> marketplace/settlement provider

separate Dev-only Sandbox Executor Worker
  +--> one bounded Cloudflare Sandbox container instance
```

The logical bindings are `ACOS_ADMISSION`, `DOCS_MCP`, `CHECKOUT_PROVIDER`, and
`MARKETPLACE_PROVIDER`. Their Cloudflare targets use the canonical AgenticGraph
service identities; bootstrap fails closed until every upstream Production
service and its pinned contract are independently present and ready.

All new platform terminology is AgenticGraph. The legacy names in the baseline
sentence above and in externally owned service targets are retained only where
`config/terminology-register.json` records provenance or upstream ownership.

## Start and verify

Requires Node.js 22.22 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Before starting, add a locally generated `STOREFRONT_SESSION_SECRET` to
`.dev.vars`. Generate it with a cryptographically secure password manager or
secret generator; use at least 32 characters and never commit the value. The
tracked example is intentionally unchanged because it belongs to a separate
admitted owner.

`npm run dev` runs edge, core, and one explicitly demo-only provider Worker
locally, including a minimal three-token invocation fixture. It performs no
cloud or payment mutation. `npm run dev:offline` runs the same boundaries under
the complete local workerd test harness in watch mode; it is a test harness, not
a third Dev runtime entry point. `npm run dev:apex` starts the same Dev topology
on port 5173. This preserves the pre-existing `dev:offline` contract while the
feature specification counts exactly the two Wrangler launch commands.

Open the edge root (Wrangler defaults to `http://localhost:8787/`) for the
mobile-first Storefront Console. The page offers public sanitized catalog reads,
same-origin session-scoped discovery and checkout preparation, and a WebMCP
projection over those same client actions. It cannot confirm settlement. Agent
and operator routes remain separately bearer-protected.

The source-and-bundle gate is:

```bash
npm run check:implementation
```

The terminal evidence gate is:

```bash
npm run check
```

The first command regenerates binding types, compiles strictly, runs domain,
browser, invocation, and real Worker/SQLite-Durable-Object checks, and bundles
Dev and Production targets without deploying. Its Sandbox check proves the
source-level isolation harness while leaving provisioned-runtime attestation to
the terminal gate. The second command additionally requires one current
independent evidence verdict for every bounded specification task, including
the externally attested Sandbox receipt. It is intentionally red when any
verdict is missing, stale, failed, or self-issued; a green source check is not
silently promoted to completion or deployment readiness.

## Repository lifecycle

This repository consumes the universal ADLC contracts pinned from `agentic-os`.
Use `npm run lane -- <intent>` to open isolated work, `npm run land` to publish
its exact head for protected review, and `npm run reap` to classify exact
integration. `npm run sync:canonical` only plans a guarded synchronization of a
clean canonical checkout; applying that plan requires its printed authorization
and exclusive-operation tokens.

The repository profile permits owner-authenticated quarantine of only the exact
worktree projection and its registration. A green check, merged pull request,
or successful `reap` result is evidence, not cleanup authority. Remote-tracking
refs, local and remote branches, and unreachable objects remain retained;
quarantine still requires target-specific clean-detachment and no-remaining-value
receipts.
Product deployment, rollback, and Production authorization remain governed by
the Commerce runtime contracts below.

## Readiness boundary

`GET /livez` proves only that the edge code is executing. A direct Worker
`GET /readyz` is a fail-closed source/live diagnostic and requires all of the
following:

- distinct, sufficiently strong Production bearer secrets plus the storefront
  session signing secret;
- a reviewed Ed25519 human-presence trust anchor and a same-origin browser
  adapter that obtains fresh signed receipts from the selected shopper identity
  or payment provider; settlement remains closed when either is absent;
- an exact release-candidate SHA shared by edge and core;
- a healthy private ACOS admission provider advertising the exact
  `acos-adapter-registration/v1` receipt schema;
- at least one verified active `flight` and one verified active `shopping`
  admission, with every active row bound to the current invocation proof;
- the pinned full `/`, `#`, and `@` invocation catalog and exact token rows;
- every registered discovery MCP tool;
- healthy discovery, checkout, and marketplace providers with their distinct
  exact capability and evidence contracts; and
- immutable provider-version evidence matching the configured PRD, source,
  storage-compatibility, receipt digest, and required VCC check sets. Named
  surplus checks are accepted; missing or incompatible evidence blocks.

Source checks do not imply a live Production release. Protected integration,
Cloudflare resources, upstream contract convergence, agent registration,
consumer binding, a human-approved Production deployment, live probes, and a
reviewed external rollback authorization and proof are separate evidence.

Production declares only the exact non-wildcard route
`https://airvio.co/agentic-commerce-os`. That closed-boundary HTML response
derives live readiness for the same request and exposes only typed, no-store
candidate and edge/core version headers when verified. Nested `/readyz`, API,
asset, MCP, and WebMCP paths are not covered by that route, and direct diagnostic
readiness is never reused as exact-route proof.

See [runtime API](docs/runtime-api.md) and
[Production runtime contract](docs/production-runtime.md).

## Protected release boundary

Production mutation is disabled. The manual GitHub Actions workflow binds its
mode and candidate to protected `main`, runs locked implementation and dry-bundle
checks, requires an exact configured Production user reviewer, rechecks the
candidate, and then emits a typed refusal. It receives no Cloudflare credential
and contains no upload, deploy, route mutation, rollback, or secret transport.

Every repository `deploy:production:*` entrypoint also terminates in the local
controller; none chains to Wrangler deploy. Production remains blocked until an
external controller supplies an enforceable lease/fence/CAS, exact remote
migration identity, N/N-1 compatibility proof, and live-readback receipts. The
generated mirror at `GitHub/huijoohwee/content/agentic-commerce-os` has zero
authored edit targets in this repository.

The protected `Integration Gate` runs the evidence contract and the bounded
source-and-bundle gate. Terminal `npm run check` remains a separate readiness
decision because the repository has no 100-task verdict set. The portable task
snapshot assigns evidence-contract tasks to `check:evidence-contract` and
source-closure tasks to `check:implementation`, removing the prior aggregate
self-reference without treating absent external evidence as green.

Evidence capture is fail-closed for a second independent reason: this repository
does not own the evaluator trust root or an isolated check executor. A real run
must inject an external trust anchor that pins the baseline document, dispatch
issuer keys, and an out-of-workspace Git binary digest, plus signed performer
artifacts from a default-deny runner. That trust policy must also attest exclusive
evaluator access and stable ancestry for the exact artifact sink. Without those
inputs, the evidence commands stop before launching a candidate-controlled subprocess.

The Merge Agent production entrypoint is also intentionally disabled. Its pure
bounded orchestrator and authority checks remain testable, but this repository
does not provide a default-deny execution boundary that can safely run
candidate-controlled checks without exposing operator files, credentials, or
host mutation authority. It therefore starts no `gh`, `git`, package, or test
subprocess and performs no automatic repair until an externally trusted runner
is supplied.

`STOREFRONT_SESSION_SECRET` is required for the first-party shopper session.
Create it with a cryptographically secure password generator and install it as a
Cloudflare Worker secret. Never commit, log, or pass the value on a command line.

`HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON` is a public deployment variable, not a
secret. It binds Staging and Production to one reviewed Ed25519 issuer. Each
visual settlement receipt is single-checkout and exact-fact bound to the session
nonce, shopper-principal digest, amount, currency, exact HTTPS relying-party
origin, stable checkout audience, and current blocker-set digest; a storefront
session or CSRF value alone grants no settlement authority.

The Dev-only walkthrough is [docs/demo.md](docs/demo.md). The specification asks
for the same file under `.kiro`, which is outside this admitted repository lane;
that split-owner projection remains an explicit follow-up rather than an
unauthorized cross-boundary write.
