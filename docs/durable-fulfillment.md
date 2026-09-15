---
title: "Reference implementation — Durable listing fulfillment"
doc_type: "PRD-TAD-ADR-MVP-GTM"
continuity_id: "DURABLE-LISTING-FULFILLMENT-001"
upstream_continuity_id: "DURABLE-AGENT-WORKFLOWS-001"
upstream_revision: "0.1.0"
version: "0.1.0"
prd_revision: "0.1.0"
tad_revision: "0.1.0"
adr_revision: "0.1.0"
mvp_revision: "0.1.0"
gtm_revision: "0.1.0"
date: "2026-09-15"
lang: "en-US"
owner: "agentic-commerce-os"
frontmatter_contract: "required"
load_policy: "on-demand"
local_rung: "documented"
delivered_rung: "undocumented"
readiness_scope: "Protected public listing release verified; admission source transfer and actual provider rollback proof pending"
lane: "authoring"
universal_scope: false
worktree_id: "device-0232231d4a19--durable-fulfillment"
agent_id: "codex-01a0a3a3"
guideline_revision: "2.7.0"
guideline_source_revision: "e9675f27d1eb1e30ae6b8f82669ff7e546d85c65"
reviewed_source_revision: "134c41f0d77af6ffd2fe401520bc3b1438df47e6"
---

# Durable listing fulfillment

This product slice consumes the approved
[DURABLE-AGENT-WORKFLOWS-001@0.1.0](https://github.com/huijoohwee/agentic-os/blob/6c10b9d8d921aac1503a427bb02aeedf71852a8f/guides/DURABLE-WORKFLOWS.md).
Commerce owns `DURABLE-LISTING-FULFILLMENT-001@0.1.0`; its DF criteria below map to
the shared runtime plan's AC-D criteria, whose source owner remains Agentic OS.
The implementation approval was supplied on 2026-09-15. Historical proposal and protected release
observations retain their original scope. The existing [sandbox owner](prd-tad-adr-mvp-gtm-edge-commerce-agent.md)
continues to own the offer, test payment and human confirmation.

## PRD — one reviewed deliverable

**CID / RAO / SVO:** Context: a seller prepares an offer on a mobile browser. Intent: retain preparation
progress across disconnection. Directive: connect the saved draft to one durable listing and sandbox receipt.
Role/Subject: seller. Action/Verb: reviews. Outcome/Object: one completed listing and matching test receipt.

The buyer pain is lost preparation work and uncertain retries. Willingness to pay, accepted price,
customer demand and real revenue remain unvalidated. The existing education offer's test amount is
not a price validation for generated listings.

| Criterion | Product acceptance | Owning source / validation |
| --- | --- | --- |
| DF-01 / AC-D02–04 | Repeated submission retains one job; a retry checkpoint survives process termination | `scripts/durable-fulfillment/runtime.mjs`; `test/local-first/fulfillment-runtime.test.mjs` |
| DF-02 / AC-D06–07 | Session/CSRF checks own admission; tool JSON cannot choose principal, definition, endpoint or credentials | `src/local-first/{session,fulfillment-contract,fulfillment}.ts`; `fulfillment.test.mjs` |
| DF-03 / AC-D07 | A mobile browser closes before work, reopens offline and resumes the saved handle after reconnecting | `public/local-first/{drafts,workflow}.js`; `fulfillment-browser.mjs` |
| DF-04 / AC-D07 | Explicit review binds the completed output digest to one test checkout and receipt | `src/local-first/{checkout,stripe-checkout}.ts`; `fulfillment.test.mjs` |
| DF-05 / AC-D08 | Installed pins, authenticated execution, compatible rollback and protected release agree | Existing local-first release controller; public source verified, retained-job provider rollback pending |

## TAD — reuse the current owners

`agentic-os` owns scheduling, retries, leases, SQLite and optional execution. Commerce owns the fixed
listing composition, browser session, draft read model, review and payment semantics. The composition
requires injected current authorization and a host-selected executor; import performs no execution.
The public Worker now has an authenticated listing relay. [Release 34998738855](https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34998738855) verified source 033bcb56e9d6d3839fef29e65962f34ceccc3c4a, its deployed version and eleven browser groups. This does not complete retained-job rollback proof.

Flow: save draft → persist local intent → authenticate → admit OS job → close/reopen browser → read
completed output → review exact text → confirm existing sandbox offer → provider readback → receipt/download.
Browser storage retains intent and read models; the OS store owns execution. There is no second payment ledger.

The server derives principal identity from the signed session and run identity from the session, exact
agent definition and draft snapshot. Start/status/cancel/retry accept closed, bounded inputs. Status uses
POST to keep private run handles out of URLs and caches. Each mutating request requires same-origin CSRF.
The host owns credentials; browser/tool inputs cannot supply execution URLs or code.

| Bound | Value |
| --- | --- |
| Product request / completed text | 16,384 / 16,000 UTF-8 bytes |
| Listing tasks / parallelism / attempts | 1 / 1 / 2 |
| Task timeout / fenced lease | 55 / 90 seconds |
| Run deadline / terminal retention | 1 / 7 days |
| Delayed retry | 2–30 seconds |
| Browser request timeout | 60 seconds; no automatic polling |
| Signed browser session | 7 days; existing session and CSRF owner |

Only confirmed, completed output may enter checkout. Stripe test metadata binds run ID and output digest;
readback checks the same binding along with the existing account, offer, nonce, amount and currency.
A changed binding cannot reuse an existing payment. Unknown create outcome retries the original provider
idempotency key. The combined receipt uses that one payment ID; no real money moves. Downloads recheck the
retained output and digest, so an unavailable host or expired record fails closed.

A returning seller may explicitly confirm a different reviewed listing after the earlier test order
is paid or expired. The UI labels its previous receipt and withholds the new listing's download until
its own payment readback succeeds. The new order retains the job principal and uses a separate
run-and-output-bound idempotency key; lost responses replay that key. Original first-order keys remain
unchanged for interrupted pre-upgrade requests. Pending or unpaid orders cannot be replaced.
Provider records and the previous receipt remain distinct from the newly confirmed order.
Validation: `checkout-binding.test.mjs` and the returning-seller browser flow.

Separate orders use the authenticated OS ledger's immutable first `run_planned` event to bound
creation and uncertain-response replay to 23 hours. Returning sellers keep their seven-day job
identity; observing a result cannot renew that payment window. Missing, future or stale timestamps
fail closed. Already recorded orders remain readable after the creation window. First-order
keys and their original session-age guard stay compatible with interrupted older checkouts.
No cookie schema or payment store changes are required.

## ADR — native composition and migration

Constraints: free core, independent product/session authority, bounded work, no new payment ledger,
preservation of drafts and unknown effects. Rebuilding checkout or adding a second queue increases
state and recovery cost. Select the existing draft/session/Stripe-test owners with the OS runtime seam.
This reasoning joins the approved Constraints ↔ Argumentation ↔ Outranking decision; it is not payer evidence.

Draft schema v3 adds one optional workflow read model to the existing IndexedDB store. v1/v2 backups
are accepted without altering their text or terms; malformed or conflicting imports fail atomically.
Ordinary drafts retain their v2 stored/exported shape until a job is explicitly prepared.
Creating the first workflow or importing a workflow backup requires a successful session response
from the configured execution host. A reader-only release refuses those writes before changing storage.
Existing v3 drafts remain readable and exportable when that host is unavailable; v1/v2 imports stay offline.
An edit invalidates result review. Import clears the review acknowledgement while preserving the result.
Imported review fields grant no server or payment authority: checkout
still authenticates and validates the retained completed output.

**Rollback dependency:** a v2-only frontend cannot read a stored v3 draft. Before enabling public
fulfillment, retain a protected release with this v3 reader as the rollback baseline, with execution
disabled. Rehearse rollback to that compatible reader while preserving all draft and OS state. Do not
roll back to a v2-only bundle after any v3 record exists; preserve a v3 export for recovery.
The compatible reader is deployed at `38662008dae8b3fc20905c7fb09d67036c878611`,
Worker version `1c04f403-9cc1-4b45-9dbb-a83e5f3ce7b4`, verified by
[production run 34976120904](https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34976120904).
The committed fulfillment release configuration retains that source/version/run as its fallback.
Public activation and a rollback rehearsal over an actual retained job remain separate proofs.

The listing revision is the SHA-256 of its immutable model/image pins, instructions and token cap.
`fulfillment-definition.ts` owns that product definition; `scripts/durable-fulfillment/executor.mjs`
requires a host-owned verifier before each inference and refuses changed artifacts before execution.
The optional local host verifies current model bytes, the private API key file, immutable container
image, command, loopback port, read-only mounts, resource limits and actual process capabilities.
It bounds file reads and refuses changed artifacts before each inference. Public deployment must
still bind the built host artifact and its installed package revision.
The generic OS retains provider-neutral injection. Local fixtures exercise behavior;
they do not attest model quality, a human review, hosted payment submission or public runtime availability.

## MVP — verification and release boundary

| Check | Observed scope / status |
| --- | --- |
| `npm run typecheck` | Passed for the product backend candidate |
| `node --test test/local-first/*.test.mjs` | 71 tests passed with the installed protected OS runtime at `4d13403ef17cf20e2946c478e029edc8d96c07f2`; subsequent host boundary changes have focused coverage |
| `npm run check:admission` | Transferred admission ownership, authority, persistence and deployment-identity tests pass in Commerce; Canvas consumer cutover pending |
| `scripts/local-first-release/check.mjs` | Eleven existing browser groups and the separate durable mobile contract passed locally |
| OS full suite | Protected [OS #176](https://github.com/huijoohwee/agentic-os/pull/176) passed 1,696 tests across 209 suites; this candidate pins `3663442db70b0e75c5eba487a86e7b444e9e7029` with archive integrity |
| Actual local host/browser | Mobile browser disconnected/reopened offline, then resumed an actual pinned-model job; host termination/restart replayed the same completed job; another browser was denied |
| Protected public release and rollback | Public source/version/route and eleven browser groups verified in release 34998738855; provider rollback rehearsal remains pending |

The process test kills the worker after a persisted delayed retry, starts a fresh process over the same
SQLite store, and observes one completed listing and one replayed test receipt. The browser test routes
requests to the actual product handler using a local test transport, SQLite and deterministic execution.
Its separate observation explicitly marks production, actual-human-review and hosted-payment proof false.
An additional local observation used real HTTP and the pinned local model without request interception.
The result preserved the supplied mug facts but did not follow the requested two-bullet format. It remains
unreviewed; checkout was disabled and no hosted payment was submitted. Persisted state records one task
attempt; model HTTP request count was not independently measured.

## Explicit device host

`npm run build:durable-host` reuses the existing bounded host builder and the installed OS package.
`npm run start:durable-host -- --config=/absolute/private/config.json` starts the optional listing
composition. The application seam and `agents/podman-model` export use the exact protected OS pin above.
The installed listing host builds within the 500 kB limit and rejects missing private configuration.
Configuration is a user-owned, single-link regular file with mode 0600, at most 16 KiB. Its fields are:

- `directory`: private persistent SQLite directory; retain it across restarts.
- `sessionSecret`: independent random signing secret; retain it to resume existing jobs. Restart
  after rotation to revoke prior browser sessions and background job authority.
- `model`: exact `modelPath`, `modelSha256`, `apiKeyPath`, `imageDigest`, `containerId` and
  loopback `endpoint`; the model and image must match the product definition.
- Optional `port` (5192), `assetDirectory`, `sourceRevision` and `stripeTestKey`.

The CLI loads credentials only from that private file. The host owns session admission, signs durable
principal context and rechecks it after restart. Job identity and execution state remain OS-owned.
The browser receives a signed HttpOnly session and a separate CSRF value. Missing checkout credentials
leave listing preparation available and return an explicit checkout-unavailable response.
SIGINT/SIGTERM drain the host. Stopping the host preserves the SQLite directory and browser drafts.
This is the existing device-session availability policy, not an always-on availability claim.

### Authenticated edge connection

The optional `fulfillment-relay` composes the existing OS run client with server-derived session
identity. Its two operator bindings are `LISTING_HOST_PINS_JSON` and `LISTING_HOST_BEARER`.
Neither binding configured means reader-only operation. Partial or invalid configuration keeps
the application readable and rejects job admission. The existing protected release controller
loads `deployment/local-first-fulfillment.json` on demand and includes its exact bytes in the
reviewed artifact. Without that file it publishes a reader. With it, release requires the
retained reader's successful owner-approved run, exact source-tagged six-binding version,
and an authenticated live host whose source, bundle, image, definition and model match the pins.
The independent bearer comes only from the protected production environment secret.

The controller verifies all eight relay bindings after upload, the public fulfillment session,
the host again and the existing eleven production browser groups. A known late failure restores
the previous owned version only while the route and active candidate still match; uncertain
writes or peer changes remain preserved. These checks prove admission and release identity;
actual model quality, a reviewed listing, restart/rollback continuity and checkout need their
own runtime observations. Never substitute an admission response for completed fulfillment.

The pin object has exactly `origin`, `bundleSha256`, `imageId` and `sourceRevision`. Origin is an
exact HTTPS origin; `imageId` is the immutable product image digest without its `sha256:` prefix.
The built host checks its own bundle hash before startup. Its private configuration can add
`relay: { pins, token }`, using a dedicated nonzero 64-character hex token, distinct from session,
payment and model credentials. Pins, the exact definition and the model digest bind each readiness
response. No credential is included in browser output or evidence.

Before issuing a fulfillment session, the edge performs one bounded authenticated host probe.
The host rechecks the pinned model artifacts; an offline or changed executor prevents new workflow
writes. Each run request carries its own server-derived principal and expiry over the authenticated
connection. The host seals that context with its retained local secret, so restart preserves job
ownership. Browser JSON cannot choose identity, endpoints, definitions or credentials. The existing
OS client owns redirects, byte/time limits and ambiguous-write reporting; there is no second queue.
Transport and capacity errors preserve the browser's saved state and require refreshing the same
job. They cannot turn an uncertain accepted write into a terminal failed-job record.

The edge uses manual redirect handling and rejects every redirect before following a location.
The Worker runtime does not support the browser's `redirect: "error"` option. The actual-workerd
regression test covers authenticated readiness, run invocation, and redirect refusal without a
model call. [Release attempt 34987421041](https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34987421041)
passed storefront/browser checks but failed fulfillment admission and restored reader version
`1c04f403-9cc1-4b45-9dbb-a83e5f3ce7b4`. Its redacted journal remains rollback evidence; it is not
a completed fulfillment release. A fresh protected candidate must pass public admission again.

Reuse the existing tunnel by routing `/api/agent-swarm/` and the exact
`/agentic-commerce-os/fulfillment/host-ready` path to the listing host. Preserve the existing generic
execution service and its credential. Source tests exercise real HTTP, SQLite restart, replay and
wrong-browser refusal with a deterministic model fixture; they are not public deployment, model
quality or payment proof. Device sleep or a disconnected tunnel leaves execution unavailable.

## Product admission ownership

`src/admission/` owns the transferred Commerce registration authority, admission contract/provider,
deployment identity, release proof and Commerce-specific durable state extension. Its package exports
are explicit and lazy. Generic state, JSON, registration and transport stay in OS; OS imports no Commerce
module. Existing state keys, schema identifiers, Worker class name and deployment binding fields are
preserved. The corresponding Canvas files remain until protected pinning and caller parity; this
candidate relocation does not transfer a namespace or establish a deployed owner.

Finish in dependency order: protected OS runtime → exact consumer package/lock pin → full applicable
checks → authenticated device/edge composition and artifact identity → compatible rollback rehearsal →
exact-candidate protected release → public source/version/route/browser readback. The current local
fixtures do not satisfy those pending gates. The adopted device-session availability policy remains in
[local-host-runtime.md](local-host-runtime.md); a sleeping/offline operator host cannot promise execution.

## GTM — measure before pricing

Start with one solo service seller and one real draft. Measure active preparation time, resumptions,
duplicate effects, review corrections and known execution usage. Unknown cost stays unknown. The next
commercial evidence is a reviewed deliverable and independently evidenced willingness to pay; the
sandbox receipt is a technical checkpoint. No outreach, real checkout, revenue or ROI is claimed here.

### Retained-job provider rollback rehearsal

The existing protected Local-first Production Release accepts explicit `rehearse_rollback` input.
It retains the same exact-candidate owner approval, source and route guards. After normal publication
and live checks, the native deployment owner creates one actual listing job in a mobile browser,
activates the verified reader from the committed fulfillment configuration, verifies the existing v3
draft remains readable, then restores the exact candidate version and reads the same run and output
digest. It submits no checkout and makes no human-review, model-quality or payer claim.

One named deployment owner performs at most two version activations. Before each it checks the exact
active deployment, route, source and retained version bindings. A peer change or ambiguous provider
response stops further effects and records preserve-required state. A failed reader observation may
restore the known owned candidate; it still cannot report the rehearsal complete. Existing failure
recovery retains its original behavior and shares the same version-activation call.

The rehearsal uses a fresh 390-pixel browser and actual public HTTP without route interception. It
blocks service workers for network source attribution; the separate offline contract remains the
offline proof. The listing completion wait is bounded to 120 seconds, with explicit five-second status
checks during the rehearsal. Provider/source/browser receipts and screenshots remain release artifacts.
Run `node --test test/local-first/rollback.test.mjs test/local-first/release.test.mjs` before publication;
the source tests use injected providers and do not establish a live rollback.

[Release 35035059530](https://github.com/huijoohwee/agentic-commerce-os/actions/runs/35035059530)
created an actual retained listing job and activated the reader, but the browser still received the
candidate document while the separate readiness request reported the reader. The controller restored
candidate version `0ac35693-e43e-4770-968e-66401bb912b2`; the rehearsal remains unproven. Its journal
retains the exact run/output digests, both provider transitions and the failed browser observation.
The browser now waits up to 45 seconds for its own exact document source. Only the known predecessor,
temporary unavailability and navigation transport errors may be polled; foreign sources, redirects
and authorization failures stop immediately. Each page attempt binds its own asset/error observations,
including rejected attempts, so a late response cannot inherit the next page's expected revision.
This polling performs document reads only and never repeats a provider activation or job submission.

The optional admission Worker entry and six original persistence/provider suites transfer into their
Commerce owner under `src/admission/MIGRATION-TESTS.json`. The source and assertion inventory remains
distinct from activating that private service or minting its admission authority. This batch pins
the protected OS package at `3663442db70b0e75c5eba487a86e7b444e9e7029`; the already verified device host keeps its own
immutable source/bundle/model pins. No new dependency, public route or always-loaded module is added.
