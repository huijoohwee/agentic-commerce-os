# Production runtime contract

## Readiness result

This repository is a fail-closed production candidate, not a currently verified
Production runtime. It implements a private commerce ingress and coordination
layer for the committed v0.3.0 baseline of
`agentic-graph-commerce-platform-prd-tad-adr.md`; it does not relocate the
authoritative graph, payment, or settlement runtime from its owning repository.
Production readiness requires the source, administration, dependency, consumer,
deployment, live-probe, and externally authorized rollback evidence listed below.

### Production release safety stop

The manual Production workflow is intentionally read-only after the protected
environment gate. Both modes require a first-attempt-only, run-bound GitHub
approval by a non-bot `User`; the `production` environment must expose a
required-reviewer rule with `prevent_self_review: true`. The controller records
its observation time as `observedAt`; it does not invent an approval timestamp
that GitHub's workflow-run approvals API does not return. The candidate is
rechecked against clean `origin/main` after approval at the final pre-mutation
boundary.

The first job checks out the exact protected-main candidate, runs the locked
implementation checks, validates the static Production topology, and requires a
clean checkout. After the protected-environment approval, the gated job builds
minified core and edge bundles with fixed Wrangler `--dry-run` arguments, proves
every emitted JavaScript chunk is below 500,000 bytes, rechecks the exact remote
`main`, and stops. It does not receive or inspect a Cloudflare account, zone,
Worker version, route, bootstrap receipt, secret, or mutation credential. Its
bundle proofs are local build evidence only.

No Cloudflare mutation is currently authorized. Cloudflare has no atomic CAS
that covers the core and edge Worker transitions, and this repository has
neither a controller-issued external `controller-issued-lease-fence-cas/v1`
adapter nor a reviewed N/N-1 core/edge compatibility proof. Cloudflare's
available readback also does not prove the exact remote Durable Object migration
identity. When the preceding checks and approval succeed, the final step emits
`agentic-commerce-production-release-authority-refusal/v2` and fails before
upload, deploy, secret transport, route change, cleanup, or rollback. An earlier
failure remains non-mutating but may occur before that refusal exists. Enabling
mutation requires implementing and reviewing those external contracts; a CI
controller must not claim rollback or release success in their absence.

Dev is an entirely local three-Worker topology: the edge, core, and
`agentic-commerce-provider-dev` demo fixture run in one Wrangler session. The
fixture supplies deterministic MCP, checkout, and marketplace contracts with a
deliberately small `1/1/1` invocation catalogue. It is demo-only, requires no
remote Cloudflare resource, and is not evidence that any Staging or Production
provider is present or ready.

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
| AgenticGraph | Projection of that invocation catalogue through MCP; authoritative graph, Guardrail Gate, human-confirmed issuance, vendor D1, bundle commit, money ledger, same-transaction vendor split, settlement verification, and payout dispatch |
| Commerce core | Registration, deterministic selection and dispatch fences, invocation-pin verification, checkout/offer observation, derived markup, theme activation, and authoring claims |
| Commerce edge | Public Storefront Console and catalog plus session-, agent-, and operator-authorized facades over the private core |
| Release workflow | Protected candidate verifier and typed Production safety stop; it has no deploy, live-verification, release-receipt, or rollback authority |
| Sandbox Executor | Separate Dev-only isolated build/dry-run Worker with zero Production route or release authority |

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
  AgenticGraph service to execute. It is not the issuer or money authority.
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
AgenticGraph. This repository deliberately contains no authoritative vendor
lifecycle store, payment mutation, split projection, payout path, second vendor
database, or parallel money ledger.

This repository declares no D1 database, KV namespace, R2 bucket, or Queue. Its
core state is the six Durable Objects above. The separate Dev-only Sandbox
Executor declares one bounded container-backed Sandbox class; it is not on the
Production delivery path. AgenticGraph remains the sole owner of vendor D1,
authoritative bundle and money-ledger writes, same-transaction split persistence,
and payout coordination.

## Private Cloudflare topology

Production deploys two Workers in one Cloudflare account:

1. `agentic-commerce-core-production` has `workers.dev` and preview URLs
   disabled. It is reachable only through Service Bindings and binds the six
   Durable Objects plus the authoritative ACOS admission, external MCP,
   commerce, and marketplace services.
2. `agentic-commerce-edge-production` also has `workers.dev`, preview URLs, and
   binds the core by service name. Its configuration declares exactly one route,
   `airvio.co/agentic-commerce-os`. Because it is not a wildcard, Production
   exposes only closed-boundary HTML at that exact path; it does not route the
   direct-Worker catalog, asset, MCP, `/v1/*`, `/livez`, `/readyz`, merchant, or
   WebMCP paths. Serving that exact route is not yet live-verified, so the
   Delivery boundary remains closed.

A Cloudflare Service Binding selects a service, not an immutable Worker version.
Both direct readiness contracts therefore return their sanitized
`CF_VERSION_METADATA`. Source-ready core state may remain 503 solely because
route-live state is unknown. The exact Production HTML request accepts only that
typed condition, obtains a matching core liveness identity through the Service
Binding, and emits no-store readiness/candidate/edge-version/core-version
headers. A repaired release workflow must require those IDs and tags to equal
the sole 100-percent Cloudflare deployments and exact candidate. These checks
detect drift or a misrouted consumer; Cloudflare account policy must still
prevent deployment outside this controller.

The Production config contains deliberately invalid release placeholders. The
release workflow must inject the same lowercase 40-hex
`RELEASE_CANDIDATE_SHA` into both Workers. A direct Production deploy that omits
that override cannot pass readiness.

## Invocation reuse

The runtime does not maintain a second Production invocation dictionary. In
Staging and Production, the core hydrates the complete Agentic Canvas OS
document projection from the current AgenticGraph MCP service, verifies the
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

Production mutation is disabled in source. Every `deploy:production:*` package
entrypoint terminates in `scripts/release-controller.ts`; none contains a
Wrangler deploy command. Non-dry controller calls return
`release_external_authority_required`. The repository exposes no Cloudflare
account/zone API helper or successful release-receipt constructor. The protected
workflow receives no Cloudflare account identifier, zone identifier, API token,
Worker secret, or mutation credential.

The manual workflow is a safety-stop evaluator, not a deployment controller. It
binds `bootstrap` or `steady-state` mode to the exact protected-main candidate,
runs locked implementation checks, builds minified dry-run bundles, requires a
first-attempt approval by an exact configured Production user reviewer, and
rechecks remote `main` after approval. It then emits a v2 typed refusal and
fails before any Production credential or mutation. A preflight failure may
occur before that typed receipt exists; every such path is still credentialless
and non-mutating.

`.github/workflows/ci.yml` installs the committed lockfile, checks the external
evidence contract, and runs the bounded source-and-bundle checks for pull
requests and merge-queue candidates. Repository rules must require its
`Integration Gate` check and forbid direct pushes to `main`. Terminal task
verdict evaluation remains separate and fail-closed: no current verdict set is
checked in. The portable task snapshot now maps task-level evidence-contract
and implementation closure to their non-recursive checks, closing the prior
aggregate self-reference without skipping or synthesizing external evidence.

The workflow has two inputs: `mode` and the exact lowercase 40-hex candidate at
protected `main`. It does not accept a prior release, bootstrap-resume artifact,
route, Worker version, credential, or secret as dispatch authority. Its bundle
proofs are local dry-run evidence only; they do not assert a remote version or
deployment.

`docs/do-storage-compatibility.json` still binds the Wrangler migration/class
contract, complete Durable Object persistence sources, reviewed dependencies,
and normalized DDL. That manifest is implementation evidence, not rollback
authority. Until an external controller proves a lease/fence/CAS, exact remote
migration identity, and N/N-1 pair compatibility, neither bootstrap nor
steady-state may upload, deploy, publish a route, or roll back.

The direct-Worker `/readyz` handler remains a non-mutating diagnostic for source
and provider convergence. The exact public route is
`https://airvio.co/agentic-commerce-os`; only a future authorized controller may
use its typed HTML headers as post-deployment proof.

## Rollback contract

No rollback command exists in the active workflow or package entrypoints.
Rollback cannot be enabled merely by retaining prior version IDs: Durable Object
storage, external transactions, mixed core/edge intervals, and late concurrent
writes require a reviewed compatibility proof and the same external fenced
authority as forward deployment. Unknown or partial remote state remains
fail-closed for operator reconciliation.

## Required external configuration

GitHub administrators must:

1. protect `main`, require pull requests and `Integration Gate`, and prevent
   direct or bypass pushes outside the repository-owned lifecycle;
2. create the `production` environment, restrict it to protected `main`, and add
   `prevent_self_review: true` plus at least one direct configured `User`
   reviewer. The approving user ID must equal a configured reviewer ID; team-only
   authorization is unsupported until membership is independently proved; and
3. keep Cloudflare credentials out of this workflow. A future release adapter
   must hold its mutation credential outside candidate execution and expose only
   a reviewed `controller-issued-lease-fence-cas/v1` transition interface.

Cloudflare operators must:

1. provision the core and edge services in the intended account and authorize
   the core deployment to apply the reviewed six-class Durable Object migration
   chain, keeping the core private and binding the edge to it;
2. configure distinct, non-placeholder `MCP_BEARER_TOKEN`,
   `OPERATOR_BEARER_TOKEN`, and `STOREFRONT_SESSION_SECRET` secrets on the edge
   Worker. Generate each with a cryptographically secure secret generator; do
   not record a value in repository files or workflow inputs;
3. provision and restrict the ACOS admission, external MCP, commerce, and
   marketplace service bindings expected by the core, and replace both invalid
   Production evidence placeholders with reviewed immutable provider receipt
   pins; install the reviewed human-presence trust anchor only in the edge
   runtime, not in release-evaluator inputs;
4. reserve the declared exact `https://airvio.co/agentic-commerce-os` route for
   the future fenced controller and its typed post-deployment proof; and
5. prohibit out-of-controller changes to either commerce Worker during a
   release and retain both rollback versions.

AgenticGraph operators must provide the live provider contracts the core calls:

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
`ACOS_ADMISSION`, returning an exact active `acos-adapter-registration/v1`
receipt for the four authoritative registration inputs.

## Exact remaining blockers

The current lane cannot truthfully claim Production delivery because:

- the checked-in protected workflow intentionally refuses before all Production
  credentials and mutations because no external lease/fence/CAS adapter exists;
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
- no compatible deployed core/edge pair, exact remote migration identity,
  N/N-1 compatibility proof, or first-bootstrap controller receipt exists;
- the three edge Worker secrets, Production Durable Object migration chain, and
  exact HTTPS route/header proof are not applied or verified;
- a new registry is empty, while readiness requires at least one verified active
  `flight` agent and one verified active `shopping` agent with live MCP discovery
  tools;
- the owning ACOS runtime does not yet expose the private admission contract,
  while AgenticGraph does not yet expose and prove every checkout, status, vendor,
  and settlement evidence contract consumed here; reviewed immutable provider
  evidence pins and matching VCC receipts are also absent; and
- no authorized external transition has sealed the exact candidate, remote
  Worker identities, storage compatibility, live versions, and route response.

Until all conditions close, Dev evidence may support further integration, but
the correct Production status is **blocked / fail-closed**, not deployed or
production-runtime-ready. The public surface exists in source and configuration;
serving it on the declared Cloudflare route remains unproved. The delivered rung
remains undocumented until the owning AgenticGraph money path and this control
plane both have separate protected deployment and live-readback receipts.
