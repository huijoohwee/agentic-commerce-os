---
title: "Edge Commerce MVP — Implementation Handoff"
doc_type: "Handoff"
version: "0.5.0"
date: "2026-09-12"
lang: "en-US"
frontmatter_contract: "required"
owner: "agentic-commerce-os"
continuity_id: "edge-commerce-agent-mvp"
local_rung: "dev-proven"
delivered_rung: "undocumented"
load_policy: "on-demand"
---

# Edge Commerce MVP handoff

[The grounded PRD/TAD/ADR/MVP/GTM](prd-tad-adr-mvp-gtm-edge-commerce-agent.md) owns
`edge-commerce-agent-mvp@0.5.0`. Base: `addf6afb3821c61b33f44d1b0a4e82afb7e139fa`.
The supplied private 0.1.0 draft remains byte-identical at its original untracked path;
the executable product's grounded successor lives here with its source owner.

## Stripe sandbox checkout amendment — 0.5.0

The user requires sandbox payment and explicitly requested Stripe MCP. Authenticated MCP and
Dashboard WebMCP confirmed account `acct_1TKGGUGzH0w0k4VU` in test mode. The public `#checkout`
flow now reviews the fixed SGD 8 test offer, opens Stripe hosted test checkout, verifies the exact
provider session and payment, and releases the sample download and explicitly nonfinancial receipt.
Live keys/sessions are rejected. Graph's live payment Worker remains unchanged. No database,
Worker or external dependency is added. Vendor/admin drafts remain local.

[The shared PRD/TAD/ADR/MVP/GTM contract](prd-tad-adr-mvp-gtm-edge-commerce-agent.md#current-public-sandbox-contract-prd--tad--adr--mvp--gtm)
owns exact source/provider boundaries. This replaces the interim native simulation. Test fixtures
stay under `test/local-first/`; production cannot invoke fixture controls. Local behavior and browser
checks cover delivery; protected remote checks create and expire a Stripe test session. The final
handoff must record the separate hosted test-payment observation and deployed source/version.

The protected release requires v2 source/artifact-bound owner authorization, all eleven public
browser groups and live `checkout:sandbox` / `paymentProvider:stripe` / `realMoney:false` readiness.
Test transactions do not establish real revenue or full Mercur feature parity. Existing full Edge
experience descriptions below remain specific to that runtime.

## Public URL correction

The user reported that the public URL did not match the implemented experience. Live HTTP and
browser inspection confirmed the older local-first draft editor at source
`4886615a31dd69a1e2c7424cbd04e01c7331fa53`; PR47's Edge UI had not been merged/deployed and was
not the public asset profile. The correction now changes the actual source-owned local-first
artifact: shopper preview, vendor offer/catalog/editor, admin overview/review/data views. All
views reuse existing drafts and launch review; no parallel ledger, product schema or dependency.
The full comparison and limits are in [Mercur coverage](mercur-experience-parity.md).

Release-scoped static URLs also fix mixed new-HTML/old-CSS/JS behavior with the previously
installed cache-first service worker. Existing drafts remain in the same database/version;
unversioned asset endpoints remain only for upgrade compatibility. Editor/import controls remain
disabled until their lazy handler loads. Agent writes still fail closed; 0.5.0 adds only the scoped Stripe test checkout endpoints.

The prior 0.4.0 validation: 41 local-first contract tests and all 10 required browser groups passed,
including all role views at 360px and 1440px, search/pagination/details, private projection,
shared review and offline reload. Typecheck and authored limits passed. Public assets total under
70 kB. The full local Integration Gate passed: 91 domain, 278 unit, 60 Worker tests, all public-profile
checks, 18 Edge browser checks and the real Dev paid loop. Production dry chunks remain within
500,000 bytes (largest 485,731). The Podman machine was stopped afterward. Hosted integration
and protected release observations belong to the final candidate/run; local checks are not a
deployed receipt. Canonical tooling was restored to its existing lockfile pin before publication;
canonical and worktree doctor checks now pass. Production requires actual owner approval
for the exact release run. Full Commerce still has the independent runtime-evidence boundary below.

## Retained Edge experience increment

[Mercur experience coverage](mercur-experience-parity.md) grounds the 0.4.0 update on the pinned
reference and Commerce's existing contracts. Shopper catalog browsing, filters, pagination,
keyboard details and checkout confirmation; vendor preview/catalog/proposal navigation; and admin
registry/review navigation, search, status filtering and details now use native components.

The browser modules are separated into bounded native Text owners and composed only on each
role's asset request. The initial catalog browse uses GET without agent discovery. Offline snapshots
are matched to their catalog path. In-flight confirmation prevents selection/search changes and
leaves an accepted checkout's offer, total and reference visible. There are no new dependencies.

Local integration coverage passed: 91 domain, 278 unit, 60 Worker, 40 offline-contract,
nine offline-browser and 18 storefront/workspace browser checks, plus the real Dev loop with
two reviewed theme activations, one settlement, one revenue entry and exact replay. The final
browser/Dev/dry runs followed corrections to two assertions tied to the old presentation and
initial-load behavior; earlier passing checks were retained. Generated types, typecheck, source
checks, storage fingerprint and authored limits passed. The largest dry runtime chunk is 485,731
bytes (Core 197,886 bytes); each native Text asset is below 12 kB. Mobile/desktop fixture previews
were inspected for all three roles. The owned Podman machine was stopped after verification.
Hosted CI must independently bind the full Integration Gate result to the published commit.

## Retained native workspace increment (0.3.0)

[Native source and behavior](native-commerce-workspaces.md) extends the reviewed launch pack into
vendor staging, admin review and the existing shopper flow. Native merchant tools only read/stage;
no agent publication/approval tool or credential persistence is introduced. Concurrent browser
approvals atomically consume one proposal. The existing theme Durable Object binds the reviewed
base digest into its permit and rejects a newer, different live version inside the activation
transaction. Operator lease acquisition handles a definitive stale epoch once; unknown publication
results use read-only recovery rather than replay.

The Edge Worker uses native text modules for the merchant browser code and composes it only on
its asset route. Shared IndexedDB and WebMCP logic remain source-owned once. Wrangler generates
its corresponding module declaration, and the invocation validator follows the extracted route owner. The original 600-line/500,000-byte limits remain intact;
no external project code, model SDK, dependency, service, migration or payment owner was added.

Prior 0.3.0 observations: 278 unit tests, the new real SQLite version/permit test, 15 browser checks
and the complete Dev loop passed. The loop includes two separately reviewed theme activations
before the existing single settlement/markup/replay assertions. The 360px mobile vendor page was
visually inspected. The final complete `npm run check:integration` passed after generated types,
storage fingerprints and route-owner validation were updated. That revision's totals were 91 domain,
278 unit, 60 Worker, 40 offline-contract, nine offline-browser and 15 storefront/workspace browser
checks, plus the full Dev settlement loop. Production dry chunks are core 197,843 bytes, edge
495,552 bytes and two merchant text assets of 12,491 / 3,888 bytes. The longest changed authored
file is 590 lines. `git diff --check` passed; the owned Podman machine stopped after verification.

`npm run check:evidence` still reports `evidence_runtime_context_incomplete` and zero enrolled
independent dispatch issuers. This is a separate terminal readiness gate, not a source-suite pass.
Protected CI must independently verify the published candidate; its result belongs to that PR.

## Retained first-dollar increment

The existing offline workspace now persists buyer/outcome/merchant/agent and explicit cost
estimates. Its lazy launch module calculates integer contribution and setup recovery, reviews
one exact saved draft, and exports the existing `commerce.theme.deploy` arguments without
private notes. Edits or concurrent writes invalidate the review. v1 backups remain readable;
v2 imports preserve terms and reject conflicts. No model call, package dependency, cloud
resource, payment ledger, provider, or new live mutation endpoint was added.

The strengthened Dev E2E consumes the same launch module, verifies no storefront exists
before activation and an agent token cannot publish, acquires a current operator claim,
activates the generated theme, then discovers and confirms one provider offer. It checks
one settlement, one markup entry and exact replay without duplication.

The browser producer and release consumer share an exact required-check catalog. The release
gate rejects old six-check proofs, omissions, unknown checks and duplicate-filled results;
it still requires the exact source revision, deferred checkout and existing release authority.

Hosted verification exposed a pre-existing cancellation race in `scripts/isolated-process.ts`:
an early disconnect could kill while `podman start --attach` was still starting the container,
leaving termination unproven and the local host unavailable. A direct probe and the real local-host
test reproduced the failure. Startup now completes before attaching stdin and processing
cancellation; the bootstrap waits for input, and all ownership/exit/removal checks remain.
The new real-container regression and the existing disconnect test pass.
The regression checks cancellation and verified removal within 15 seconds. The
[Linux observation](https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34622438792)
can report a zero raw engine exit code on early cancellation; the executor also requires
`!timedOut` for success, so that raw code cannot turn a cancelled job into a successful result.

## Earlier candidate verification

The following records the retained first-dollar candidate before native workspaces.

| Owner check | Result |
|---|---|
| Upstream Agentic OS `npm run check` | Passed: evaluators and selected authority, completion, governance and lane-state tests |
| Commerce generated types + strict typecheck | Passed |
| Domain suite | 91 passed |
| Unit suite | 275 passed in 56 files |
| Real Worker / SQLite suite | 59 passed in 19 files |
| Local-first contracts | 40 passed, including 5 launch-contract and 3 release-proof cases |
| Local-first real-browser script | 9 scenarios passed: offline/reload, concurrency, review, exact economics, privacy, import and responsive layout |
| Full-browser contracts + strengthened Dev settlement loop | 12 + 1 passed; exact owned-proxy removal and Podman lock release verified |
| Direct Podman isolation + local-host operational checks | 7 + 4 passed, including cancellation during startup and disconnected-client recovery |
| Named source checks, authored limits and terminology | Passed; changed files remain below 600 lines |
| Dev and Production dry bundles | Passed; Production core 197,070 bytes, edge 489,138 bytes, cap 500,000 |
| `git diff --check` | Passed |
| Full local `check:integration` | Passed as one complete command after the runtime and release-proof fixes |
| Terminal `check:evidence` | **Blocked:** `evidence_runtime_context_incomplete`; zero enrolled independent dispatch issuers |

Full local `check:integration` passed with `AGENTIC_PODMAN_MACHINE=agentic-dev` and the
checksum-verified Darwin ARM64 runtime from
[workerd build 649aa72a](https://github.com/huijoohwee/workerd/releases/tag/podman-649aa72a91e4).
Its binary SHA-256 is `0d9f91f3eb904c8a857867bd114f3224006235f51490b8c83c5ba669a6529ec3`.
The existing Podman machine was stopped after verification. The earlier published candidate's
[CI run](https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34621452823)
exposed the cancellation race described above; its immutable ref is preserved by an in-place
successor. Protected CI must bind its own verdict to the corrected published candidate.

The local-first browser owner writes screenshots and JSON observations under
`node_modules/.cache/local-first-verification/`. Logs and the reviewed mobile image are also
retained in the task's local artifact directory. These unsigned observations are reproducible
Dev evidence, not the external evaluator's missing production verdicts.

## Remaining boundaries

The existing storage transition classifier reports `reviewed_backward_compatibility_proof_required`
with `codec_drift` for revision `fc0f09f3c01e06ba0141aab9e2b4aeadda71c32d8594e87248d048a93208cbe3`.
The current delta fingerprints changed default theme colors/copy; no SQL objects/classes or
migration history were changed. Local legacy/current behavior tests do not grant the production
controller its separately reviewed compatibility evidence.

No real payer, WTP proof, payment, merchant fulfillment or public release was produced.
The local asset-only Worker still refuses server mutations. The full-Commerce profile retains
its provider/admission pins, human-presence issuer, free-tier execution, independent evaluator
and explicit release requirements. Cloudflare Wallets currently cannot send/receive funds.
Local review is not cryptographic human authorization, and planned price never overrides the
provider's actual quote. Trusted operator APIs remain trusted operator APIs.

Before first collection, supply the real merchant and registered agent, agree on an outcome,
obtain provider/evaluator readiness, authorize the exact release, verify the live route, and
then obtain a genuine settled receipt and buyer acceptance. Do not infer these from fixtures,
positive economics, source checks or a merged PR. Merge, deployment, branch retirement,
worktree cleanup and canonical synchronization remain separate authorized effects.
