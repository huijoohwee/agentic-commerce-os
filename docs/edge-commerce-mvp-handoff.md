---
title: "Edge Commerce MVP — Implementation Handoff"
doc_type: "Handoff"
version: "0.3.0"
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
`edge-commerce-agent-mvp@0.3.0`. Base: `addf6afb3821c61b33f44d1b0a4e82afb7e139fa`.
The supplied private 0.1.0 draft remains byte-identical at its original untracked path;
the executable product's grounded successor lives here with its source owner.

## Current native workspace increment

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

Current observations: 278 unit tests, the new real SQLite version/permit test, 15 browser checks
and the complete Dev loop passed. The loop includes two separately reviewed theme activations
before the existing single settlement/markup/replay assertions. The 360px mobile vendor page was
visually inspected. The final complete `npm run check:integration` passed after generated types,
storage fingerprints and route-owner validation were updated. Current totals are 91 domain,
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
with `codec_drift` for revision `b3e4a18be9963ff27208b4ce5514a13b09ca77bb2589ed9b26815e5e87a09c0b`.
The generated manifest fingerprints the changed theme mutation code; no SQL objects/classes or
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
