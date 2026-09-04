# Production runtime contract

## Readiness result

This repository is a fail-closed production candidate, not a currently verified
Production runtime. It implements a private commerce ingress and coordination
layer for the committed v0.3.0 baseline of
`agentic-graph-commerce-platform-prd-tad-adr.md`; it does not relocate the
authoritative graph, payment, or settlement runtime from its owning repository.
Production readiness requires the source, administration, dependency, consumer,
deployment, live-probe, and externally authorized rollback evidence listed below.

### Authenticated Production release controller

The manual Production workflow separates credentialless verification from the
protected mutation job. Both jobs are bound to one exact protected-main
candidate. The mutation job additionally requires a first-attempt-only,
run-bound GitHub approval by one non-bot `User`; the `production` environment
must expose a required-reviewer rule with `prevent_self_review: true`. The
controller records the approval observation as `observedAt`; it does not invent
an approval timestamp that GitHub's workflow-run approvals API does not return.
It rechecks clean remote `main` after approval at the final pre-mutation
boundary.

The verification job runs the locked implementation checks, validates the
static Production topology, and builds minified sandbox, core, and edge bundles
with fixed Wrangler `--dry-run` arguments. Every emitted JavaScript chunk must
be below 500,000 bytes. That job receives no Cloudflare credential. Only the
environment-protected release job receives the exact account, provider,
admission, Worker-secret, provider-evidence, and route-authority inputs needed
by the controller.

The controller supports `bootstrap`, `steady-state`, and authenticated
`recovery`. Bootstrap requires all three Worker baselines and the sandbox
container application to be absent. Steady state requires a separately
authenticated prior deployment receipt whose exact versions and container are
still active. Recovery requires a separately authenticated preserve-required
receipt and accepts only its predecessor-or-candidate state. Core and edge are
uploaded inactive and fully read back before activation. The sandbox Worker and
container transition is immediate and non-transactional, so the controller
records that boundary explicitly, rechecks the active three-Worker tuple before
each later activation, and returns a typed preserve-required artifact for every
ambiguous or partial transition. It never describes a forward-only recovery as
rollback.

Source support does not authorize a live release by itself. A run still needs
protected GitHub authority, operator-owned secrets and provider evidence, an
exact route-authority artifact, and a currently valid predecessor or recovery
artifact when the selected mode requires one. Without them the controller
fails before mutation; this repository does not manufacture those inputs.

Dev is an entirely local four-Worker topology: the edge, core, bounded sandbox,
and `agentic-commerce-provider-dev` demo fixture run in one Wrangler session.
The fixture supplies deterministic MCP, checkout, and marketplace contracts
with a deliberately small `1/1/1` invocation catalogue. It is demo-only,
requires no remote Cloudflare resource, and is not evidence that any Staging or
Production provider is present or ready.

The implementation is bound to the committed PRD at source repository revision
`1acbbcc3b06534f9712f5b05b781010f749fa842`. Uncommitted later edits and the
in-flight product rename are not release inputs. New repository-owned contracts
use `commerce.*`. Exact existing external Worker and MCP names remain only where
the owning service currently requires them; this repository does not add aliases
or downstream remapping for either product name.

## Ownership boundary

| Owner | Runtime responsibility |
|---|---|
| Agentic Canvas OS | Authoritative agent definition/admission receipts plus canonical invocation grammar, catalogue, and routing document revisions for `/`, `@`, and `#` tokens |
| `agentic-graph` | Projection of that invocation catalogue through MCP; authoritative graph, Guardrail Gate, human-confirmed issuance, vendor D1, bundle commit, money ledger, same-transaction vendor split, settlement verification, and payout dispatch |
| Commerce core | Registration, deterministic selection and dispatch fences, invocation-pin verification, checkout/offer observation, derived markup, theme activation, and authoring claims |
| Commerce edge | Public Storefront Console and catalog plus session-, agent-, and operator-authorized facades over the private core |
| Release workflow | Protected exact-candidate verifier and authenticated bootstrap, steady-state, or forward-recovery controller; it emits typed deployment or preserve-required evidence |
| Sandbox Executor | Private bounded container-backed Worker included in the three-Worker release tuple; it has no public route or independent release authority |

The core runs six SQLite-backed Durable Object classes:

- `AgentRegistry` requires at least one verified active `flight` agent and one
  verified active `shopping` agent before source readiness passes. Multiple
  agents may share a category; their definition, allowlist, content hash,
  selection attributes, and invocation proof remain receipt-bound.
- `IntentRoute` persists one routing/dispatch decision and idempotency key per
  intent before calling the deterministically selected discovery MCP tool. It
  permits at most one declared fallback and does not automatically replay an
  unknown result.
- `CheckoutSession` persists the upstream guardrail evidence and a one-use
  confirmation challenge, observes held-offer changes on an alarm, invalidates
  stale confirmation, and records an externally signed exact-fact
  human-presence receipt before asking the owning
  `agentic-graph` service to execute. It is not the issuer or money authority.
- `RevenueLedger` idempotently records the integer, half-up markup derived after
  a settlement. Its v2 deferred outbox pins the validated applied rate before
  recovery, so later configuration changes cannot reprice a settled transaction.
  It is a platform projection, never a second authoritative money ledger, and
  an append failure does not reverse settlement.
- `ThemeDeployment` stores one current validated manifest per merchant only
  after scope and asset checks succeed; a failed build preserves the prior
  activation.
- `AuthoringClaim` holds one lease- and fence-bound writer per semantic scope and
  refuses stale, overlapping, expired, or mutation-reserved authority. Every
  operator path rechecks after slow preparation; target Durable Objects commit
  their epoch/sequence high-water mark and terminal outcome journal atomically
  with the mutation. Exact retries resume the stable operation, older
  same-lease replays are stale, and providers must validate and echo the full
  permit. Expiry never clears an unresolved provider outcome; it remains
  `reconciliation_required` until exact terminal evidence is available.

The deployed core proxies vendor and settlement runtime operations to
`agentic-graph`. This repository deliberately contains no authoritative vendor
lifecycle store, payment mutation, split projection, payout path, second vendor
database, or parallel money ledger.

This repository declares no D1 database, KV namespace, R2 bucket, or Queue. Its
core state is the six Durable Objects above. The separate Sandbox Executor
declares one bounded container-backed Sandbox class. In Production it is a
private Service Binding and a separately proven member of the release tuple;
it has no public route. `agentic-graph` remains the sole owner of vendor D1,
authoritative bundle and money-ledger writes, same-transaction split persistence,
and payout coordination.

## Private Cloudflare topology

Production deploys three Workers in one Cloudflare account:

1. `agentic-commerce-sandbox-production` has `workers.dev` and preview URLs
   disabled. It owns one bounded container-backed Sandbox Durable Object and is
   reachable only through the core Service Binding.
2. `agentic-commerce-core-production` has `workers.dev` and preview URLs
   disabled. It is reachable only through Service Bindings and binds the six
   Durable Objects plus the authoritative ACOS admission, external MCP,
   commerce, marketplace, and sandbox services.
3. `agentic-commerce-edge-production` also has `workers.dev` and preview URLs
   disabled and binds the core by service name. Its configuration declares
   exactly one prefix route, `airvio.co/agentic-commerce-os*`. The edge strips
   only that exact prefix before routing the Storefront Console, scoped assets,
   catalog, session, checkout, MCP, WebMCP, liveness, and readiness paths. It
   rejects lookalike prefixes and does not expose either private Worker directly.
   Serving the prefix is not yet live-verified, so the Delivery boundary remains
   closed.

A Cloudflare Service Binding selects a service, not an immutable Worker version.
Both direct readiness contracts therefore return their sanitized
`CF_VERSION_METADATA`. Source-ready core state may remain 503 solely because
route-live state is unknown. The exact Production HTML request accepts only that
typed condition, obtains a matching core liveness identity through the Service
Binding, and emits no-store readiness/candidate/edge-version/core-version
headers. The release controller requires those IDs and tags to equal the sole
100-percent Cloudflare deployments and exact candidate. These checks
detect drift or a misrouted consumer; Cloudflare account policy must still
prevent deployment outside this controller.

The Production config contains deliberately invalid release placeholders. The
release workflow must inject the same lowercase 40-hex
`RELEASE_CANDIDATE_SHA` and candidate digest into all three Workers. A direct
Production deploy that omits either override cannot pass readiness.

## Invocation reuse

The runtime does not maintain a second Production invocation dictionary. In
Staging and Production, the core hydrates the complete Agentic Canvas OS
document projection from the current `agentic-graph` MCP service, verifies the
configured source revision, catalogue digest, routing schema, routing digest,
and full `142/142/136` command/semantic/binding counts, then resolves the
required `/tool.route`, `#mcp`, and `@mcp-gateway` tokens. The local Dev provider
implements the same transport and token contracts with its `1/1/1` fixture.
Registration and readiness fail when the pins for the active lane, a required
token, or a registered discovery tool differ from that lane's provider.

`config/capability-token-map.json` projects every local capability action onto
that same three-token tuple and its MCP tool. It is not a second registry and
defines no alias. Agent actions are served at `/mcp`; operator actions are served
at `/mcp/operator` under the separate operator bearer and current authoring
claim. Authenticated backend MCP retains `commerce.checkout.confirm`, but that
tool and direct agent HTTP confirmation return `human_confirmation_required`
without forwarding settlement. Only the same-origin visual
`/v1/human/checkouts/{id}/confirm` route validates its session, CSRF value,
one-use challenge, and provider-neutral Ed25519 presence receipt before
forwarding settlement. The receipt binds the shopper principal, session nonce,
checkout, amount, currency, exact HTTPS relying-party origin, stable checkout
audience, and complete changed-offer blocker set. Shopper-session and WebMCP
tools remain limited to reads and checkout preparation.

This preserves one invocation source of truth while allowing another repository
to host the commerce runtime. The current external MCP tool and path remain
provider-owned contracts; a future owning-repository rename must update the
provider and the pinned consumer together, with a new receipt.

## Release controller

Repository `deploy:production:*` package entrypoints remain credentialless local
guards; they cannot bypass the protected workflow. Production mutation is owned
by `scripts/production-release/run-production-release.ts`, invoked only from the
environment-protected job after immutable source, bundle, human-authorization,
operator-pin, prior-artifact, and route-authority checks.

The controller uploads core and edge as inactive versions, validates their exact
configuration and secret-name surfaces, deploys and proves the immediate
sandbox/container transition, then performs active-tuple compare-and-swap checks
before activating core and edge in order. Bootstrap alone may create the exact
prefix route; steady state requires the same route identity. A successful run
must read back all three version proofs, the container rollout, the exact route,
and the public prefix boundaries before it can construct a deployment receipt.
Any failure after possible mutation constructs a bounded preserve-required
receipt and leaves state for an explicitly authenticated forward recovery.

`.github/workflows/ci.yml` installs the committed lockfile, checks the external
evidence contract, and runs the bounded source-and-bundle checks for pull
requests and merge-queue candidates. Repository rules must require its
`Integration Gate` check and forbid direct pushes to `main`. Terminal task
verdict evaluation remains separate and fail-closed: no current verdict set is
checked in. The portable task snapshot now maps task-level evidence-contract
and implementation closure to their non-recursive checks, closing the prior
aggregate self-reference without skipping or synthesizing external evidence.

The workflow has two dispatch inputs: `mode` and the exact lowercase 40-hex
candidate at protected `main`. Prior or recovery authority is read from protected
environment variables, and mutation credentials are read only from protected
environment secrets. Workflow inputs cannot carry either. Dry-run bundle proofs
remain local evidence; the controller separately reads back remote versions,
container state, and route behavior.

`docs/do-storage-compatibility.json` binds the Wrangler migration/class
contract, complete Durable Object persistence sources, reviewed dependencies,
and normalized DDL. That manifest is implementation evidence, not rollback
authority. The controller binds the current manifest revision into its candidate
identity and exact remote version proofs; a future incompatible storage change
must still fail closed before release.

The direct-Worker `/readyz` handler remains a non-mutating diagnostic for source
and provider convergence. The public prefix is
`https://airvio.co/agentic-commerce-os`; only an authenticated protected run may
use its typed responses and headers as post-deployment proof.

## Rollback contract

No rollback command exists in the active workflow or package entrypoints.
Retaining prior version IDs is not rollback authority: Durable Object storage,
external transactions, mixed core/edge intervals, container rollouts, and late
concurrent writes make a blind reversal unsafe. Unknown or partial state emits a
preserve-required artifact; the supported recovery path moves forward only after
that artifact is independently authenticated and the observed state is still
one of its exact predecessor-or-candidate tuples.

## Required external configuration

GitHub administrators must:

1. protect `main`, require pull requests and `Integration Gate`, and prevent
   direct or bypass pushes outside the repository-owned lifecycle;
2. create the `production` environment, restrict it to protected `main`, and add
   `prevent_self_review: true` plus at least one direct configured `User`
   reviewer. The approving user ID must equal a configured reviewer ID; team-only
   authorization is unsupported until membership is independently proved; and
3. configure Cloudflare credentials, runtime secrets, provider pins, route
   authority, and prior/recovery artifacts only on the protected environment.
   They must remain unavailable to pull requests and the credentialless verify
   job, and must never be accepted as workflow-dispatch inputs.

Cloudflare operators must:

1. provision the sandbox, core, and edge services in the intended account,
   authorize the reviewed Sandbox and six-class core Durable Object migration
   chains, keep sandbox and core private, and bind them only through the declared
   Service Bindings;
2. configure distinct, non-placeholder `MCP_BEARER_TOKEN`,
   `OPERATOR_BEARER_TOKEN`, and `STOREFRONT_SESSION_SECRET` secrets on the edge
   Worker. Generate each with a cryptographically secure secret generator; do
   not record a value in repository files or workflow inputs;
3. configure distinct `DISCOVERY_PROVIDER_BEARER_TOKEN`,
   `AGENTIC_OS_ADMISSION_AUTH_SECRET`, `CHECKOUT_PROVIDER_AUTH_SECRET`, and
   `MARKETPLACE_PROVIDER_AUTH_SECRET` values on the core Worker. The discovery
   token must match the `agentic-graph` MCP runtime's corresponding bearer;
   none may enter repository files, workflow inputs, operational evidence
   digests, or receipts;
4. provision and restrict the ACOS admission, external MCP, commerce, and
   marketplace service bindings expected by the core, replace all invalid
   Production evidence placeholders with reviewed immutable ACOS/provider pins,
   and install the reviewed human-presence trust anchor only in the edge runtime;
5. reserve the declared `https://airvio.co/agentic-commerce-os*` prefix for the
   protected controller and its typed post-deployment proof; and
6. prohibit out-of-controller changes to all three commerce Workers and the
   route, and retain authenticated predecessor and preserve artifacts.

`agentic-graph` operators must provide the live provider contracts the core calls:

- the Agentic Canvas OS document-projection MCP and invocation tool;
- readiness for the commerce and marketplace services;
- checkout prepare, confirm, and idempotency-key status endpoints with exact
  discovery, guardrail, and settlement receipts that preserve
  guardrail-before-confirmation-before-issuance ordering;
- vendor list and authenticated lifecycle transition endpoints; and
- settlement readback backed by the single authoritative ledger and
  same-transaction split projection; and
- immutable runtime-evidence receipts proving the complete checkout and
  marketplace required check sets for the bound provider versions; additional
  named passing checks may be present.

Agentic Canvas OS operators must expose the private admission endpoint used by
`ACOS_ADMISSION`, returning an exact active `agentic-os-adapter-registration/v2`
receipt for the four authoritative registration inputs.

## Exact remaining blockers

The current lane cannot truthfully claim Production delivery because:

- the terminal evidence gate still lacks all 100 independently issued verdicts,
  so source integration does not imply runtime or Production readiness;
- no external evaluator currently supplies the pinned dispatch trust anchor,
  isolated check executor, signed performer artifacts, or attested exclusive
  stable artifact sink required before an evidence command may launch
  candidate-controlled code;
- the production Merge Agent is fail-closed with all subprocess observation,
  candidate check execution, and automatic mutation disabled until an external
  default-deny runner can protect operator authority and host files;
- this implementation is not yet integrated into protected `main`, and no
  current repository receipt proves the required ruleset or Production
  environment reviewer configuration;
- no current committed receipt proves that the commerce Production Workers,
  configured providers, or declared delivery path exist and match this exact
  candidate;
- no authenticated bootstrap receipt proves an active sandbox/core/edge tuple,
  container rollout, exact remote migration identity, or prefix route;
- the three edge Worker secrets, four core authentication secrets, reviewed ACOS
  and provider pins, Production Durable Object migrations, and exact HTTPS
  prefix proof are not applied or verified;
- the operator-owned x402 payee and the owning `agentic-graph` money-path
  deployment evidence are not observed;
- a new registry is empty, while readiness requires at least one verified active
  `flight` agent and one verified active `shopping` agent with live MCP discovery
  tools;
- the `agentic-canvas-os` and `agentic-graph` source candidates expose the private
  admission, checkout, status, vendor, and settlement evidence contracts, but
  reviewed immutable provider revisions, deployed evidence pins, and matching
  delivery VCC receipts remain absent; and
- no authorized external transition has sealed the exact candidate, remote
  Worker identities, storage compatibility, live versions, and route response.

Until all conditions close, the source candidate can be production-release
capable while the correct Delivery status remains **blocked / fail-closed**, not
deployed. The public surface and authenticated controller exist in source and
configuration; serving them on the declared Cloudflare prefix remains unproved.
The delivered rung remains undocumented until the owning `agentic-graph` money
path and this control plane both have separate protected deployment and
live-readback receipts.
