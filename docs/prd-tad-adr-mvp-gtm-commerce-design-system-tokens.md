---
title: "Commerce Shared Design Token Adoption"
doc_type: "PRD-TAD-ADR-MVP-GTM"
version: "0.1.5"
revision: "0.1.5"
date: "2026-10-31"
updated_date: "2026-10-31"
lang: "en-US"
frontmatter_contract: "required"
owner: "Commerce product function"
continuity_id: "COMMERCE-DESIGN-SYSTEM-TOKENS-001"
prd_revision: "0.1.5"
tad_revision: "0.1.5"
adr_revision: "0.1.5"
mvp_revision: "0.1.5"
gtm_revision: "0.1.5"
local_rung: "spec-complete"
delivered_rung: "undocumented"
lane: "authoring"
universal_scope: false
parent: "docs/prd-tad-adr-mvp-gtm-agentic-commerce-os.md"
parent_version: "0.1.0"
guideline_revision: "3.4.0"
guideline_sha256: "8f0eda9aaf4d0b1e2bcc7388e15d19d95e6ba88fe158dbbbb53c2c0d4225d87a"
template_revision: "1.5.0"
template_sha256: "862369425974a704529164c02973a7ccb98b94d9a4eea73e347c8b4b57aa7966"
worktree_id: "device-0232231d4a19--commerce-design-system-token-plan"
agent_id: "codex"
source_revision: "6ce3bc918717b97a738ac831dfb4fb3319a02fb6"
lifecycle_status: "proposed"
load_policy: "on-demand"
runtime_readiness_policy: "fail-closed"
---

# Commerce Shared Design Token Adoption

**Join:** `COMMERCE-DESIGN-SYSTEM-TOKENS-001@0.1.5`, superseding `0.1.4`, `0.1.3`, `0.1.2`, and `0.1.1` under
`COMMERCE-CONTROL-PLANE-001@0.1.0`. This plan covers Commerce's generated presentation
projections. It does not move product component behavior, commerce capabilities, or deployment
authority into the token registry.

## Reference implementation — Commerce and central registry

The user selected `agentic-design-system` as the intended registry and granted public reuse only of
four exact Graph artifacts at Graph `bed770d91a9b3f1b663eee9637a472bf19b36361`: `kgTokens.ts`,
`typography.ts`, `fontStacks.js`, and generated `kgTokens.generated.css`. No other Graph file or
future revision is covered by that grant. No unrelated reference system is an input or dependency.

| Owner / revision | Observed source and evidence | Boundary |
|---|---|---|
| Commerce / `6ce3bc918717b97a738ac831dfb4fb3319a02fb6` | `public/local-first/commerce-theme.css` is a generated 36-key profile from central revision `c18253b35e8bcc0bed548cfb717ec31909422dbe`, profile digest `000adeb267d0d0ff9527e1227faefcd5fd2c15faee463fa70173204783ea7c9e`, and stylesheet digest `c512ee76dc6160ff41e8bac9706b8e8d0b9e56f42b6c4b128594605e19c93474`. The release builder pins those same bytes. | `c18253b` is not an ancestor of protected central `main`. Protected central `main` at `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283` contains the same 36-key profile bytes and SHA. Rebind provenance to this current integrated commit without changing any key or value. |
| Central registry · protected `main` at `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283` | `DESIGN-TOKEN-ADOPTION-001@0.9.16`; Graph profile JSON SHA-256 `e19a588f6b18aebe7c55e5369930dedd91263905c412c64a42baf28cb04dd64a`; CSS SHA-256 `e4be7fd758ded0ad93437e73d687f5223f44e20e9dfde6384bb446f525775c2c`. | PR #6 introduced the profile at `bc1921bbcf56e1abb11fef2593917e5459d58df1`; PR #7 aligned protected `main` at `1d1a2a3` and its Integration Gate passed. The current profile still contains the same 69 exact-grant Graph keys. PR #5 remains open pending separate disposition and is not required for this pin. |
| Graph / grant source `bed770d91a9b3f1b663eee9637a472bf19b36361`; protected `main` at `8423d340f0e2f99882b90d8d3f71f584a20aae34` | The exact granted generated CSS is 5,982 bytes, SHA-256 `b676d411f7f1683a9b208b2a74f03a921d7e77a32a6f2b4a4274a41c6441dee8`; all four granted file hashes still match at current Graph `main`. | The stale PR #1849 was closed without merge; its clean successor PR #1867 recorded the exact grant and merged at `300815a55d79cdd07dfa4ba2d2a887e810cfa6de`. PRs #1869 and #1870 added no-deploy and delivery records. Graph PR #1239 remains open and changes overlapping token sources, so its owner disposition remains a gate before Graph source work. |
| Commerce Graph adapter / `6ce3bc918717b97a738ac831dfb4fb3319a02fb6` | `config/graph-data-view.json` pins source revision `73ba0401bd785b34bd5331d3873acec0e7b873b3`, input digest `77604d3ce306386213422721835c94d687c19a3ee30b49281c1a3db7c613cd46`, and `graph-ui-tokens.css` SHA-256 `279c32d402518afef25ad46b09441255e6078033b72eacd8b4c78b4730a7f6ca` (6,997 bytes). | All 69 authorized profile keys and values are present; source pin/adoption is still separate. Fifteen adapter-only keys and one responsive override remain unresolved. |

An exact scan of the committed Commerce CSS at the pinned revision finds 84 distinct `--kg-*` keys
in `graph-ui-tokens.css`: all 69 central profile keys are present and their values match after CSS
numeric normalization, with 15 adapter-only keys. The broader generated `graph-data-view.css`
contains 101 distinct `--kg-*` keys, 32 beyond the central profile. The adapter also reassigns
`--kg-control-height` from the profile's `28px` to `var(--kg-touch-target, 44px)` for coarse pointers
or viewports up to 768px; the installed state sets the touch target to `48px`. The profile currently
does not represent that responsive value. Treat it as an unresolved override until it is moved to a
separately owned semantic key or represented by an owner-approved central mode. These counts and
digests are not a rights grant or proof that every additional key is a shared design token. Other
Graph sources remain rights-blocked unless the user or Graph owner approves their exact source scope.
This plan does not copy those values.

The baseline in revision 0.1.0 (81 keys, 19 conflicts, one missing key, 13 adapter-only keys; 98
bundle keys and 29 extras) is not reproduced by a fresh scan of the exact commit and digests above.
Do not use those historical counts as acceptance evidence.

## Current integration gate

Central PR #6 integrated plan `DESIGN-TOKEN-ADOPTION-001@0.9.0`, the 69-key Graph profile,
deterministic CSS projection, and the central AOS PR-integration capability at
`bc1921bbcf56e1abb11fef2593917e5459d58df1`. PR #7 then aligned current protected `main` at
`1d1a2a3f42c261162c83b3b5ecc5aac2a270d283`; its Integration Gate passed. PR #5 remains open pending
separate disposition; it does not supersede the current main pin. This
removes the central candidate integration blocker. Commerce's own `.agentic-os.json` already selects
`protected-integration:pull-request`, and its provider observation reports that PR integration and
the Integration Gate are active. This Commerce plan grants no merge, lane-cleanup, or deployment
authority. The exact Graph rights are integrated through PR #1867 and its delivery records through
#1869 and #1870; the still-open conflicting Graph PR #1239 remains a separate owner gate.

The latest AOS `doctor` run in this plan worktree passes local hook integrity and remote PR-policy
checks. `check:plan` selects the mandatory ADLC, evidence-contract, and named checks for this exact
document. The lane's live publication and integration state is reported by AOS closeout evidence;
this plan revision is not implementation, promotion, or deployment evidence. The canonical Commerce
checkout still contains preserved CSP and other unrelated edits; this lane leaves them untouched.

The Commerce manifest at Graph source revision `73ba0401bd785b34bd5331d3873acec0e7b873b3`
identifies five Graph files that define additional or overridden custom properties. These are
manifest-bound candidate inputs, not a rights grant:

| Graph source | SHA-256 | Observed Commerce impact |
|---|---|---|
| `canvas/src/index.css` | `8b40f685689e917b7376ea6082f5074097f6b37f990d2f8fd6cd31cf70f5a0c2` | Shared-key overrides and adapter-only values. |
| `canvas/src/styles/shared-borders.css` | `829701ef1acc40dc1dc95de5b5d928d97ac76093bed8bca0b3222ab149a6bdd3` | Adapter-only border and shadow values. |
| `canvas/src/styles/application-typography.css` | `d707cf4607d6409bd778194ed2c364cc43e10e321843a4ce3ca8c8e5359d3196` | Additional type variables in the generated bundle. |
| `canvas/src/styles/markdown-data-view-table.css` | `75a026836d9387935213f5bfa7c51abc1ccb6fda19c02ca25e391e16303cab6d` | Additional data-view table variables. |
| `canvas/src/styles/responsive-toolbar.css` | `14f850f4459cf3359e176125b5b7efb18c4762447fa126adbba9559b7198f1d4` | Commerce's manifest-pinned digest is older than current Graph `main` (`d705194c627889d633eb2b890410a3e0a04b51fb8b1c94e172d2da023ae38819`). |

These hashes identify candidate source scope only. They grant no public reuse. The implementation
must bind the complete output to an integrated Graph source revision and matching manifest; it
must not mix the old Commerce `responsive-toolbar.css` digest with the current Graph file.

## PRD

### User, pain, and evidence

**P1 — observed unclassified values; impact unmeasured:** maintainers have one exact central value for
each of the 69 authorized shared Graph profile keys in the committed Commerce adapter, alongside 15
adapter-only keys and a mobile `--kg-control-height` override. The complete generated data-view CSS
has 32 keys outside the central profile. Their ownership and rights are not all established. Repeated
lookup, visual defects, support cost, buyer impact, and willingness to pay have not been measured.

**Users:** Commerce maintainers need one owner for shared values; Graph maintainers need their
component behavior to remain native; reviewers need exact rights, source revision, generated output,
and rollback evidence before an adoption claim.

### Outcomes and acceptance criteria

| ID | Required outcome | Acceptance evidence |
|---|---|---|
| CST-01 | Rebind Commerce's existing 36-key profile to the exact integrated central-main revision without changing any token key or value. | Profile file SHA-256 remains `000adeb267d0d0ff9527e1227faefcd5fd2c15faee463fa70173204783ea7c9e`; parsed token arrays are equal; regenerated CSS and release-builder pin name current protected `main` at `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283` and retain the exact output digest. |
| CST-02 | Use the integrated central Graph profile as the sole source for each authorized shared key in Commerce. | Exact 69-key comparison, zero duplicate definitions or value overrides across emitted Commerce CSS, and candidate/source digests. |
| CST-03 | Classify every remaining `--kg-*` key as a shared token or a Graph component-local variable. | Exact source-path/revision inventory, owner decision, and no unclassified key in a release candidate. |
| CST-04 | Publish only values with a current exact-file reuse grant. | Rights receipt joined to each source digest; absent or stale grants fail closed. |
| CST-05 | Preserve local, offline, mobile, CSP, and accessibility behavior. | Local-first artifact checks plus browser evidence at 320, 360, 640, 768, and 1280 CSS pixels; no runtime network import for token values. |
| CST-06 | Keep delivery separate from source integration. | No deploy, promotion, production readback, or rollback claim without the Commerce release owner’s exact receipts and authority. |

**Success metric:** zero shared-key duplicates, overrides, and unclassified definitions in the exact
Commerce artifact, with the 36-key Commerce profile pinned to integrated central `main`. Reproduced baseline: 84 adapter keys with all 69 authorized shared keys present,
15 adapter-only keys, one conditional override of `--kg-control-height`, and 32 keys outside the
profile in the generated data-view CSS. No value mismatch was found among the 69 shared keys after
CSS numeric normalization. Implementation and user time savings remain unmeasured.

**Observed pin-provenance gap:** Commerce's generated 36-key profile still names `c18253b`, a central
candidate commit that is not an ancestor of protected `main`. The exact profile file and parsed token
payload are identical at current protected `main` `1d1a2a3`; the current Commerce release builder nevertheless
requires the older commit and output digest. Until a bounded successor refreshes that source pin, the
consumer does not prove that its active profile reference resolves through the canonical protected
history. This finding does not establish a token-value conflict or authorize deployment.

**TTV:** a maintainer should identify the single owner and status for a selected shared key within
two minutes from a clean local checkout. This is a target, not a measured result.

## TAD

### Ownership and data boundary

| Concern | Single owner | Consumer contract |
|---|---|---|
| Authorized shared design values | `agentic-design-system`, after protected integration and exact rights evidence | Versioned profile plus deterministic static CSS; no floating reference. Target pin is current integrated central `main` at `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283`; Commerce's current generated output still names non-ancestor `c18253b`. |
| Graph component behavior and component-local values | `agentic-graph` | Remains Graph-owned. Component-local values must be classified and must not override shared profile keys. |
| Commerce shell and artifact assembly | `agentic-commerce-os` | Pins and emits the central profile locally; no runtime fetch, copied editable profile, or competing token file. |
| Release, deploy, runtime, rollback | Commerce's existing release and product owners | Separate evidence and authority for each effect. |

The consumer build may transform an authorized static projection but may not invent central values.
Generated files bind input revision, profile digest, and output digest. Missing source, rights, or
digest evidence blocks emission. Do not add a package, service, cache, or always-loaded module for
this work.

### Commerce profile provenance refresh

The first implementation slice rebinds only the existing Commerce-owned 36-key projection from
`c18253b35e8bcc0bed548cfb717ec31909422dbe` to current integrated central `main`
`1d1a2a3f42c261162c83b3b5ecc5aac2a270d283`.
The profile JSON bytes and parsed key/value pairs are identical at both revisions. Regenerate the
CSS header and update the Commerce release-builder constants to the integrated source revision and
new output digest. Preserve the old CSS digest as the exact predecessor. This slice changes no
Commerce value, Graph adapter, responsive behavior, CSP path, runtime module, or network behavior.
The generated CSS remains a public artifact, so production delivery still requires the Commerce
release owner's exact candidate decision and supported recovery evidence.

### Five flows

1. **User:** open a local-first Graph view → shell loads its pinned CSS → shared keys resolve once →
   component-local styles remain scoped → offline rendering stays available.
2. **Build:** read the integrated central profile and Commerce pin → classify every emitted
   `--kg-*` declaration → reject duplicate/override/unclassified shared keys → emit deterministic
   CSS and a digest-bound receipt.
3. **Data:** central profile values flow to Commerce-generated CSS; Graph's source and behavior remain
   with Graph; Commerce owns only its adapter and generated projection.
4. **Failure/recovery:** stale source, missing rights, mismatch, or output drift stops the build;
   preserve the last known artifact and report the exact missing evidence. Never fall back to an
   unpinned value.
5. **Release:** integrate source → run Commerce's exact artifact and browser checks → obtain a
   separate product-owner deploy decision → read back the same candidate → record the exact
   predecessor or supported recovery before any production effect.

### Data and privacy

Token values are static presentation data. No user, seller, credential, or payment data enters the
registry. Production pages do not fetch token CSS from a moving host. Keep public output limited to
rights-cleared profiles and generated consumer assets; retain private source inventories and
ungranted values inside their owning repository.

### Resource budget

Future implementation slice: at most 8 changed paths, 30 KiB authored delta, 45 active minutes,
zero new runtime modules, zero dependencies, zero model calls, and $0 new provider spend. Keep each
file below 600 lines and each shipped chunk below 500 kB. Lazy-load no new shared runtime code; stop
and refresh the plan if exact rights, inputs, or source revisions drift. These are caps, not measured
savings or an ETA for external review.

## ADR-01 — Central shared keys; native component behavior

**Status:** proposed. Keep authorized shared values in the central registry and consume a pinned
static projection. Leave component behavior with its existing owner. Do not preserve two editable
definitions for a shared key. Component-only variables may remain local only after classification,
scoping, and confirmation that they do not override a shared key.

| Option | Decision |
|---|---|
| Keep the current combined adapter unchanged | Reject as the final state: the bundle has 32 out-of-profile keys and a responsive override not modeled by the central profile. |
| Copy the full Graph adapter into the central repo | Reject: current rights cover four exact artifacts only, and the adapter includes ungranted sources. |
| Centralize authorized shared values and classify local component variables | Select, gated by integrated central/rights PRs, Graph conflict disposition, source inventory, and Commerce owner checks. |
| Stop all work until every Graph value is grantable | Preserve as fail-closed fallback if a needed shared value lacks rights or owner classification. |

**Recovery:** keep the current committed Commerce artifact as the predecessor. A source rollback
restores the exact prior profile pin and generated asset digests and reruns the local artifact check.
`docs/production-runtime.md` states that no generic rollback command exists for its active release
workflow; a CSS change therefore has no assumed production rollback path. Do not deploy until the
product owner supplies an exact, supported recovery procedure and authority.

## ADR-02 — Pin the Commerce profile to protected central history

**Status:** proposed. **Decision:** regenerate the existing 36-key Commerce profile from exact
central protected `main` revision `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283`, preserving its current
profile bytes and token values. Update the generated CSS provenance header and release-builder pin
to that revision; record the new output digest and the current output digest as its predecessor.

| Option | Decision |
|---|---|
| Keep `c18253b` as the source pin | Reject: it is not an ancestor of protected `main`, even though the profile bytes match. |
| Float to a moving branch or fetch token CSS at runtime | Reject: it removes immutable provenance and breaks the local/offline contract. |
| Re-pin the same profile bytes to integrated `1d1a2a3` | Select: the active consumer source points to the current canonical protected history without creating a value variant. |

**Consequences:** generated CSS bytes change because the provenance line changes; the 36 token
declarations and application behavior must remain identical. `c512ee76dc6160ff41e8bac9706b8e8d0b9e56f42b6c4b128594605e19c93474` remains the exact source predecessor. This decision does not resolve the Graph adapter's 69-key source/override gate and grants no deployment or rollback authority.

## MVP

**Phase 0 — Commerce profile provenance:** after this plan revision is integrated, re-pin the
existing 36-key output to current central `main` `1d1a2a3`, preserve all parsed token values, update the generated
CSS and release-builder pin, and retain an exact predecessor/output receipt. This phase does not
touch the Graph adapter or depend on Graph PR disposition.

**Graph-adapter slice:** the exact four-file rights grant is protected-integrated through Graph PR
#1867 and the matching no-deploy/delivery records through #1869/#1870. Migrate only after Graph PR
#1239 has an owner disposition and every emitted Graph custom property is classified. The Commerce
build then consumes the exact central profile for the 69 authorized shared keys, rejects any local
override or duplicate for those keys, and emits a bound predecessor/output receipt. Keep all
component-local behavior in the current Graph adapter; do not claim full Graph-system parity from
the 69-key slice.

**Must checks:** exact protected-main Commerce profile pin; 36-key before/after value identity;
deterministic CSS generation and new output digest; rejection of the non-ancestor `c18253b` pin;
exact 69-key/source digest match for the separately gated Graph slice;
duplicate and override refusal fixtures; complete emitted-CSS inventory; `npm run check:local-first`;
affected integration checks; local browser/offline/responsive inspection; rollback predecessor
readback. Each result belongs to its source or delivery owner. Current values are baseline evidence,
not passed acceptance checks.

Phase 0 closes only the protected Commerce pin, 36-key equality, deterministic output, old-pin
rejection, `npm run check:local-first`, and local offline/browser checks. The 69-key Graph comparison,
rights evidence, override fixtures, and full emitted-CSS classification remain Phase B/C gates.

**Roadmap:**

| Phase | Exit condition | Stop/recovery |
|---|---|---|
| 0 · Commerce profile provenance | `commerce-theme.css` and the release builder pin to current integrated central `main`; all 36 parsed values match the prior output; exact predecessor and regenerated digests are retained. | Keep the current artifact if the profile or token values drift; no deployment. |
| A · rights and owner baseline | Central profile remains pinned to current integrated central `main`; Graph rights PR #1867 is integrated; PR #1239 has an owner disposition; all emitted keys map to exact source and owner; Commerce AOS hook installation and provider preflight pass. | Keep the present Commerce artifact and record the exact blocker. |
| B · shared-key projection | All 69 authorized keys match centrally; no duplicate or override remains in the consumer artifact. | Restore the exact predecessor pin/output; no deployment. |
| C · component boundary | Remaining keys have owner-approved local scope or exact additional grant; local/offline/mobile checks pass. | Leave delivery blocked if any key is unknown or rights are absent. |
| D · release decision | Product owner verifies candidate, predecessor, supported recovery, and environment authority. | No production action from this plan alone. |

**Next bounded action:** after this plan is protected-integrated, start one AOS-bound code lane for the
36-key provenance refresh. Cap it at 8 paths, 30 KiB authored delta, 45 active minutes, zero new
modules, dependencies, model calls, and provider spend. Recheck the exact central revision and
Commerce profile digest immediately before generation. External review or deployment has no ETA;
neither is required to complete the local source slice.

## GTM

This is a free/FOSS maintainer workflow. No paid plan, add-on, overage, model call, new provider, or
hosted token service is in scope. The initial value hypothesis is less drift during multi-repository
maintenance; buyer demand, willingness to pay, time saved, and support reduction remain unvalidated.
Use five timed maintainer tasks before making a savings or monetization claim. Reuse the existing
Commerce learning owner; do not create a second experiment ledger.

## C01–C16 coverage

| Domain | Decision / evidence | Owner and next trigger |
|---|---|---|
| C01 Purpose and pain | Covered: out-of-profile keys and one responsive override observed; user impact unmeasured. | Product · five maintainer tasks. |
| C02 Market and timing | Deferred: no sourced market evidence for this maintenance slice. | Product · only if monetization is proposed. |
| C03 Offer and alternatives | Covered: no-change/manual/FOSS central registry alternatives identified; offer unvalidated. | Product · repeated user pain. |
| C04 Product and experience | Covered: local/offline/mobile and zero-duplicate outcome defined; browser proof pending. | UX · Phase C. |
| C05 Architecture and data | Covered: central profile, Graph component, and Commerce adapter owners separated. | Architecture · Phase A. |
| C06 Quality, security, and AI | Covered: rights, drift, CSP, offline, and $0 limits fail closed; no model calls. | Security · each source change. |
| C07 Decisions and tradeoffs | Covered: ADR-01 selects central shared keys with local component boundary; ADR-02 selects the protected-main Commerce pin. | Architecture · rights/scope drift. |
| C08 Smallest validated slice | Covered: Phase 0 is a provenance-only 36-key pin refresh; the 69-key Graph projection remains gated and unverified. | Product · Phase 0, then Phase B. |
| C09 Acquisition and retention | Deferred: no independent acquisition or retention evidence. | Product · validated offer. |
| C10 Operations | Covered: build, release, and recovery owners named; production rollback remains unproven. | Operations · before deploy. |
| C11 Organization and obligations | Covered with open rights gate: only four exact Graph artifacts are granted. | Product/Graph owner · before more values publish. |
| C12 Financial viability | Covered as $0 incremental spend and 0 model calls; labor/provider savings unknown. | Finance · comparable measurements. |
| C13 Capital and milestones | Not applicable: no capital request or paid service in this slice. | Reopen only if scope changes. |
| C14 ADLC execution | Covered: this successor changes only the plan; the 36-key source refresh, source integration, deploy, and rollback remain separate AOS-bound effects. Central source is integrated and Commerce PR integration is selected in its AOS profile. | ADLC owner · after this plan integrates. |
| C15 Audience projections | Not applicable: this operational adoption plan has no external fundraising audience. | Reopen on audience change. |
| C16 Learning and next increment | Covered: timed maintainer tasks and phase triggers use the existing learning owner. | Product · after Phase B. |

**Coverage:** 16/16 domains dispositioned; 12/12 applicable covered; 2 deferred; 2 not applicable.
Specification coverage does not mean implementation, rights closure, user validation, or release
readiness.

## ADLC and release boundary

Revision 0.1.5 supersedes 0.1.4 and refreshes the protected-main and Graph rights evidence. It keeps
the observed non-ancestor Commerce profile pin and plans a provenance-only rebind to the current
protected-main central profile without changing its 36 values. This revision changes only this
planning document. It does not change the application, generated CSS, Graph sources, CSP work,
package pins, deployment, or production runtime. Central PR #6 integrated at `bc1921b`, and PR #7
aligned current `main` at `1d1a2a3`; PR #5 remains open pending separate disposition. Graph PR #1849
closed without merge, PR #1867 integrated the exact grant, PRs #1869/#1870 record no-deploy/delivery
evidence, and PR #1239 remains an owner gate rather than merge authority.
Source integration of this document
does not grant code, deploy, promotion, or rollback authority. The current delivered rung remains
`undocumented` for this scope.

### Exact-path no-deploy disposition

For this plan revision, the authorized owner role is Commerce product function and the decision is
`no-deploy` for the sole changed path, `docs/prd-tad-adr-mvp-gtm-commerce-design-system-tokens.md`.
This revision changes no application, generated asset, deployment configuration, route, or runtime
state. The observed production static-asset boundary is `./public/local-first` in
`wrangler.local-first.jsonc`; the plan path is outside that asset directory and is not included by
the production Worker configuration. The user delegated this exact docs-only classification for
autonomous resolution. After protected source integration, record the AOS delivery-disposition row
against the exact merge candidate and this document's committed digest. Until then, no delivery
closeout or production claim is made.

## Evidence and references

- Commerce product plan: `docs/prd-tad-adr-mvp-gtm-agentic-commerce-os.md` at
  `6ce3bc918717b97a738ac831dfb4fb3319a02fb6`.
- Commerce adapter manifest: `config/graph-data-view.json` SHA-256
  `c38de561057191a71ccd1b63a4a06cc625164bf67813ee8ac20e07066a3eaa70`.
- Commerce adapter CSS: `public/local-first/graph-ui-tokens.css` SHA-256
  `279c32d402518afef25ad46b09441255e6078033b72eacd8b4c78b4730a7f6ca`.
- Central plan `DESIGN-TOKEN-ADOPTION-001@0.9.16` at protected-main revision
  `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283`, file SHA-256
  `8104b1a17ff0f439747916083b0368b89ec648929c9eb70371ba130540325dc3`; PR #6 introduced the profile and PR #7 aligned
  current `main` with a passing Integration Gate. The profile hashes remain unchanged; PR #5 stays
  open pending separate disposition. Graph PR #1867 records the exact rights grant, with no-deploy
  evidence in #1869 and delivery disposition in #1870; PR #1849 is closed without merge.
- Commerce `commerce-theme.css` currently pins source `c18253b35e8bcc0bed548cfb717ec31909422dbe`,
  output digest `c512ee76dc6160ff41e8bac9706b8e8d0b9e56f42b6c4b128594605e19c93474`, and profile digest
  `000adeb267d0d0ff9527e1227faefcd5fd2c15faee463fa70173204783ea7c9e`. Protected central `main`
  at `1d1a2a3f42c261162c83b3b5ecc5aac2a270d283` contains the identical profile JSON, but the old
  source commit is not an ancestor of that protected revision.
- Graph data-view source revision and output digests are pinned by the Commerce manifest; the
  additional Graph values are not copied into this document or granted for central publication.
