# Runtime API and ownership contract

## Boundaries and authorities

The edge Worker is the only client-facing runtime in this repository. Production
declares the single prefix route `airvio.co/agentic-commerce-os*`; the core and
sandbox Workers have no public routes, and core accepts application calls only through the
`commerce.edge-core/v1` Service Binding contract and the exact serving candidate
header.

Four authorities remain distinct:

- public reads expose only sanitized storefront, liveness, public-agent, and
  merchant-catalog projections;
- the origin-bound `__Host-ag_session` cookie permits only `storefront:read` and
  `checkout:prepare` for 15 minutes;
- `MCP_BEARER_TOKEN` authorizes agent MCP and protected agent HTTP calls; and
- `OPERATOR_BEARER_TOKEN` authorizes the separate operator MCP and operator HTTP
  surface. Mutations additionally carry the current authoring claim and fence.

Core has a separate outbound service credential:
`DISCOVERY_PROVIDER_BEARER_TOKEN` authenticates only the private `DOCS_MCP`
binding. It is required before any initialize, initialized notification,
tools/list, tools/call, or session DELETE request and is never accepted as edge,
shopper, agent, operator, receipt, or mutation authority.

All three bearer secrets must be mutually distinct and at least 32 characters
in Production. `STOREFRONT_SESSION_SECRET` must also be at least 32 characters
and signs only the first-party session and its short-lived checkout challenge.
Core separately requires `AGENTIC_OS_ADMISSION_AUTH_SECRET`,
`CHECKOUT_PROVIDER_AUTH_SECRET`, and `MARKETPLACE_PROVIDER_AUTH_SECRET` for the
three HMAC-bound private-provider contracts. Generate distinct values with a
cryptographically secure secret generator and install them as Worker secrets;
never commit or log their values. Allowed browser origins are an exact scheme,
host, and port list.

Staging and Production also require the public
`HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON` variable. It names one issuer and one
Ed25519 SPKI public key under
`agentic-graph-human-presence-trust-anchor/v1`. The key is not a secret, but an
invalid, absent, or placeholder anchor makes the operational edge and readiness
fail closed. The same-origin browser adapter `globalThis.agenticGraphHumanPresence.authorize`
must return a fresh `agentic-graph-human-presence-receipt/v2` signed by that
issuer. The signed assertion binds the stable
`agentic-graph-commerce-checkout` audience and exact HTTPS relying-party origin
in addition to the checkout facts; the repository never holds the issuer's
private key.

## MCP endpoints and the one token authority

`POST /mcp` and `POST /mcp/operator` implement stateless Streamable HTTP with
JSON responses. The first requires the agent bearer; the second requires the
operator bearer. Operator mutation tools forward
`x-authoring-semantic-scope`, `x-authoring-claim-id`,
`x-authoring-lease-epoch`, and `x-authoring-fence-revision` to the core. Core
admission additionally binds each requested mutation to its exact required
write target; matching only the broader declared write set is insufficient.
After read-only preparation, core reserves the exact epoch immediately before
the first mutation. Permit v2 binds a stable operation identifier, canonical
request digest, and monotonic per-scope mutation sequence. The coordinator
resumes only that exact operation; a different operation receives
`mutation_reconciliation_required`, and lease expiry never deletes or reopens
an unresolved reservation. Its status RPC reports `reconciliation_required`
until the exact terminal result is completed. Durable Object targets persist
the sequence high-water mark and a terminal outcome journal in the same
transaction as the business write. Any exact permit-and-digest retry receives
its immutable cached terminal outcome, including an A/B/A replay after B has
advanced the high-water mark. Requests without an exact stored outcome remain
subject to high-water staleness, and a reused mutation identifier with different
permit or digest bytes is rejected. Fenced provider requests must echo every
permit field. Unknown or unconfirmed provider outcomes remain held for explicit
reconciliation because those providers expose no atomic terminal journal or
cancellation proof.

Every tool first resolves the existing `/tool.route` command through the pinned
upstream Invocation Catalog. `config/capability-token-map.json` is a projection,
not another dictionary: every action reuses only `/tool.route`, `#mcp`, and
`@mcp-gateway`. It records the MCP tool and any equivalent HTTP route so an
action cannot quietly become HTTP-only.

Agent tools:

| Tool | Effect |
|---|---|
| `commerce.runtime.status` | Read split source/live readiness |
| `commerce.invocation.resolve` | Resolve pinned `/`, `#`, and `@` entries |
| `commerce.registry.list` | Read the authority-bearing registry |
| `commerce.catalog.public.list` | Read the allowlisted public projection |
| `commerce.catalog.merchant.read` | Read one merchant-scoped catalog |
| `commerce.intent.route` | Select and dispatch at most one eligible agent, then at most one fallback |
| `commerce.checkout.prepare` | Validate routing evidence and obtain a short-lived confirmation challenge |
| `commerce.checkout.confirm` | Return `human_confirmation_required`; backend MCP never forwards settlement |
| `commerce.revenue.period.read` | Read ordered derived-markup lines and a recomputed total |
| `commerce.vendor.list` | Read the upstream vendor projection |
| `commerce.settlement.get` | Read one upstream settlement/split projection |

Operator tools:

| Tool | Effect |
|---|---|
| `commerce.agent.register` | Store an exact ACOS-admitted registration |
| `commerce.agent.deregister` | CAS-bound deregistration |
| `commerce.registry.events` | Read ordered registry evidence |
| `commerce.vendor.transition` | Forward an authority-checked lifecycle decision |
| `commerce.theme.deploy` | Validate and activate one merchant theme |
| `commerce.release.boundary.read` | Read boundaries without advancing them |
| `commerce.authoring.claim.acquire` | Acquire one bounded semantic-scope claim |
| `commerce.authoring.claim.release` | Release the exact claim and epoch |
| `commerce.authoring.claim.admit` | Verify claim, lease, scope, and fence without mutation |

`commerce.checkout.confirm` remains discoverable through authenticated backend
MCP but always returns `human_confirmation_required`. Direct backend MCP and
agent HTTP calls never forward settlement. A storefront session alone and the
WebMCP surface cannot call confirm or supply a substitute for visual human
confirmation.

## HTTP edge

The table uses paths after edge prefix normalization. In Production every path
is reached under `/agentic-commerce-os`; direct Worker and Dev requests use the
same paths without that prefix.

| Method and path | Authority | Effect |
|---|---|---|
| `GET /` | public | Default mobile-first Storefront Console |
| `GET /s/{merchantId}` | public | The same console with an activated merchant theme |
| `GET /assets/storefront.js` | public | First-party client module |
| `GET /livez` | public | Lane, candidate, and version metadata |
| `GET /readyz` | public | Fail-closed dependency, source, and live-release report |
| `POST /v1/session` | same-origin public request | Issue the bounded first-party shopper session |
| `GET /v1/public/agents` | public | Sanitized active-agent projection |
| `GET /v1/public/merchants/{merchantId}/catalog` | public | Theme-scoped merchant listings |
| `GET /v1/registry` | agent | Authority-bearing registry snapshot |
| `POST /v1/intents/route` | shopper session or agent | Deterministic selection and bounded dispatch |
| `POST /v1/checkouts/{id}/prepare` | shopper session or agent | Guardrail preparation only |
| `POST /v1/checkouts/{id}/confirm` | agent only | Return `human_confirmation_required`; never forward settlement |
| `POST /v1/human/checkouts/{id}/confirm` | same-origin session + CSRF + one-use proof + externally signed user-presence receipt | Validate the exact visual facts and then forward settlement |
| `GET /v1/revenue` | agent | Ordered derived-markup period read |
| `GET /v1/vendors` | agent | Upstream vendor projection |
| `GET /v1/settlements/{splitId}` | agent | Upstream settlement projection |
| `POST /v1/operator/agents` | operator + claim | ACOS-admitted registration |
| `DELETE /v1/operator/agents/{agentId}` | operator + claim | CAS-bound deregistration |
| `GET /v1/operator/registry/events` | operator | Ordered registration evidence |
| `POST /v1/operator/vendors/{vendorId}/transition` | operator + claim | Vendor transition |
| `POST /v1/operator/merchants/{merchantId}/theme` | operator + claim | Theme activation |
| `POST /v1/operator/claims/{acquire,release,admit}` | operator | Claim lifecycle or admission check |
| `GET /v1/operator/release-boundaries` | operator | Read-only boundary projection |

JSON responses are `no-store`, carry a request identifier and content-sniffing
protection, and expose no secret. The console uses only the same
`StorefrontActions` functions that the three page WebMCP tools use: catalog
search, offer selection, and checkout initiation. Browsers without a
model-context registration API retain the complete visual surface without a
shopper-facing registration error.

The configured Production route is exactly the
`https://airvio.co/agentic-commerce-os*` prefix. Prefix normalization accepts
the base path or a slash-delimited child and rejects lookalikes such as
`/agentic-commerce-os-extra`. The authenticated controller proves the base
Storefront Console plus representative asset, catalog, session, checkout, and
MCP boundaries through that public route. Successful proof binds the candidate
and active edge/core version identifiers and requires no-store responses.
`GET /readyz` remains a fail-closed source/live diagnostic; its result alone is
never reused as proof for the complete Production prefix.

## Registration, routing, and public projection

Registration forwards the authoritative `agentDefinition`,
`toolAllowlistEntry`, `invocationRegisterEntry`, and `operatorInstructionRef` to
`ACOS_ADMISSION`. The reference must equal
`operator://agentic-graph/commerce-adapter-admission/2026-09-03`; caller and
agent provenance remains in the complete digest-bound registration intent. The
local projection adds declared category, discovery tool,
selection attributes, and optional fallback. Stored rows bind the exact
admission receipt, content hash, and pinned invocation proof. Multiple active
agents may share a category; readiness requires at least one verified active
`flight` and one verified active `shopping` agent and zero stale invocation pin.

Selection is deterministic and model-free. Price, quality, and latency are
normalized under the externalized policy; equal scores resolve by ascending
agent identifier. The core persists the eligible set, selected agent, declared
attributes, and fallback before provider egress. The public projection includes
only agent identifier, declared category, declared capabilities, and declared
trust status. A merchant catalog is the intersection of that public projection
and the activated Theme Manifest scope.

## Checkout, offer observation, and derived revenue

An `IntentRoute` object seals request identity before calling the selected
discovery tool. An interrupted discovery result is not blindly replayed.
Checkout preparation requires the exact stored offer, its receipt digest and
provider revision, a still-active agent, and the same amount and currency.

`CheckoutSession` records guardrail evidence and a ten-minute confirmation
challenge. Its alarm observes held price, availability, and agent activity at
bounded intervals. A change or suspended observation invalidates prior
confirmation. The edge then mints a fresh challenge over the complete ordered
blocker-set digest, displays every old/new value and event type, and accepts only
a new signed presence receipt over that exact set. The receipt also binds the
shopper-principal digest, storefront-session nonce digest, checkout, offer,
integer minor-unit amount, ISO currency, expiry, and issuer. The
human-confirmed event is committed before settlement egress. Ambiguous egress
becomes `reconciliation_required` and only status readback with the original
idempotency key can settle it.

After settlement is recorded, the configured integer basis-point rate produces
a half-up markup line. `RevenueLedger` is an idempotent, append-only derived
ledger keyed by settlement identifier; it never changes the amount sent to the
payment owner. A ledger failure appends `markup_deferred` without reversing the
settlement. The `commerce.markup-outbox/v2` record pins the validated integer
`appliedRateBasisPoints` alongside the settlement inputs before any deferred
recovery. Finalization stays pending under a capped exponential alarm (at most
fifteen minutes between attempts), and recovery derives the line only from that
pinned rate, even after configuration changes. It retries only the derived
ledger append and never resubmits the provider charge. Legacy deferred records
without a pinned rate fail closed. This is capability evidence, not proof of
external paying demand.

Revenue period reads return at most 500 complete lines and their recomputed
total. The indexed SQL query reads at most 501 matching rows; an additional row
returns `revenue_period_capacity_exceeded` with `maximumLines: 500`, without
returning partial lines or a partial total. Stored settlements remain unchanged.
Callers may request a narrower period. More than 500 settlements sharing one
millisecond cannot be separated by this API's time bounds; that dense interval
requires a future cursor-based history API and remains explicitly unavailable.

## Theme, local-first, and isolation boundaries

Theme validation bounds the manifest to 64 KiB, its catalog scope to 500 agent
identifiers, and shopper copy to 280 characters per field. Activation occurs
only after all scoped agents are registered and external assets pass the bounded
fetch checks; otherwise the prior activation remains current. Default and
merchant deployments use the same Storefront Console implementation.

The client keeps the last completed snapshot and up to 500 ordered local changes
in IndexedDB. Offline mode disables checkout settlement and replay retains each
change until acknowledgement. Core merge is a deterministic per-field merge
with an append-only event log. `AuthoringClaim` separately enforces one active
writer per semantic scope and rejects stale leases and fences. A point-in-time
admission is not mutation authority: every stateful target receives a reserved
permit and atomically advances its local epoch high-water mark with the write.

The Sandbox Executor is a separate private Worker using the exact-pinned
Cloudflare Sandbox SDK. It accepts only `theme-build`, `registration-dry-run`, or
`unshipped-surface-build` purposes, applies an explicit request wall-clock bound
and the configured 256 MiB container ceiling, records attempted calls, refuses
calls outside the declared allowlist, and terminates the instance. The
repository-owned unshipped-surface harness byte-binds the exact shipped WebMCP
runtime and strictly validates its drift-refusal result. Production includes its
Worker version and container application/version in the authenticated release
tuple, but the Sandbox Worker still has no public route or independent release
authority.

## Upstream convergence and ownership

The core accepts a provider only when every declared required check is present
and passing and the exact source, receipt, storage, and provider identities
match. Named surplus checks do not block, and a compatible higher minor PRD
revision is reported as convergence with surplus. Missing, failing, unnamed, or
incompatible evidence remains blocking.

The source-readiness verdict is not reused as an operational permit. Immediately
before discovery and every checkout or marketplace operation that can move or
reconcile value, the core re-fetches the bounded evidence envelope. Provider
requests bind all four pinned identities, the declared required-check-set digest,
and the exact method, URL, semantic headers, and body digest. Discovery,
checkout, and marketplace responses must echo that complete binding; absence
or drift fails closed before the response can mutate local state. Discovery
uses its own `DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON` and
`commerce.discovery-provider/v1` contract on the actual `DOCS_MCP` binding;
checkout evidence cannot authorize that different service. The discovery
credential is attached to every MCP lifecycle request but deliberately excluded
from the operational request digest, response binding, logs, and receipts.

`CHECKOUT_PROVIDER` remains the authoritative guardrail, issuance, settlement,
and reconciliation owner. `MARKETPLACE_PROVIDER` remains the authoritative
vendor, split, payout, and audit owner. This repository owns only the receipt-
bound coordination state and the derived markup projection; it does not create
a second money ledger, vendor database, payout path, or token dictionary.
