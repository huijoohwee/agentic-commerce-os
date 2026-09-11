# Agentic Commerce OS

Cloudflare-native commerce control plane for a solo-operated, AI-native product.
It is split into a public storefront plus authenticated MCP/HTTP edge and a
private core Worker with SQLite Durable Objects. The core stores ACOS admission
receipts, performs deterministic neutral routing, holds receipt-bound checkout
and offer-change fences, records derived markup, activates merchant themes, and
guards concurrent authoring. Existing upstream services remain the sole owners
of discovery execution, graph state, guardrails, issuance, authoritative money
and vendor ledgers, settlement, and payout dispatch.

This repository implements the committed `v0.3.0` requirements in the
`agentic-graph` commerce-platform PRD/TAD/ADR at source commit
`1acbbcc3b06534f9712f5b05b781010f749fa842`. Uncommitted revisions of that
document were deliberately excluded from the implementation baseline. The
bounded solopreneur MVP-to-GTM sprint over this source is specified in
[docs/prd-tad-adr-mvp-gtm-20260909T1320Z-solopreneur-mvp-gtm.md](docs/prd-tad-adr-mvp-gtm-20260909T1320Z-solopreneur-mvp-gtm.md).

The [grounded first-dollar increment](docs/prd-tad-adr-mvp-gtm-edge-commerce-agent.md)
connects the offline offer workspace to that existing merchant/checkout loop. Save buyer,
outcome and estimated costs, review the exact offer, then export its native merchant launch
pack. Import it in `/vendor`, stage a proposal, then connect and approve in `/admin`;
the existing `commerce.theme.deploy` operator API remains available.
the registered provider supplies the live quote and the human confirms payment. Local
review grants no publication/payment authority, and the asset-only release still cannot
collect payments. [Validation and remaining gates](docs/edge-commerce-mvp-handoff.md)
keep Dev evidence separate from a collected dollar or production release.

The [native workspaces](docs/native-commerce-workspaces.md) share shopper/merchant WebMCP actions
with the human UI. Merchant agents can stage proposals; operator review and an atomic live-version
check precede publication. Credentials stay in tab memory, and no new dependencies were added.
[Mercur experience coverage](docs/mercur-experience-parity.md) maps the native catalog, vendor preview
and admin tables to verified workflows and identifies the remaining backend gaps.

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

private Sandbox Executor Worker
  +--> one bounded Cloudflare Sandbox container instance
  +--> release-tuple evidence; no public route
```

The logical bindings are `ACOS_ADMISSION`, `DOCS_MCP`, `CHECKOUT_PROVIDER`, and
`MARKETPLACE_PROVIDER`. Their Cloudflare targets use canonical `agentic-graph`
service identities; bootstrap fails closed until every upstream Production
service and its pinned contract are independently present and ready. Core also
requires `DISCOVERY_PROVIDER_BEARER_TOKEN` and sends it on every `DOCS_MCP`
session lifecycle request; an absent or weak credential blocks discovery before
provider I/O.

All new platform terminology is `agentic-graph`. The legacy names in the baseline
sentence above and in externally owned service targets are retained only where
`config/terminology-register.json` records provenance or upstream ownership.

## Start and verify

Requires Node.js 22.22 or newer and the [local container runtime](docs/container-runtime.md)
prerequisites: running rootless Podman and an explicitly selected compatible `workerd`.

```bash
npm ci
cp .dev.vars.example .dev.vars
export MINIFLARE_WORKERD_PATH=/absolute/path/to/verified/workerd
npm run dev
```

Before starting, add locally generated `STOREFRONT_SESSION_SECRET` and
`DISCOVERY_PROVIDER_BEARER_TOKEN` values to `.dev.vars`. Generate each with a
cryptographically secure password manager or secret generator, use at least 32
characters, keep the discovery credential distinct from both edge bearer
tokens, and never commit either value.

`npm run dev` runs edge, core, the private Sandbox Executor, and one explicitly
demo-only provider Worker locally, including a minimal three-token invocation fixture. It performs no
cloud or payment mutation. `npm run dev:offline` runs the same boundaries under
the complete local workerd test harness in watch mode; it is a test harness, not
a third Dev runtime entry point. `npm run dev:apex` starts the same Dev topology
on port 5173. This preserves the pre-existing `dev:offline` contract while the
feature specification counts exactly the two Wrangler launch commands.

Open the edge root (Wrangler defaults to `http://localhost:8787/`) for the
mobile-first Storefront Console. The page offers public sanitized catalog reads,
same-origin session-scoped discovery and checkout preparation, and a WebMCP
projection over those same client actions. WebMCP cannot confirm settlement; the visible
human-confirmation control follows the existing provider and presence rules. Agent
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

- distinct, sufficiently strong Production edge bearer secrets, the core
  discovery-provider bearer secret, and the storefront session signing secret;
- a reviewed Ed25519 human-presence trust anchor and a same-origin browser
  adapter that obtains fresh signed receipts from the selected shopper identity
  or payment provider; settlement remains closed when either is absent;
- an exact release-candidate SHA shared by edge and core;
- a healthy private ACOS admission provider advertising
  `commerce.agentic-os-admission-provider/v3` and the exact
  `agentic-os-adapter-registration/v2` receipt schema; every registration must carry
  the complete stable `authoring_mutation_intent`, whose digest matches the
  12-header permit and whose four admission inputs exactly match the wire body;
  the operator instruction reference is exactly
  `operator://agentic-graph/commerce-adapter-admission/2026-09-03`;
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

Production declares only the exact prefix route
`https://airvio.co/agentic-commerce-os*`. The edge strips that prefix and serves
the Storefront Console plus its scoped readiness, catalog, session, checkout,
asset, MCP, and WebMCP paths; lookalike prefixes are rejected. Live proof binds
the exact candidate and active edge/core versions across representative public
boundaries. Direct private-Worker diagnostics are never reused as route proof.

See [runtime API](docs/runtime-api.md) and
[Production runtime contract](docs/production-runtime.md).

## Protected release boundary

The manual GitHub Actions workflow binds its mode and candidate to protected
`main`, runs locked implementation and all three dry-bundle checks, requires an
exact configured Production user reviewer, and rechecks the candidate before
exposing credentials to the release job. Its controller supports exact-baseline
bootstrap, authenticated steady state, and authenticated forward recovery. It
binds the canonical `config/production-core-services.json` Service Binding
manifest digest into the immutable candidate identity, then uploads core and
edge inactive, proves the immediate sandbox/container rollout,
compare-and-swaps the active three-Worker tuple before each activation, and
requires exact route readback before emitting a deployment receipt. Ambiguous or
partial transitions emit a preserve-required artifact; no path claims rollback.

Repository `deploy:production:*` entrypoints remain credentialless local guards
and cannot bypass that protected workflow. A live release remains blocked until
the operator supplies current provider/admission pins, distinct secrets, route
authority, and any mode-required prior artifact. The generated mirror at
`GitHub/huijoohwee/content/agentic-commerce-os` has zero authored edit targets
in this repository.

The protected `Integration Gate` first runs the pinned upstream ADLC evaluations
through `npm run check:adlc`, then the evidence contract and the bounded
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
