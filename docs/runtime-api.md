# Runtime API and ownership contract

## Boundaries

The edge Worker is the only client-facing component in this repository. Its
Production configuration has no public route: an authorized consumer Worker must
bind or proxy it. The core Worker has no public route in any environment and
accepts application calls only through the `commerce.edge-core/v1` internal
contract header and exact release-candidate header.

Two bearer authorities are intentionally separate:

- `MCP_BEARER_TOKEN` authorizes MCP and non-operator HTTP calls.
- `OPERATOR_BEARER_TOKEN` authorizes agent registration, deregistration, registry
  event reads, and vendor lifecycle transitions.

Both must be distinct. Production rejects either value below 32 characters.
Allowed browser origins are an exact origin list including scheme and port; responses include an exact
origin CORS header only after that check passes. Request and dependency response
bodies are streamed under explicit byte bounds.

## MCP endpoint

`POST /mcp` implements stateless Streamable HTTP using MCP protocol
`2025-06-18`. Every request requires `Authorization: Bearer <MCP_BEARER_TOKEN>`.
The transport accepts bounded JSON objects and returns JSON rather than holding
an SSE stream.

| Tool | Mutation | Contract |
|---|---:|---|
| `commerce.runtime.status` | no | Exact edge/core readiness report |
| `commerce.invocation.resolve` | no | Resolve exact `/`, `#`, and `@` tokens through the pinned canonical projection |
| `commerce.registry.list` | no | Revision- and digest-bound active/inactive agent snapshot |
| `commerce.intent.route` | discovery call | Persist one routing decision, then call at most one registered tool |
| `commerce.checkout.prepare` | guardrail only | Require completed routing evidence, evaluate guardrails, and return a short-lived confirmation token |
| `commerce.checkout.confirm` | yes | Persist human confirmation before one settlement-provider call |
| `commerce.vendor.list` | no | Read the marketplace-owner vendor projection |
| `commerce.settlement.get` | no | Read one stored settlement/split projection |

Agent and vendor administration are deliberately absent from MCP. They remain
operator-authorized HTTP operations so tool discovery cannot be mistaken for
mutation authority.

## HTTP edge

| Method and path | Authority | Effect |
|---|---|---|
| `GET /livez` | none | Process liveness and version metadata |
| `GET /readyz` | none | Fail-closed dependency and candidate report |
| `GET /v1/registry` | MCP | Registry snapshot |
| `POST /v1/intents/route` | MCP | Exclusive, idempotent intent dispatch |
| `POST /v1/checkouts/{id}/prepare` | MCP | Guardrail evaluation after exact routing evidence |
| `POST /v1/checkouts/{id}/confirm` | MCP | One-time human-confirmed settlement request |
| `GET /v1/checkouts/{id}` | MCP | Checkout state and ordered evidence events |
| `GET /v1/vendors` | MCP | Vendor-owner projection |
| `GET /v1/settlements/{splitId}` | MCP | Settlement-owner projection |
| `POST /v1/operator/agents` | operator | Request authoritative ACOS admission and store its receipt |
| `DELETE /v1/operator/agents/{agentId}` | operator | CAS-bound deregistration |
| `GET /v1/operator/registry/events` | operator | Ordered registration audit events |
| `POST /v1/operator/vendors/{vendorId}/transition` | operator | Forward an explicit lifecycle decision |

Every JSON response has `cache-control: no-store`, a request ID, content sniffing
protection, and a default-deny content security policy where applicable.

## Agent registration

Registration accepts the authoritative ACOS inputs `agentDefinition`,
`toolAllowlistEntry`, `invocationRegisterEntry`, and
`operatorInstructionRef`, plus a local `commerceProjection` containing only
`category` and `discoveryTool`, and `expectedPreviousContentHash`. The core
forwards exactly those four authoritative inputs over the private
`ACOS_ADMISSION` Service Binding. It does not maintain another Agent Definition
schema or validation policy.

An active local record is created only when the provider returns a successful
wrapper containing an exact `acos-adapter-registration/v1` record. The receipt
must bind the Agent Definition id, allowlist entry and adapter identity, ordered
Invocation Register tokens, active result, operator instruction reference, and
registration time to the forwarded inputs. The projected discovery tool must
also be present in the admitted allowlist entry.

Before admission, the core resolves the configured `/tool.route`, `#mcp`, and
`@mcp-gateway` tuple through the pinned catalog. It stores that invocation proof
with the four inputs, exact receipt, local commerce projection, SHA-256 input
digest, and a SHA-256 digest over inputs + receipt + invocation proof +
projection.
Every read recomputes both digests; only a verified active record is routable or
checkout-eligible. The record and event commit in one SQLite transaction, with
compare-and-swap replacement and exactly one active owner per local category.
Readiness requires a valid ACOS admission capability probe, exactly one verified
active `flight` and `shopping` admission, and every active row to match the
current catalog revision, catalog/routing digests, counts, and required tuple.

## Routing and checkout ordering

One `IntentRoute` Durable Object is keyed by `intentId`. It stores the request
digest and selected agent before calling the discovery MCP tool. The tool must
return an exact `commerce.discovery-receipt/v1` envelope. Every offer is bound to
the intent and its digest, admitted agent, offer id, amount, currency, pinned
provider revision, and its own recomputed digest. Arbitrary tool output and
duplicate offers fail closed. Replaying the same intent returns the stored
receipt; changing a reused `intentId` is rejected. An interrupted provider call
becomes an unknown result and is never automatically reissued.
Known payment-credential fields are rejected before discovery egress, and
checkout accepts only its exact field set, so caller-supplied credential material
cannot be propagated to either provider.

Checkout preparation requires one exact stored offer for the same `intentId`,
`agentId`, `offerId`, amount, currency, receipt digest, and pinned provider
revision, plus a still-active registry row. One `CheckoutSession` object is
keyed by `checkoutId` and persists:

1. the bounded request and routing identity;
2. an exact digest-bound upstream guardrail-pass receipt;
3. a ten-minute human-confirmation token and digest;
4. the human-confirm event before provider egress; and
5. an exact settlement receipt bound to the guardrail receipt, human-confirmation
   digest, provider revision, and stable idempotency key.

Prepare and confirm use stable provider idempotency keys. Once confirm egress has
started, a timeout, non-success response, or malformed receipt becomes
`reconciliation_required`, never `failed`. Repeating the same confirmation does
not issue another settlement POST: it performs the provider's status GET with
the stored idempotency key and advances only on the same exact settlement
receipt. The upstream service remains the sole money and reconciliation owner.

## Canonical invocation reuse

The invocation client owns no copied command dictionary. It initializes the
existing docs MCP endpoint, hydrates all three sigils, recomputes canonical
catalog and routing SHA-256 digests, verifies exact counts and revision-bound
source URLs, and then rechecks every requested token against the same proof.
Metadata drift between any response fails closed.

The current Staging/Production pinned proof is declared in each non-inheritable
Wrangler environment:

| Field | Value |
|---|---|
| Source revision | `415e914da9e757387b992a5b03d89ac8855cb310` |
| Catalog digest | `2aa96c1240edb86579588408606af170abad243995cdd3b5ca77b91635c5f25b` |
| Routing schema | `agentic-canvas-os-docs-routing/v1` |
| Routing digest | `cba48df57e4e825b2111fee720d81382714baec8e45e0e270f6e496e61a703b3` |
| Counts | command 142, semantic 142, binding 136 |
| Required tuple | `/tool.route`, `#mcp`, `@mcp-gateway` |

Local Dev uses a demo-only 1/1/1 catalog containing only that required tuple.
It is a deterministic fixture, carries an all-`a` non-release source revision,
and is never accepted by the Production pins or release-candidate check.

Upstream renaming must advance the service target and this proof through a
reviewed release. No downstream alias map or compatibility shim is created.

## Upstream provider contracts

The logical bindings keep money and graph authority outside this repository:

- `CHECKOUT_PROVIDER` must expose `commerce.checkout-provider/v1`, advertise
  `prepare`, `confirm`, and `status`, and own guardrail, issuance, settlement,
  and idempotency-key readback effects.
- `MARKETPLACE_PROVIDER` must expose `commerce.marketplace-provider/v1`,
  advertise `vendor-list`, `vendor-transition`, and `settlement-read`, and own
  vendor D1, split persistence, payout dispatch, and audit reconstruction.

The core probes capabilities without mutating state. Each provider must also
return an exact `commerce.upstream-runtime-evidence/v1` record matching the
configured source revision, receipt digest, storage-compatibility revision,
provider version, PRD `0.3.0`, and the complete required VCC check set. Every
operational provider response must carry its exact expected contract; mismatches
fail closed and do not fall back. This repository contains no commission,
vendor-lifecycle, split-projection, money-ledger, or payout implementation; only
the upstream owner may commit a bundle and all split rows in one authoritative
transaction.
