# Production runtime contract

## Readiness result

This repository is a fail-closed production candidate, not a currently verified
Production runtime. It implements a private commerce ingress and coordination
layer for the committed v0.3.0 baseline of
`knowgrph-agentic-commerce-platform-prd-tad-adr.md`; it does not relocate the
authoritative graph, payment, or settlement runtime from its owning repository.
Production readiness requires the source, administration, dependency, consumer,
deployment, live-probe, and rollback receipts listed below.

Dev is an entirely local three-Worker topology: the edge, core, and
`agentic-commerce-provider-dev` demo fixture run in one Wrangler session. The
fixture supplies deterministic MCP, checkout, and marketplace contracts with a
deliberately small `1/1/1` invocation catalogue. It is demo-only, requires no
remote Cloudflare resource, and is not evidence that any Staging or Production
provider is present or ready.

The implementation is bound to the committed PRD at Knowgrph revision
`1acbbcc3b06534f9712f5b05b781010f749fa842`. Uncommitted later edits and the
in-flight product rename are not release inputs. New repository-owned contracts
use `commerce.*`. Exact existing external Worker and MCP names remain only where
the owning service currently requires them; this repository does not add aliases
or downstream remapping for either product name.

## Ownership boundary

| Owner | Runtime responsibility |
|---|---|
| Agentic Canvas OS | Authoritative agent definition/admission receipts plus canonical invocation grammar, catalogue, and routing document revisions for `/`, `@`, and `#` tokens |
| Knowgrph | Projection of that invocation catalogue through MCP; authoritative graph, Guardrail Gate, human-confirmed issuance, vendor D1, bundle commit, money ledger, same-transaction vendor split, settlement verification, and payout dispatch |
| Commerce core | Registration and exclusive routing fences, invocation-pin verification, per-intent dispatch lease, and per-checkout prepare/confirm state machine |
| Commerce edge | Authenticated MCP and HTTP facade over the private core; it owns no public Production route |
| Authorized consumer | Public hostname or upstream Worker that binds or proxies the private commerce edge and supplies the HTTPS `/readyz` release probe |

The core runs three SQLite-backed Durable Object classes:

- `AgentRegistry` requires exactly one active `flight` agent and one active
  `shopping` agent before readiness passes. Registration is definition-,
  allowlist-, content-hash-, and invocation-proof-bound.
- `IntentRoute` persists one routing/dispatch decision and idempotency key per
  intent before calling the selected discovery MCP tool. It accepts only an
  exact digest-bound offer receipt at the pinned provider revision. An unknown
  call result is not automatically replayed.
- `CheckoutSession` persists the upstream guardrail evidence and a one-use
  confirmation challenge, then records human confirmation before asking the
  owning Knowgrph service to execute. Post-egress ambiguity becomes
  `reconciliation_required`; only an exact status receipt for the original
  idempotency key can settle it. It is not the issuer or money authority.

The deployed core proxies vendor and settlement runtime operations to Knowgrph.
This repository deliberately contains no vendor lifecycle, commission,
split-projection, payout, second vendor database, or parallel ledger logic.

This repository declares no D1 database, KV namespace, R2 bucket, or Queue. Its
only stateful resources are the three Durable Objects above. Knowgrph remains the
sole owner of v0.3.0 vendor D1, authoritative bundle/ledger writes,
same-transaction split persistence, and alarm-driven payout coordination.

## Private Cloudflare topology

Production deploys two Workers in one Cloudflare account:

1. `agentic-commerce-core-production` has `workers.dev` and preview URLs
   disabled. It is reachable only through Service Bindings and binds the three
   Durable Objects plus the authoritative ACOS admission, external MCP,
   commerce, and marketplace services.
2. `agentic-commerce-edge-production` also has `workers.dev`, preview URLs, and
   routes disabled. It binds the core by service name and exposes `/mcp`, the
   authenticated `/v1/*` facade, `/livez`, and `/readyz` only to a separately
   authorized consumer.

A Cloudflare Service Binding selects a service, not an immutable Worker version.
Both readiness contracts therefore return their sanitized
`CF_VERSION_METADATA`, and the edge includes the core readiness report reached
through its binding. The release workflow requires those live IDs and tags to
equal the sole 100-percent Cloudflare deployments and the exact candidate. These
checks detect drift or a misrouted consumer; Cloudflare account policy must still
prevent deployment outside this controller.

The Production config contains deliberately invalid release placeholders. The
release workflow must inject the same lowercase 40-hex
`RELEASE_CANDIDATE_SHA` into both Workers. A direct Production deploy that omits
that override cannot pass readiness.

## Invocation reuse

The runtime does not maintain a second Production invocation dictionary. In
Staging and Production, the core hydrates the complete Agentic Canvas OS
document projection from the current Knowgrph MCP service, verifies the
configured source revision, catalogue digest, routing schema, routing digest,
and full `142/142/136` command/semantic/binding counts, then resolves the
required `/tool.route`, `#mcp`, and `@mcp-gateway` tokens. The local Dev provider
implements the same transport and token contracts with its `1/1/1` fixture.
Registration and readiness fail when the pins for the active lane, a required
token, or a registered discovery tool differ from that lane's provider.

This preserves one invocation source of truth while allowing another repository
to host the commerce runtime. The current external MCP tool and path remain
provider-owned contracts; a future owning-repository rename must update the
provider and the pinned consumer together, with a new receipt.

## Release controller

`.github/workflows/ci.yml` installs the committed lockfile and runs
`npm run check` for pull requests and merge-queue candidates. Repository rules
must require its `Integration Gate` check and forbid direct pushes to `main`.

`.github/workflows/production-release.yml` is manual-only. Its five required
inputs are:

- the exact lowercase 40-hex commit currently at remote protected `main`;
- the exact HTTPS consumer `/readyz` URL on `airvio.co` or one of its subdomains,
  without credentials, query, fragment, redirect assumption, or non-default
  port;
- the run ID and exact artifact ID of a prior successful invocation of this
  Production Release workflow; and
- the published lowercase SHA-256 of that artifact's `release.json` receipt.

The workflow downloads the named artifact through the read-only GitHub Actions
API and accepts exactly one `release.json`. Its bytes must match the supplied
digest, its schema must be `agentic-commerce-production-release/v2`, and its run
must be successful, manual, on `main`, and produced by this workflow. The
receipt—not unbound dispatch inputs—is the source of both rollback version IDs,
their common prior candidate, and their complete sanitized binding digests.

Before protected environment approval, the workflow also checks out the new
exact SHA, proves it still equals remote `main`, runs the locked checks, and
reconstructs the receipt's prior source tree, lockfile digest, and both config
digests from repository history. It requires the prior commit to be an ancestor
of the candidate. `docs/do-storage-compatibility.json` explicitly binds the
Wrangler migration/class contract, the exact byte SHA-256 of each complete
Durable Object source file, the normalized schema-initialization region, and
every DDL statement in `AgentRegistry`, `IntentRoute`, and `CheckoutSession`.
It also exact-byte seals the reviewed persistence dependencies: shared canonical
JSON/digest encoding; admission, checkout, and discovery receipt codecs; the
exclusive-category router; the core request boundary; and checkout input
normalization. `scripts/validate-do-storage-compatibility.ts` requires that
explicit dependency inventory, rejects DDL outside the declared regions, and
recomputes the manifest's SHA-256 revision from the whole persistence surface.
The candidate and sealed prior receipt must carry the same validated revision.
Any DDL, persistence codec or dependency, state-transition, request-shaping, or
read/write logic change therefore blocks this steady-state release even when
its manifest is updated; it needs a separately reviewed forward-compatibility
path, not an optimistic rollback.

Cloudflare credentials are scoped only to steps that read or mutate Cloudflare.
They are unavailable to checkout, dependency installation, repository tests,
artifact upload, and summaries. The API token and Worker secret values are never
passed as workflow inputs, command arguments, captured output, or artifacts.
Raw Wrangler version responses and raw live responses stay in the ephemeral
runner directory. Artifacts contain only sanitized IDs, digests, non-secret
candidate pins, and readiness verdicts.

After approval, the workflow:

1. proves both sealed prior versions are still the sole 100-percent deployment,
   share the receipt's exact lowercase 40-hex candidate tag and binding, and
   match every reviewed lane, invocation, service, secret-name, version-metadata,
   and Durable Object binding plus the receipt's full binding digest;
2. deploys the private core with strict remote-change checking, a candidate tag,
   and the exact `RELEASE_CANDIDATE_SHA` binding;
3. verifies one core version at 100 percent and matches all Production config
   bindings, including newly reviewed admission or upstream evidence pins;
4. deploys and verifies the private edge the same way, including only the names
   (never values) of its two secret bindings;
5. requests the required consumer HTTPS `/readyz` URL and requires HTTP 200,
   `commerce.edge-readiness/v1`, Production lane, distinct secret configuration,
   exact edge/core candidate tags and Cloudflare version IDs, and every edge and
   `commerce.core-readiness/v1` check passing;
6. rechecks that the active core and edge version IDs did not change during the
   live probe; and
7. seals and uploads the sanitized deployment plus live-readiness receipt.

`/readyz` is a non-mutating aggregate probe. It proves release pins, ACOS
admission availability, registry cardinality and per-row invocation alignment,
invocation catalogue pins, MCP tool availability, provider capabilities, and
exact provider-version VCC evidence pinned to PRD, source,
storage-compatibility, and receipt digests. It does not create a checkout, issue
a card, move money, transition a vendor, or prove an end-user route outside the
supplied consumer path.

## Rollback contract

Any failure after a deployment attempt—including version/tag/binding mismatch,
consumer probe failure, drift, receipt sealing failure, or successful-receipt
upload failure—invokes Wrangler rollback using only the version IDs extracted
from the sealed prior receipt. The controller restores edge first and then core.
It does not call an active deployment "restored" merely because both IDs are at
100 percent: it revalidates the prior candidate tag and binding, every reviewed
binding and full binding digest, then calls the consumer `/readyz` path and
requires the exact prior candidate, exact prior edge/core live version IDs, and
every readiness check to pass. The failed release remains failed after a proven
restoration, and the rollback receipt records the independent version and live
verdicts.

Rollback selects prior Worker code and bindings; it does not undo Durable Object
storage, delete a Durable Object class, revert a Knowgrph migration, change the
authorized consumer, or reverse an external transaction. The declared `v1`
Durable Object migration, complete current state-machine source bytes, and exact
bytes of the reviewed persistence dependency inventory are sealed by the
storage manifest. Later class removals, DDL, persistence-format/dependency,
request-shaping, or state-transition changes require a separate forward
migration and compatibility receipt before release.

Runner cancellation, runner loss, or a job-level timeout can prevent any CI
controller from executing cleanup. Remote calls have explicit command bounds,
the release concurrency group is non-cancelling, and the job reserves a bounded
rollback window; an infrastructure-level interruption still requires an
operator to verify both active versions and replay the same reverse order.

This steady-state workflow intentionally cannot bootstrap an empty Cloudflare
account: a valid v2 release receipt and both immutable versions must already
exist. The first Production bootstrap needs a separately authorized, non-public
provisioning exercise that creates compatible versioned Workers, configures
secrets and bindings, seeds the two required agents, verifies the private
topology, and seals the initial v2 receipt plus published digest. That bootstrap
controller and receipt do not yet exist in this repository.

## Required external configuration

GitHub administrators must:

1. protect `main`, require pull requests and `Integration Gate`, and prevent
   direct or bypass pushes outside the repository-owned lifecycle;
2. create the `production` environment, restrict it to protected `main`, and add
   an authenticated human required-reviewer gate;
3. set environment variable `CLOUDFLARE_ACCOUNT_ID`; and
4. set environment secret `CLOUDFLARE_API_TOKEN` with the minimum Worker and
   version/deploy/rollback permissions required by these two Worker services.

Cloudflare operators must:

1. provision the core and edge services in the intended account and authorize
   the first core deployment to apply the declared `v1` three-class Durable
   Object migration, keeping both Workers private;
2. configure distinct, non-placeholder `MCP_BEARER_TOKEN` and
   `OPERATOR_BEARER_TOKEN` secrets on the edge Worker;
3. provision and restrict the ACOS admission, external MCP, commerce, and
   marketplace service bindings expected by the core, and replace both invalid
   Production evidence placeholders with reviewed immutable provider receipt
   pins;
4. provision an authorized consumer binding or proxy with an exact HTTPS
   `/readyz` path to the private edge and appropriate access policy for `/mcp`
   and `/v1/*`; and
5. prohibit out-of-controller changes to either commerce Worker during a
   release and retain both rollback versions.

Knowgrph operators must provide the live provider contracts the core calls:

- the Agentic Canvas OS document-projection MCP and invocation tool;
- readiness for the commerce and marketplace services;
- checkout prepare, confirm, and idempotency-key status endpoints with exact
  discovery, guardrail, and settlement receipts that preserve
  guardrail-before-confirmation-before-issuance ordering;
- vendor list and authenticated lifecycle transition endpoints; and
- settlement readback backed by the single authoritative ledger and
  same-transaction split projection; and
- immutable runtime-evidence receipts proving the complete checkout and
  marketplace VCC check sets for the bound provider versions.

Agentic Canvas OS operators must expose the private admission endpoint used by
`ACOS_ADMISSION`, returning an exact active `acos-adapter-registration/v1`
receipt for the four authoritative registration inputs.

## Exact remaining blockers

The current lane cannot truthfully claim Production delivery because:

- this implementation is not yet integrated into protected `main`, and the
  repository inspection preceding this lane found no branch protection/ruleset,
  Production environment, Actions variable, or Actions secret;
- a read-only Cloudflare inspection during this lane reported not-found code
  `10007` for both commerce Production Workers and the configured Production
  commerce and marketplace dependencies; only the external MCP service was
  observed, and its candidate compatibility is still unproved;
- no compatible deployed core/edge pair and checksum-published v2 receipt exist
  to satisfy the mandatory prior-release inputs, and no first-bootstrap
  controller exists;
- the edge Worker secrets, Production Durable Object class migration, authorized
  consumer Service Binding/proxy, and required HTTPS readiness URL are not
  applied or verified;
- a new registry is empty, while readiness requires exactly one active `flight`
  agent and one active `shopping` agent with live MCP discovery tools;
- the owning ACOS runtime does not yet expose the private admission contract,
  while Knowgrph does not yet expose and prove every checkout, status, vendor,
  and settlement evidence contract consumed here; reviewed immutable provider
  evidence pins and matching VCC receipts are also absent; and
- no successful workflow run has sealed the exact candidate, source tree and
  configs, storage compatibility revision, binding digests, core and edge
  version IDs, and version-bound consumer live response.

Until all conditions close, Dev evidence may support further integration,
but the correct Production status is **blocked / fail-closed**, not deployed,
public, or production-runtime-ready. The committed PRD's delivered rung remains
undocumented until the owning Knowgrph money path and this private control plane
both have their separate protected deployment and live-readback receipts.
