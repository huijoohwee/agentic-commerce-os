---
title: "Reference Implementation — Native Commerce Transfer Ecosystem"
doc_type: "PRD-TAD-ADR-MVP-GTM"
version: "0.2.0"
revision: "0.2.0"
date: "2026-09-23"
lang: "en-US"
frontmatter_contract: "required"
owner: "Commerce product architecture"
continuity_id: "NATIVE-COMMERCE-TRANSFER-001"
prd_revision: "0.2.0"
tad_revision: "0.2.0"
adr_revision: "0.2.0"
mvp_revision: "0.2.0"
gtm_revision: "0.2.0"
local_rung: "undocumented"
delivered_rung: "undocumented"
readiness_scope: "Proposed enhancement; existing sandbox evidence is not inherited"
lane: "authoring"
universal_scope: false
load_policy: "on-demand"
lifecycle_status: "proposed"
runtime_readiness_policy: "fail-closed"
worktree_id: "device-0232231d4a19--native-commerce-transfer-plan"
agent_id: "codex-01a0cda3"
guideline_revision: "3.3.0"
guideline_source_revision: "6f568208d813e46bb1531b326d8a6c70ea9ee8ed"
guideline_sha256: "0c5860a0297823557458b2ebb77d7c7351d32f32b53f9f14f6c015cf42c3a26b"
template_revision: "1.4.0"
template_sha256: "3357f56bd16d4900646ab21209a3e80a39467f942235cd49f51a66e1cba21576"
source_revision: "ee9805d9b159ff1d33cd083efb8602eb1ed68d48"
---

# Reference implementation — native commerce transfer ecosystem

One joined proposal, `NATIVE-COMMERCE-TRANSFER-001@0.2.0`, defines a bounded enhancement to
existing commerce/payment owners and MainPanel Commerce. All concrete repository, provider and
renderer names below describe this reference implementation. No runtime is implemented by this document.
The [architecture companion](prd-tad-adr-mvp-gtm-native-commerce-transfer-architecture.md) owns detailed
interfaces, failure handling, five flows and source evidence at this same revision.
The [reuse companion](prd-tad-adr-mvp-gtm-native-commerce-shared-utils.md) extends T7 with inspected
shared utilities, invocation/skill/command joins, compatibility differences and migration acceptance.

This proposal consumes [the sandbox owner](prd-tad-adr-mvp-gtm-edge-commerce-agent.md) at
`edge-commerce-agent-mvp@0.6.0` and [the first-dollar sprint](prd-tad-adr-mvp-gtm-20260909T1320Z-solopreneur-mvp-gtm.md)
at `PRD-TAD-ADR-COMMERCE-MVP-GTM-001@1.2.0`. It neither supersedes their accepted scope nor
creates a competing general commerce roadmap. R0–R4 below own only this enhancement's increments.
Payment and MainPanel changes must be admitted into their existing Graph plans before implementation;
this is their cross-repository integration proposal, not another payment runtime authority.

**C:** native sources S01–S10 in the companion; the selected MainPanel screenshot on 2026-09-23;
updated shared authoring guideline 3.3.0 and core templates 1.4.0 bound by frontmatter digests. **I:** help a buyer understand,
review and recover a value-moving operation without confusing a configured endpoint with settlement.
**D:** specify the smallest native UI, contract and evidence changes for a zero-spend rehearsal and
condition later transfer execution on capability, authority and verified outcome.
**R:** Commerce product architect. **A:** the architect specifies the native transfer integration.
**O:** a source-bound five-role plan with independently checkable acceptance conditions.
**check:** continuity, source-link, diagram, authored-limit and scoped-diff checks in Evidence References.

## PRD

### Problem, personas and scope

The selected Commerce panel displays endpoint cards and provider settings. S01 confirms this rendering;
it does not measure customer confusion or prove operational readiness. The adjacent native buyer
controller already manages payment state, retry and receipts (S02), creating a small integration opportunity.

| Pain / evidence | Persona and job | Hook → break → fix → close | Reuse / build note |
|---|---|---|---|
| P1: hard to tell what can actually execute; screenshot and S01 show route metadata, buyer pain unvalidated | Buyer or merchant operator reviews one offer/payment | See availability → endpoint labels provide no live proof → show scoped readiness and review → know next safe action | Reuse MainPanel and controller; add a projection, not a second panel |
| P2: interruption can leave an unclear outcome; S02–S05 contain explicit uncertain states, frequency unmeasured | Buyer resumes after timeout/offline | Resume activity → state is unresolved → read/reconcile same operation → see evidence or an honest unresolved result | Reuse queue, CAS and receipt owners; extend tests and binding |
| P3: integration spans browser, tools and provider evidence; S03–S09 show separate contracts, developer pain unvalidated | Developer/operator integrates one merchant workflow | Discover capability → auth and proof differ by surface → one documented contract path → replay a bounded local example | Reuse schemas and tools; defer a new SDK or portal |

Buyer, beneficiary and payer may differ: the buyer requests the operation, a merchant receives the
commerce outcome, and an operator may pay for setup/support. No reachable payer, interview or WTP
evidence was supplied. Rank P1/P2 jointly before P3 because they are closest to the native buyer loop;
this is a dependency/reuse hypothesis, not a commercial ranking based on observed demand.

**0:** source-grounded opportunity with unvalidated demand. **1 (R1 target):** one merchant operator
completes a local review → simulated submit → interrupted resume → simulated activity walkthrough within five
minutes, with zero external money effects. Observe five invited sessions over seven days only after
outreach is separately authorized. First collected dollar and repeat demand remain different outcomes.

### Acceptance and traceability

All criteria below are proposed acceptance conditions. The reuse companion records bounded existing
source tests and the unmerged R1 rehearsal candidate; neither establishes the full financial criteria. Each row is a Given/When/Then VCC; references close
both directions through architecture elements T1–T7 and ADRs A1–A7. A named check is not a pass.

| ID / priority | Given → when → then / VCC | Design / decision / prospective check |
|---|---|---|
| NT-01 Must | Given the existing Commerce tab, when opened on a 360 px browser, then Overview, Pay/transfer, Activity and Developer sections are reachable by keyboard and touch; one top-level Commerce tab remains | T1 / A1 / MainPanel suite plus new viewport/keyboard cases |
| NT-02 Must | Given a selected action and asset, when availability is rendered, then source configuration, current provider readiness and observed result are distinct, each with scope/time; unsupported transfer shows a reason and cannot submit | T1,T2 / A2 / readiness and panel fixture cases |
| NT-03 Must | Given an operation preview, when beneficiary, amount, asset/network, fee, expiry or mode changes, then previous confirmation is invalid; explicit confirmation binds all displayed terms | T2,T3 / A2,A3 / command-digest and expired-confirmation cases |
| NT-04 Must | Given disconnect, double click, retry or another device, when the same principal/operation resumes, then it produces at most one financial effect and never reports offline settlement | T3,T4 / A3 / parallel replay, uncertain-submit and offline cases |
| NT-05 Must | Given an authenticated provider event/read, when identity/amount/asset/finality disagree, then no success or fulfillment is issued; matching evidence updates activity and yields an inspectable receipt | T4,T5 / A3 / ingress, reconciliation and receipt cases |
| NT-06 Must | Given missing/stale policy evidence or a denied capability, when any UI/API/tool attempts an effect, then it fails closed with a safe reason; transport parity cannot bypass confirmation | T2,T6 / A4 / decision matrix and surface parity cases |
| NT-07 Must | Given free local fixtures, when the end-to-end demo runs with networking disabled, then no keys, paid service or chain balance is needed and every result says simulation | T1–T6 / A2,A5 / zero-network rehearsal and production-fixture exclusion |
| NT-08 Should | Given a developer, when following discovery → invoke → duplicate event → receipt, then native schemas/tool names, errors and version rules suffice without a new SDK | T7 / A1,A5 / existing tool-contract tests and timed walkthrough |
| NT-09 Won't (R1) | Given a future real transfer, when activated, then exact provider/account capability, policy/cost authority and independently verified settlement precede any claim of money moved | T2–T6 / A2,A4 / separate provider acceptance; blocked today |
| NT-10 Must (R1a) | Given existing invocation consumers, when selecting a shared utility, then one exact source/export and every affected consumer pin are recorded; observed grammar differences remain explicit | T7/U1–U3 / A6 / source, export and accepted/rejected-input audit |
| NT-11 Must (R1a) | Given old and shared serializers, when valid/invalid conformance cases run in supported Node/browser/edge targets, then catalog/routing bytes, digests, errors and limits retain their declared meaning; incompatible behavior blocks replacement | T7/U2,U3,U6 / A6 / differential corpus, public types, import graph and bundle checks |
| NT-12 Must (R2) | Given the same admitted operation, when reached through supported browser/HTTP/MCP/WebMCP/command/skill entrypoints, then the same owning handler enforces identity, confirmation and effect restrictions; unsupported routes refuse explicitly | T2,T7/U4–U6 / A7 / surface matrix, unknown-route, stale/replayed/cross-principal and absent-API cases |
| NT-13 Must (R1a/R2) | Given a verified replacement, when the consumer switches, then superseded utility bodies are removed, retained shims have callers/retirement checks, the dependency graph stays acyclic and MainPanel simulation remains distinct from live state | T1,T7/U1–U7 / A6,A7 / removed-source, rollback-pin, bundle and MainPanel regression checks |


**Must stories:** buyer reviews an exact operation (NT-01–03); buyer resumes safely (NT-04–05);
operator explains a blocked action (NT-06); developer demonstrates without spending (NT-07).
R1a adds NT-10,11 and the utility portion of NT-13; R2 owns transport/effect NT-12,13.
Should: NT-08 integration polish. Could: a second independently demanded rail after R3 evidence.
Won't this increment: custody/key storage, issuance, exchange, bridges, lending, yield, cards,
investment products, remittance, arbitrary payouts, automated agent spending or live transfers.
ROI for every tier is unmeasured; no financial expansion is justified by a generic ecosystem diagram.

### Success metrics and research gates

| Metric | Baseline | Target / window / check |
|---|---|---|
| TTV steps / elapsed | unmeasured | ≤5 stages / ≤5 min, clean browser rehearsal, R1 evaluation |
| State comprehension | unmeasured | 4/5 invited operators correctly distinguish simulated, pending, paid and unavailable in seven-day study |
| Money effects during R1 | unmerged fixture candidate | zero, intercepted network plus adapter call log; every run |
| Duplicate effects / incorrect paid labels | unmeasured for proposal | zero in fault matrix, before R2 acceptance |
| Local / delivered rung | undocumented / undocumented | spec-complete only after gaps dispositioned; dev-proven only after implemented Must checks |
| Model tokens / invocation | no new AI path | 0 for discovery, policy, payment and receipt; deterministic owners |
| Incremental spend / 12-month cash TCO | account bill and labor unmeasured | $0 incremental authorized spend; local existing-device mode only; no paid fallback |
| Collected cash / contribution margin | no evidence | no target declared achieved; authentic receipt and measured support cost required |

Open questions: actual buyer and existing workaround; willingness to pay; beneficial owner/recipient
verification; supported jurisdictions and obligations; provider transfer entitlement; actual fees;
per-asset finality and refund semantics; tenant scoping; retained-data policy. Each blocks its dependent
effect, not documentation or fixture development. No regulatory thresholds are asserted here.

## TAD

TAD consumes exactly NT-01–13 at `NATIVE-COMMERCE-TRANSFER-001@0.2.0`.
The companion defines T1 MainPanel projection, T2 capability/policy admission, T3 intent/confirmation,
T4 effect/reconciliation, T5 receipt/fulfillment, T6 policy evidence, T7 developer surfaces and shared reuse U1–U7. Reuse decisions stay within those owners; they add no
new generic utility package, skill registry or command dispatcher.
The dependency direction is contract → runtime owner → read projection/UI → proof; integration
receipts bind independently versioned repositories. Runtime request/reply arrows are not build dependencies.

### Ecosystem and ownership

| Participant / value exchange | Native owner / seam | Authority and evidence / gap | Cost, privacy and exit |
|---|---|---|---|
| Buyer receives understandable review and receipt | Graph MainPanel/controller, S01–S02 | Can prepare; effect needs exact confirmation; proposed integrated UX unverified | Device-local drafts; clear/export; no secrets or identity documents |
| Merchant receives order/fulfillment outcome | Commerce CheckoutSession and fulfillment, S06–S07 | Existing confirmation and settlement receipt; no general payout capability implied | Existing store/outbox; disable new action while preserving orders |
| Developer integrates one operation | Graph schema/API/MCP and Commerce tools, S03,S05,S09 | Scoped authentication plus operation authority; discoverability is not access | FOSS client path, zero model calls; versioned compatibility/retirement |
| Agent assists discovery/preparation | Existing MCP/WebMCP adapters, S09 | Read/prepare only in R1; cannot create human-presence proof | Existing bounded tools; unsupported routes explicit; no approval stored offline |
| Payment provider processes an admitted operation | Graph rail adapters, S04 | Current sandbox/collection contracts; transfers and live eligibility absent from this proof | External proprietary seam excluded from FOSS R1; fees unknown, no paid enablement |
| Assurance operator resolves an evidence gap | Graph proposed policy gate beside current admission, S04–S05 | Versioned decision and review reference; no legal certification | Restricted evidence references; deny or re-evaluate, never edit settlement history |
| Platform operator supports recovery | Commerce receipts/markup outbox, Graph event store, S05–S08 | Separate financial outcome, fulfillment and accounting repair | No custody balance store; retain unresolved operations and audit links |

### MainPanel Commerce enhancement contract

The existing Graph MainPanel plan remains the implementation owner (S01). Extend its Commerce tab
and `CommerceHubView`, retaining `mainPanelTabs`, lazy loading, `SettingsView`, theme tokens,
requested anchors, search and browser-local inspection. No second top-level Payments tab or registry.

| Section | Buyer/operator experience | Reuse / required delta |
|---|---|---|
| Overview | Current mode, last observation, enabled actions and the next blocker; no total balance without an authoritative account source | Existing readiness schema stays descriptive; add timestamped result projection through its owner |
| Pay/transfer | Pay an existing offer; prepare a transfer only in simulation; review recipient, amount, asset/network, fees and expiry in plain language | Existing buyer controller; operation-kind discriminator is proposed; live transfer disabled until R3 |
| Activity | Pending, unresolved and completed operations; resume same key; open receipt; explain next action | Existing queue/reconciler/receipt projection; filter by authorized principal and operation |
| Policy details | Safe reason, evidence age and required next action; sensitive evidence visible only to authorized operator | New read projection of T6; no identity uploads or universal green “compliant” badge |
| Developer | Existing endpoint cards, provider settings, tools, schema version and redacted diagnostics | Existing settings/readiness owners, collapsed initially for buyer task; explicit Copy/reveal for truncated values |

At 360/768/1280 px and 200% zoom, review fields wrap without obscuring recipient/amount; controls
have ≥44 px touch targets, visible focus, labelled form errors and textual status announcements.
Opening/closing subviews restores focus and preserves drafts. Search finds section labels and settings;
existing anchor navigation opens the containing section. Color never carries status alone.
Offline access shows cached data with observation time; reconnect first refreshes quote/policy and
requires renewed confirmation if terms expired or changed. Configuration text alone never says “ready”.

### Shared reuse outcome and traceability

P3 includes observed local serializer duplication in Commerce beside existing shared imports in Canvas
and Graph. The reuse companion records exact sources, current consumer pins and input differences.
The first measurable improvement is removal of the two proven-equivalent serializer bodies without
changing wire bytes or introducing a dependency cycle. Integration time and support savings remain
unmeasured. NT-10–13 close the specification gap; runtime proof still requires their named checks.

## ADR

All decisions are **Proposed**, dated 2026-09-23, bound to this revision. Constraints are non-compensatory:
zero spend, FOSS local MVP, native ownership, no copied implementation, explicit money-effect authority.

| ID / context | Decision and alternatives | Consequence, recovery and revisit |
|---|---|---|
| A1: substantial native UI/runtime exists | Extend existing owners. Pass: native projection or unchanged/manual diagnostics. Fail: second commerce app, registry or SDK without observed need. Native projection outranks manual on NT-01–05; demand value unknown | Less migration; cross-owner coordination remains. Remove new projection only; revisit if integration study disproves reuse |
| A2: collection is not arbitrary transfer | Stablecoin-aware contract/preview first; preserve admitted fiat collection. Pass R1: isolated native simulation. Fail R1: live transfer, paid provider, sponsored gas of unknown cost. No silent asset/rail substitution | Zero real effects; no claim of parity with financial services. Disable proposed action; revisit only with R3 prerequisites |
| A3: retries and outcomes cross boundaries | Reuse idempotency, durable CAS, event inbox and markup outbox. Reject optimistic success or a second ledger. Manual readback remains a fallback | Unknown result stays unresolved. Reconcile, never resubmit under a new key; revisit after fault-matrix failures |
| A4: authentication cannot prove every obligation | Deterministic policy decision with provenance and freshness, enforced by execution owner. Reject client-only gate or LLM policy approval; manual case resolution must emit bound evidence | Missing data blocks only dependent effect. Withdraw policy version and re-evaluate pending work; obligations reviewed separately |
| A5: developer ecosystem can outgrow demand | Publish native contract examples and local conformance fixtures first. Defer multi-language SDKs, public marketplace and new portal | Smaller maintenance cost; retain existing interfaces. Revisit after ≥2 independent integration studies show the same gap |
| A6: existing shared invocation owner and local Commerce serializers overlap | Reuse the public OS export after differential conformance; retain typed Commerce API/error adapters and current grammar until compatibility is decided. Reject a new utilities package, copied helper or bulk parser/digest replacement | Delete replaced serializer bodies in the same change; revert the compatible consumer pin/adapter if needed. Revisit on a demonstrated missing contract with two consumers |
| A7: invocation surfaces differ in actual capability and trust | One domain handler/schema per admitted operation, thin transport/view adapters, skills orchestrating existing commands. Keep prepare-only WebMCP, metadata resolution and simulation limits explicit | Consistent domain results without granting absent capabilities. Disable only the new projection; revisit after supported-surface and effect-negative cases pass |


TCO alternatives: existing-device local mode adds no service or package and has a $0 incremental spend
cap; electricity, existing hardware and operator time are unmeasured. Managed edge mode has unknown
account quota/egress/transaction costs and is excluded from R1. Self-hosted always-on mode adds
unmeasured operations and power, so is deferred. Zero model cost does not imply zero total cost.
No evaluated feasible option needs a contested-choice agent pipeline; time-bound decision review is 30 min.

## MVP

R1 targets the UI/fixture subset of NT-01–07 as a clearly labelled local rehearsal; it does not
satisfy multi-device financial replay, provider finality or live policy acceptance. Its unmerged candidate
and failed integration gate are recorded in the reuse companion. R1a targets NT-10,11 and utility NT-13. R2 may bind the admitted existing
sandbox collection path after exact cost/license/authority review. No endpoint, money operation or
deployment is authorized by accepting this proposal. No new always-load modules; lazy-load all additions.

### Roadmap

| Phase / outcome / priority | Reuse and smallest new delta / owner | Prerequisite and exit | Active bounds / stop and recovery |
|---|---|---|---|
| R0 source-bound proposal / now | S01–S10 + shared rules; this joined plan / Commerce architect | Source links, five-role joins, diagrams, documented gaps; no runtime claim | 40 min target, 50 min cap, ≤16 files / 150 KB, 0 runtime modules, $0; stop at scope drift, preserve lane |
| R1 understandable rehearsal / first build | MainPanel + buyer controller/queue; availability/review/activity projection + isolated fixture / Graph UI owner | NT-01–07 local fixture checks only; financial/multi-device proof deferred to R2/R3; no remote requests; obtain study authority separately | ≤2 developer-days, ≤10 changed modules / 80 KB, ≤2 new lazy modules, 0 model calls, $0; stop if a new runtime/store is needed; revert UI adapter |
| R1a compatible utility reuse / next local increment | U1–U3; reuse installed OS export for Commerce catalog/routing serialization; preserve local declaration/error contracts / Commerce invocation owner | NT-10,11 and utility NT-13; exact export, differential corpus, type/bundle proof and deletion evidence; independent of provider wait | ≤1 developer-day, ≤6 modules / 30 KB, 0 new package/service/always-load module, 0 model calls, $0; stop on semantic mismatch; retain old pin/API adapter |
| R2 existing collection integration / next | Existing Graph adapters and Commerce receipt/outbox; bind operation identity and stale-confirmation checks / payment + checkout owners | R1 accepted; current sandbox eligibility and no-spend evidence; NT-12,13 supported-surface matrix and fault cases pass with real test-provider readback | ≤2 days, ≤8 modules / 60 KB, 0 new service; provider wait: entitlement/cost proof, recheck when supplied; disable new entry and retain reconciliation |
| R3 constrained transfer / conditional | Graph payment contract/store/adapter seam; one explicit asset/network/recipient model and policy gate / payment owner | Validated buyer need, exact provider transfer contract, jurisdiction review, cost/FOSS decision, confirmation/finality/reversal evidence, specific effect authority | Estimate only after prerequisites; execution blocked; recheck on evidence/authority change; no gas or fee expense granted |
| R4 developer expansion / deferred | Existing discovery/tool schemas and support path / integration owner | ≥2 independent developers encounter same measured gap, R2 proof and demand evidence | Planning cap 1 day, ≤3 docs / 20 KB; no SDK/service allocation yet; stop if examples suffice |

Order favors P1/P2, existing code and a short setup-service path to first dollar. Provider waits carry
conditions, not completion estimates. R3 cannot leapfrog safety/cost gates to meet a calendar date.
Known deferred ideas remain Won't this increment as listed in PRD; no capability is silently discarded.

### Demo skeleton

| Beat | Time cap | Action / criterion |
|---|---|---|
| Hook | 30 s | Open Commerce and explain available/simulated actions, NT-01–02 |
| Probe | 45 s | Prepare recipient/amount and expose one unavailable policy case, NT-03,06 |
| Reveal | 60 s | Change terms and show confirmation invalidation, NT-03 |
| Review and resume | 120 s | Confirm simulation, disconnect/retry same operation, inspect simulated activity, local subset of NT-04–05,07 |
| Close | 45 s | Show evidence mode and obtain usability feedback; no revenue claim |

Total ≤300 s. The Reveal's VCC is exact-term binding, not a polished static screen. Four maturity
criteria (functionality, innovation/alignment, integration, usefulness) are all **unassessed** for this
enhancement. Graph UI owner supplies recorded device walkthrough; payment owner supplies failure proof;
product owner supplies customer usefulness. No contiguous maturity level is claimed.

## GTM

Reuse the existing first-dollar sprint's S01–S08 and demand verifier. Nearest candidate offer is a
bounded merchant setup/recovery walkthrough using the native buyer loop, conditional on a reachable
operator expressing priced need. Next is integration support after a developer demonstrates a blocker;
transaction take-rate expansion follows verified settlement and distinct customer evidence.
No new price, prospect, market size or collected payment is invented. Outreach is not authorized here.

| Experiment / owner | Evidence and window | Continue / pivot / stop |
|---|---|---|
| Problem and price discovery / product owner | Five authorized operator conversations over seven days; current workaround, frequency, loss, quoted price | Continue if ≥2 name the same costly recovery problem and ≥1 accepts a priced pilot; otherwise revise segment, stop build expansion |
| Activation / UI owner | Five clean mobile/browser rehearsals, timed NT VCCs | Continue if 4/5 finish ≤5 min and none mistake simulation for money moved; fix comprehension before any effect enablement |
| Paid service / sprint owner | Agreed deliverable + authentic collected payment + acceptance + support time; next 14 days after authority | First dollar only after collection receipt; repeat demand only after another independently attributed paid use |

Market sizing remains a gap: bottom-up reachable operators × observed annual demand and an independent
segment population/spend source must be reconciled before audience handoff. No TAM/SAM/SOM claim today.
Financial sketch is incomplete: contribution = collected service price − fees − marginal delivery/support
cost; gross transaction volume is not revenue. Record price, fee, time and cash timing as dated assumptions;
base/downside/upside statements await measured inputs. Bootstrap only; no capital raise, equity ask or
unreviewed financial service offer. Deck/business-plan/model projections are deferred, not fabricated.

### Reuse measurement in the buyer journey

For P3, measure discovery-to-first-correct-invocation time, rejected/repeated attempts and support minutes
before and after R1a/R2 on the same fixture journey. Proposed target: a developer reaches a correct,
inspectable local result within 15 minutes with no newly duplicated serializer; baseline unmeasured.
Observe five authorized walkthroughs over seven days, recording device and source pins. Utility/import
counts alone cannot prove savings, demand or a paid outcome; the existing GTM experiment owns those claims.

## From-0-to-1 coverage

Every row joins this revision. “Covered” means the bounded decision exists, not validated customer or
runtime evidence. Domain dispositions: 16/16; covered applicable: 11/16; deferred: 5; not applicable: 0.

| Domain | Decision / source section | Owner / evidence or gap / next check |
|---|---|---|
| C01 Purpose/pain | covered / PRD | Product / S01 plus unvalidated pain / conversations |
| C02 Market/timing | deferred / GTM | Product / no two-method sizing / research before audience handoff |
| C03 Offer/alternatives | covered / GTM + ADR | Product / conditional setup offer, no WTP / priced pilot |
| C04 Experience | covered / PRD + MainPanel | UI / proposed VCCs / R1 walkthrough |
| C05 Architecture/data | covered / TAD + companion | Architecture / S01–S10 + U1–U7 / source refresh at admission |
| C06 Quality/security | covered / companion | Payment owner / fault matrix pending / R1–R2 |
| C07 Decisions | covered / ADR | Architecture / A1–A7 proposed / implementation baseline review |
| C08 Validated slice | covered / MVP | UI / unmerged fixture candidate; full VCCs unproved / NT-01–13 |
| C09 Acquisition/retention | covered / GTM | Product / experiment only / separately authorized study |
| C10 Operations | covered / companion recovery | Operator / source mechanisms, no new live proof / fault drill |
| C11 Obligations | deferred / T6 | Assurance owner / jurisdiction and evidence providers unknown / before R3 |
| C12 Financial viability | deferred / GTM | Finance function / incomplete driver sketch / observed price/cost and scenarios |
| C13 Capital | covered / GTM | Product / bootstrap decision, no raise / revisit after demand |
| C14 ADLC | covered / Evidence References | Release owner / scoped source work / exact protected receipts |
| C15 Projections | deferred / GTM | Product / no audience request or claim inputs / after C02,C12 |
| C16 Learning | deferred / GTM | Product / no study observations / successor Context after experiment |

## Evidence References

S01–S10 are inspected source evidence, not new runtime proof. The updated guideline is owned in the
[shared guideline 3.3.0](https://github.com/huijoohwee/huijoohwee.github.io/blob/6f568208d813e46bb1531b326d8a6c70ea9ee8ed/guidelines/prd-tad-adr-mvp-gtm-guidelines.md)
and [core templates 1.4.0](https://github.com/huijoohwee/huijoohwee.github.io/blob/6f568208d813e46bb1531b326d8a6c70ea9ee8ed/guidelines/prd-tad-adr-mvp-gtm-templates.md).
The exact source revision and digests bind those reviewed bytes; no guideline copy is vendored here.

Authoring validation and release observations are recorded in the companion's final section. Existing
payment/browser suites are prospective checks unless that section explicitly records their execution.
Must behavior, buyer pain validation, clean-environment TTV and independent implementation evaluation
remain open; therefore frontmatter stays `undocumented`, not prematurely `spec-complete` or runtime-ready.
Selected guideline coverage: ecosystem#1–9, roadmap#1–6 and shared-utilities-and-invocation-reuse#1–7
= 22/22 linked by the ecosystem, T7 reuse, ADR, roadmap and evidence sections; advisory rules in those
sections: 0. This is not whole-set conformance.
PRD→TAD links: 13/13; TAD→PRD owners: 7/7. These ratios are specification traceability only.

Source publication may produce reviewable PRs. Merge, deployment, money movement, cleanup and rollback
each require their own authority and exact receipts. Documentation rollback is a reviewed source revert;
it does not erase existing sandbox history or financial evidence. Keep unmerged lanes for review.
