---
title: "Reference Implementation — Commerce Planning Evidence Handoff"
doc_type: "PRD-TAD-ADR-MVP-GTM"
version: "1.2.1"
revision: "1.2.0"
date: "2026-09-12"
lang: "en-US"
frontmatter_contract: "required"
owner: "Commerce verification evidence"
artifact_role: "evidence-companion"
continuity_id: "PRD-TAD-ADR-COMMERCE-MVP-GTM-001"
prd_revision: "1.2.0"
tad_revision: "1.2.0"
adr_revision: "1.2.0"
mvp_revision: "1.2.0"
gtm_revision: "1.2.0"
local_rung: "dev-proven"
delivered_rung: "undocumented"
lane: "authoring"
universal_scope: false
load_policy: "on-demand"
worktree_id: "katrinas-macbook-pro.local--planning-v27"
agent_id: "codex-01a0940a"
source_revision: "50cc1d7e1a81af4ca89c2c4584bc50aee89ec55f"
guideline_revision: "2.7.0"
guideline_source_revision: "e8d2a10a8d3e5735c43edf350a22523df05fdf91"
reviewed_source_revision: "37d1e2a2e3a0efa4f9c5f44c457efa3234d86ad9"
---

# Reference implementation — Commerce planning evidence handoff

This companion owns observations, not requirements. It consumes
[`PRD-TAD-ADR-COMMERCE-MVP-GTM-001@1.2.0`](prd-tad-adr-mvp-gtm-20260909T1320Z-solopreneur-mvp-gtm.md)
and the separate implementation owner
[`edge-commerce-agent-mvp@0.6.0`](prd-tad-adr-mvp-gtm-edge-commerce-agent.md).
The frontmatter rungs apply to the first-dollar sprint. The verified public sandbox does not
promote that sprint's demand, prospect, actual-payment or independent-verifier criteria.
All concrete provider names below are choices of this reference implementation.

## PRD

Consume AC-M01–M09 from the sprint owner and EC-01–EC-10 from the implementation owner.
The current authorized outcome is the sandbox loop; actual collection remains unproven.
Historical 2026-09-09 statements below describe that revision only, including its then-blocked checks.

## TAD

Consume the named owners and evidence mappings from those exact revisions. The public profile uses
`src/local-first/worker.ts`, `checkout.ts`, `stripe-checkout.ts` and existing browser drafts;
the full Edge/Core production runtime retains its own trust, provider and execution gates.
No source, schema, route or release owner is added by this handoff.

## ADR

Consume EC-A1–EC-A6 and ADR-G01–G05. Existing local draft, launch-pack and demand-verifier contracts
remain stable. Selecting a hosted test provider does not select the payment rail for a real prospect.

## MVP

| Evidence | Exact observation | Scope and outcome |
|---|---|---|
| ER-SB-01 | [PR #49][pr49], head `d1eb2f06dff7994c848c0277cac5bea1ffbb6b87`, merged `50cc1d7e1a81af4ca89c2c4584bc50aee89ec55f` | Implemented sandbox runtime and protected integration; no demand claim |
| ER-SB-02 | [Integration Gate][ci49], success; domain 91, unit 278, Worker 60, local-first contracts 53, public browser groups 11, Edge browser 18, Dev loop 1 | Exact candidate source/runtime checks; fixture settlement is synthetic |
| ER-SB-03 | [Protected production release][release49], success, 2026-09-11T22:42:22.889Z | Exact source/version, public route and 11 browser groups; operator approval recorded in protected run |
| ER-SB-04 | Worker `agentic-commerce-edge-production`; version `927f0fa9-8aa2-4a9d-9dcc-1e104220ce3b`; deployment `6de96dff-ff08-45ad-a232-d4ad7bd4f747` | Route `airvio.co/agentic-commerce-os*`; `checkout:sandbox`, `realMoney:false` |
| ER-SB-05 | Official Stripe MCP, account `acct_1TKGGUGzH0w0k4VU`, session `cs_test_a11tryy67pRHwffjdcMAYWZb9mybZTSTre765qNxeOSFn06fEIkFrB1CiE` | `livemode:false`, `status:complete`, `payment_status:paid`, test amount 800, currency `sgd`; independent provider read after hosted UI test |
| ER-SB-06 | Hosted test card ending 0002 declined; 4242 succeeded; return page verified the same session | Test payment only; no customer credentials or real payment details retained |
| ER-SB-07 | Browser `Page.downloadProgress` completed after HTTP 200: `airvio-sandbox-receipt.json` 387 bytes; `airvio-education-materials.md` 8,842 bytes | Actual public receipt and sample delivery, signed browser session; no redirect-only fulfillment |
| ER-SB-08 | Cleanup receipt `79aae25b921fd0b71cfe6e57054fd20457b6f20dcda8ca7131b0af63c31cbcc1`, 2026-09-11T22:49:15.802Z | PR49 worktree/registration quarantined; branches, source and objects retained; main synchronized |

The release run retains artifact `local-first-result-34654936540`: `completion.json`,
`human-authorization.json`, and `live/browser-proof.json`. Completion receipt digest is
`be373fa81639adbb93a4f8cba14cd12edd798c9737dcf54182118fc6f5693e8a`.
The provider/dashboard can re-read ER-SB-05; a new browser needs its own confirmed test session.
No API key, cookie, personal buyer details or real-payment data belongs in source control.

## GTM

| Boundary | Evidence | Current conclusion / next owner action |
|---|---|---|
| Buyer pain and WTP | ER-GTM-01 absent | Unvalidated; solo operator obtains a priced conversation before a paid pilot |
| Offer | Fixed public education sample; private drafts unchanged | Rehearsal offer only; no prospect-selected deliverable |
| Transaction mechanism | ER-SB-02–07 | `mechanism-proven` in sandbox; real payment and revenue absent |
| Fulfillment | ER-SB-07 | Sample delivery proven; customer acceptance absent |
| Runtime | ER-SB-03–04 | Public sandbox production-verified; full agent production remains gated |
| Economics | Zero model calls in native checkout; no added package/resource; no account bill or operator-time study | No measured $0 TCO, ROI improvement or demand-validated label |

Successor work follows S01–S08 in the sprint owner. Keep the historical evidence below intact;
new observations reference exact candidates and do not rewrite earlier check outcomes.

## OKX service evaluation — 2026-09-25

**Verdict:** Graph has a working public retrieval service and a working local graph-analysis
MCP workflow. Commerce has reusable discovery, routing, checkout preparation and merchant
controls, but its currently deployed profile cannot sell those services through remote MCP.
Neither an OKX-integrated workflow nor paid Graph fulfillment through OKX is evidenced.
Proceed with a free A2MCP retrieval pilot; treat monetization as a separate implementation decision.
This dated observation consumes the existing five-role owners above without promoting their rungs,
changing accepted requirements, selecting a production payment rail, or authorizing publication.

### PRD observation: minimum requirements and buyer outcome

Scope authorized by the current request: evaluate Commerce selling Graph services via MCP/WebMCP
against the supplied OKX minimum requirements. No wallet enrollment, listing submission, deployment,
paid call or buyer outreach was requested. Invocation intent is read/inspect through existing MCP
owners; `/tool.route`, `#mcp`, `@mcp-gateway` remain the existing Commerce vocabulary, not new aliases.

| Supplied requirement | Observed evidence | Assessment |
|---|---|---|
| Publish or integrate a working service through OKX AI | Public Graph MCP works directly; no OKX ASP identity, listing or OKX-originated invocation receipt was found in reviewed source/evidence | Not demonstrated; an ordinary public endpoint is insufficient |
| Demonstrate an end-to-end workflow | Live Graph search → fetch succeeded; local official-SDK ingest → query → explain passed | Service-level proof exists; OKX discovery → invocation → result remains unverified |
| Provide service, listing or integration URL | [Graph MCP](https://airvio.co/agentic-graph/mcp) is callable; [Commerce UI](https://airvio.co/agentic-commerce-os/) is a sandbox | Usable service URL exists; it does not establish OKX integration |
| Show the working product in a demo video | Commerce page visually inspected; no qualifying OKX demo video supplied or produced | Still required for submission |

The [OKX ASP tutorial](https://www.okx.ai/tutorial/asp) permits free A2MCP endpoints and requires
x402 for paid calls. Its [A2MCP guide](https://web3.okx.com/onchainos/dev-docs/okxai/howtomcp)
requires public HTTPS; v2 marketplace validation uses the `PAYMENT-REQUIRED` header.
The [registration guide](https://web3.okx.com/onchainos/dev-docs/okxai/registerasp) requests a name,
description, price and endpoint after Agentic Wallet setup. Account/platform state was not inspected;
absence of local registration evidence does not establish that no ASP exists elsewhere.

### TAD observation: existing owners and the missing connection

Source revisions inspected: Commerce `b74536dbcfb49c93f8606a2b57fa4145c320a37c`,
Graph `e113e0e5fc8ec158ba15fa4dfc3e22b1b1a4d56e`,
OS `8bd5c314c23e30bc16de9a0fbb0a4349c3273638`.

| Surface / owner | Existing capability | Limit relevant to selling Graph |
|---|---|---|
| Commerce `src/edge/mcp.ts` | 13 agent tools and 9 operator tools; routing, catalogs, themes and settlement reads | Full Edge/Core source capability is distinct from the deployed local-first profile |
| Commerce `src/edge/client/webmcp-runtime.ts` | Shared catalog search, offer selection and checkout initiation | Preparation only; cannot settle; browser tools are a complementary presentation surface |
| Commerce `src/local-first/worker.ts` | Mobile/offline drafts, merchant workspace and Stripe sandbox | Public MCP POST is refused; no live agent sales in this profile |
| Graph `mcp/agent-graph-tool-contract.js` | `agentic-graph.agent_graph.ingest`, `.query`, `.explain_edge`, `.parser_generate` | Local stdio tools; not exposed by the seven-tool public MCP endpoint |
| Graph `cloudflare/pages/agentic-graph-agent-ready.mjs` | Public search/fetch, source-file/shared-document reads and surface inspection | Retrieval of published material; not a remote graph-analysis execution service |
| Graph `cloudflare/workers/agentic-graph-payment/agenticCommerceX402.ts` | Generic EVM x402 middleware | Handler returns a readiness-probe result, not a purchased graph-analysis deliverable |
| Graph `grph-shared/src/payments/agenticCommercePaidResourceSsot.ts` and payment Worker | Persisted paid-resource implementation with replay/settlement states | Concrete product is XRPL travel requote for `agent-flight`; not Graph analysis or proven OKX compatibility |

Commerce's `commerce.checkout.confirm` intentionally returns `human_confirmation_required`.
Changing its response alone would bypass an existing trust boundary and still would not implement
OKX paid fulfillment. Keep graph execution with Graph, commerce catalog/routing with Commerce,
and protocol payment verification with the existing payment owner. A future narrow adapter should
reuse these owners instead of adding another ledger, registry or orchestration platform.

[WebMCP](https://webmachinelearning.github.io/webmcp/) exposes page JavaScript tools through a
browser model context. It is not itself a remotely callable HTTPS endpoint. No reviewed OKX
documentation establishes direct marketplace invocation of these browser-local tools. Use HTTP
MCP/API for OKX and optional WebMCP for a human-visible storefront, with the same domain handlers.

### ADR recommendation: choose the smallest demonstrable service

1. **Free submission pilot:** list the existing public Graph retrieval service as a free A2MCP
   service, subject to an actual OKX client compatibility check. Draft name: “Graph Source Evidence”.
   Draft description: “Search published source documents and retrieve cited content for agent tasks.”
   Price: 0. Candidate endpoint: `https://airvio.co/agentic-graph/mcp`. Do not advertise private
   repository analysis, transaction capability or paid delivery on this endpoint.
2. **First-dollar product hypothesis:** one bounded dependency/evidence report for a developer's
   approved code snapshot. Reuse local ingest/query/explain; return source locations, snapshot digest
   and explicit unsupported-input diagnostics. Trial price hypothesis: $1 per report, not per raw
   graph edge. Buyer pain and willingness to pay remain unvalidated.
3. **Later paid integration:** expose one bounded remote service over an approved snapshot, join its
   fulfillment to x402 verification/settlement and exact-request replay, then prove it from OKX.
   Use the payment owner to verify facilitator/network/asset support; a network-string change alone
   is not compatibility evidence. Preserve the existing human-confirmed shopper checkout contract.

| Priority | Buyer pain hypothesis | Near-built path | Distance to paid evidence |
|---|---|---|---|
| 1 | Developer cannot explain a dependency/change with source evidence | Local graph ingest/query/explain already works | Remote isolation, bounded delivery and payment binding missing; highest concrete Graph offer |
| 2 | Agent needs reliable published documentation | Live public search/fetch already works | Shortest free OKX demonstration; standalone willingness to pay is weak/unmeasured |
| 3 | Small seller needs agent-discoverable service offers | Commerce catalog/themes/routing and offline workspace exist | Full runtime delivery and provider admission gaps make this a larger marketplace project |
| Defer | Video generation, travel execution or open-ended autonomous tasks | Some contracts/owners exist | External provider, spend and fulfillment dependencies exceed this zero-spend evaluation |

The [OKX seller SDK guide](https://web3.okx.com/onchainos/dev-docs/payments/service-seller-sdk)
documents X Layer mainnet and a testnet alternative. Current Graph EVM defaults are Base Sepolia
(`eip155:84532`) with USDC. The live challenge uses that test network. Mainnet fees, facilitator
support, SDK licensing, deployed service limits and total operator cost require confirmation before
implementation/activation; no new package, hosting plan or funds were used here. Commerce and Graph
MCP source carry MIT licenses; this is not a claim that hosted OKX/Cloudflare services are FOSS.

### MVP evidence: executed observations and bounded next slice

Live observations on 2026-09-25, approximately 03:32–03:36 UTC:

| ID | Request / check | Result and proof boundary |
|---|---|---|
| OKX-E01 | GET Commerce `/readyz` | HTTP 200, `profile:local-first`, `checkout:sandbox`, `paymentStorage:stripe-test`, `realMoney:false`; deployed source `0162872948dbf27d9811daea9e59ffc0b81f9cf3`, Worker `5a4375b1-bc96-4570-a801-655b6640ff17` |
| OKX-E02 | POST Commerce `/mcp`, JSON-RPC initialize | HTTP 501, `checkout_deferred`; deployed agent MCP unavailable |
| OKX-E03 | Graph public MCP initialize and tools/list | HTTP 200; protocol `2025-06-18`; seven read-only tools: `search`, `fetch`, `list_source_files`, `read_source_file`, `read_shared_document`, `inspect_shared_document_structure`, `inspect_agent_surface` |
| OKX-E04 | Graph `search({query:"MCP",limit:3})` then `fetch` of returned first ID | Both HTTP 200; fetched `PROMPT-PRESETS.md`, 27,593 characters, `isError:false`; result contained source URL |
| OKX-E05 | Protected Graph control-plane initialize without credential | HTTP 401 `unauthorized`; no assertion about authenticated tool execution |
| OKX-E06 | GET Graph `/api/payments/commerce/x402`, without payment | HTTP 402 with base64 v2 `payment-required`; `scheme:exact`, `network:eip155:84532`, `amount:1000`, USDC metadata; no payment, settlement or protected fulfillment attempted |
| OKX-E07 | Commerce live browser page and WebMCP discovery | Page says sandbox/no real money and shows local offer preview; this document exposed zero tools to the connected browser's WebMCP discovery |
| OKX-E08 | OS `npm run check` at inspected revision | Evaluators passed; four selected safety suites passed, 28 tests; not the complete 234-suite catalog |
| OKX-E09 | Commerce focused existing unit suites | `edge-mcp`, `webmcp-tools`, `human-confirmation`: 3 files, 11 tests passed; source adapters/mocks, not OKX or live browser conformance |
| OKX-E10 | Graph existing tool-contract and official-SDK stdio suites | 6 tests passed, including local fixture ingest → query → edge explanation; no paid/network model call |

A 402 challenge alone cannot prove settlement or fulfillment. The Pages source also has a
challenge-only response builder; the live response has not been bound to an exact Graph source
revision or its serving Worker. Source/deployment drift must be resolved before treating its
configuration as an accepted paid-service candidate.

Proposed first implementation sprint after a scope decision: 60 active minutes maximum, at most
3 existing runtime modules, 6 changed files, 24 KiB added, each file under 600 lines and each chunk
under 500 kB, zero paid resources/model calls. First attempt the existing free endpoint unchanged;
only add a thin owner-bound API adapter if OKX cannot invoke its JSON-RPC shape. Stop and re-scope
if safe integration needs more. Acceptance: an actual OKX request returns the cited result, the
public service/Agent ID locator is recorded, and a short demo shows that exact workflow.
Marketplace review/account access are external dependencies; recheck upon receipt/status change,
not on a promised completion date. Paid execution is a separate later slice with invalid-proof,
concurrent replay, expiry, interrupted settlement and no-double-charge acceptance tests.

Suggested demo, approximately 90 seconds: show the service/Agent ID in OKX; ask the user's agent
for one published source; show search → fetch and the citation; open the returned document;
show the Commerce product as a clearly labeled complementary storefront; finish with the actual
service URL. For a later paid demo, also show the challenge, approved payment, delivered artifact
and a replay producing the same receipt without another charge. Do not use sandbox payment as
evidence of a collected dollar.

### GTM and release handoff

Technical evaluation is complete; buyer demand, OKX listing, OKX end-to-end delivery and demo-video
submission remain unproven. No production or payment effect was executed. This evaluation adds
one on-demand evidence section, zero runtime modules/dependencies and zero always-load bytes;
the declared report cap is 18 KiB added in one file within a 25-minute assessment window.
Headless assessment: no local UI implementation or dev-server requirement applies.
Use START/RELEASE for this document lane and consumer deployment/rollback gates only for a later
authorized runtime change. Preserve the existing deployment and original historical receipts.

## Historical implementation observation — reference implementation, 2026-09-09

This implements the reusable slice of
[PRD-TAD-ADR-COMMERCE-MVP-GTM-001, revision 1.0.0](https://github.com/huijoohwee/agentic-commerce-os/blob/6e4ce92c48b14cfbc5a0b797901916ef404c4bd4/docs/prd-tad-adr-mvp-gtm-20260909T1320Z-solopreneur-mvp-gtm.md).
Source baseline: Commerce `4774a4fc1543c4bcb1b912fe79c78c61384efc7c`.
User clarification: universal and agnostic. No merchant, segment, price, hosting plan,
payment provider or independent verifier is selected. The adapter is reusable preparation
for S07; S01, prospect delivery and S06 admission still require real evidence.
This handoff consumes the specification; it does not replace its acceptance criteria.

## Scope and budgets

One on-demand Node ESM adapter, fewer than 200 lines, zero dependencies or model calls.
Existing theme, catalog, checkout, WebMCP, offline draft and authoring-claim owners remain
the runtime implementation. No route, store, ledger, ranker catalog entry or deployment
configuration is added. The sprint remains capped at 40 operator hours in 10 working days;
external waits have no completion estimate. Local fixture proof is not buyer validation.

## S04: role profiles over existing tool inventories

The authoritative allowlists are `PUBLIC_MCP_TOOL_NAMES` and `OPERATOR_MCP_TOOL_NAMES`
in [src/edge/mcp.ts](../src/edge/mcp.ts). A caller restricts its own profile to those names;
the server remains responsible for authentication, capability admission and fencing.

| Profile | Transport / allowlist | Authority |
|---|---|---|
| Shopping | `/mcp`; exactly `PUBLIC_MCP_TOOL_NAMES` | Agent authentication; discovery, routing, preparation and reads. `commerce.checkout.confirm` returns `human_confirmation_required` after capability authorization. |
| Merchant operations | `/mcp/operator`; exactly `OPERATOR_MCP_TOOL_NAMES` | Trusted operator only. Register/deregister agents, transition vendors and deploy themes require a current claim, lease epoch and fence revision. This is not merchant self-service. |
| Human checkout | Existing storefront confirmation surface | The person reviews exact facts and confirms through the existing visual flow. Neither MCP role supplies human-presence evidence. |

Claim headers are `x-authoring-semantic-scope`, `x-authoring-claim-id`,
`x-authoring-lease-epoch`, and `x-authoring-fence-revision`.
Claim acquisition bootstraps authority; it does not require a pre-existing claim.
Claim release uses the claimed action path; explicit admission submits its claim body
to the core's existing authority validator without requiring transport claim headers.
Read tools do not acquire mutation authority. `catalogScope` filters discovery; it is
not a merchant authorization boundary. Overlapping writes wait for the existing owner.

Existing checks: `test/shared/edge-mcp.test.ts`,
`test/domain/authoring-claim.property.test.ts`, and `npm run check:invocation-surface`.
Page-level WebMCP tools continue to use `StorefrontActions`; there is no new prompt pack.

## S02–S05: reusable concierge delivery

1. Record S01's named prospect, current workaround/cost, priced signal, acceptance criterion
   and conversation reference. Without them retain `prospect-required`; do not activate a
   synthetic merchant as a completed deliverable.
2. Obtain a merchant identifier, registered agent IDs for `catalogScope`, approved brand
   copy, palette, optional reachable logo and locale. Author the existing `ThemeManifest`;
   optional fields use owner defaults. Validate through `validateThemeManifest`, then use
   `commerce.theme.deploy` with operator authentication and the current claim headers.
   Follow [the Dev walkthrough](demo.md) and [runtime prerequisites](container-runtime.md).
3. On the Dev surface `/s/{merchantId}`, measure from opening the page through search,
   offer selection and guarded checkout preparation to the confirmation surface. Record
   actual action count, elapsed time, candidate identity, viewport and screenshots. Accept
   only at most five actions and ten minutes. Automated fixtures do not replace a timed
   prospect walkthrough; a desktop viewport does not prove a physical phone.
4. Obtain acceptance and agree the invoice amount/currency with the prospect. Collect out
   of band through the operator's selected rail. Record the actual transfer reference,
   collected amount/currency and acceptance note in ER-GTM-03. Do not append that setup
   fee to the derived markup ledger. An invoice or promise alone is not collected money.

No message, invoice, payment or deployment is sent by this handoff.

## S07: independent receipt verifier

[scripts/demand-evidence-verifier.mjs](../scripts/demand-evidence-verifier.mjs) exports
`createDemandEvidenceVerifier` and `paymentAttestationMessage`. The factory supplies the
actual OS callback `verifyDemandEvidence(receipt, context)`, returning exactly
`{ verified, verifier, receipt }`. The specification's abbreviated signature is not the API.

The operator/evaluator host must supply an independently enrolled Ed25519 public key,
its verifier ID, and two trusted synchronous readers. Read through owner-authenticated
transports before invoking the synchronous ranker. Candidate JSON never chooses a key,
module, URL, verifier or executable. Do not fetch a candidate-provided receipt URL.

| Input | Required value |
|---|---|
| OS receipt | Existing `agentic-os-demand-evidence/v1`, including candidate/claim digest, named payer, provider/receipt reference, paid artifact, observation time, current cost and acceptance criterion. |
| OS context | The ranker's exact evidence snapshot digest, candidate ID, claim digest and evaluation timestamp. Do not hash a reserialized receipt as a substitute. |
| `readPaymentAttestation(receipt, context)` | Plain object with exactly `receipt`, `status: collected`, positive safe-integer `amountMinor`, uppercase three-letter `currency`, nonempty `acceptanceNote`, and canonical base64 Ed25519 `signature`. |
| `readDemandEvidence()` | Unwrapped result of `commerce.revenue.demand-evidence.read`: `ok`, nonnegative integer `principalsWithTwoOrMoreSettlements`, `principalIdentityBasis: registered-agent-identifier`, `externalPrincipalDistinction: unvalidated`, `reportedAs: capability`. |

The independent verifier checks the real collection and accepted deliverable before
signing `paymentAttestationMessage(verifierId, receipt, context, payment)` with its own
private key. Those fixed bytes bind the receipt's raw evidence digest, candidate, claim,
payer, payment provider/reference, paid artifact, amount/currency, acceptance note and
verification receipt reference. The message helper only constructs bytes; it never
issues authority. The private key stays with the independent verifier. Trust enrollment,
key rotation/revocation and authenticating the readers remain external owner duties.

The adapter accepts only signatures under the supplied public key. It rejects stale or
future observations, malformed/nonpositive payments, mismatched signatures, asynchronous
reader results, accessor/proxy records, and missing or relabelled demand reads. Rejections
retain the exact OS shape with `verified: false` and a `rejected:<reason>` receipt.
Reader exceptions expose no transport details. Text fields are bounded to 512 UTF-8 bytes.

A zero ledger count is valid for an independently collected setup fee. A large count
never replaces external collection evidence or proves distinct external principals.
Successful verification supports only the named payer and exact candidate; it supplies
neither market demand nor platform take-rate proof.

In the **OS-owned** orchestration host, compose the callback with its existing ranker:

```js
const verifyDemandEvidence = createDemandEvidenceVerifier({
  verifierId, publicKey, readPaymentAttestation, readDemandEvidence,
})
const verdict = rankFeatures(catalog, { root: evidenceRoot, verifyDemandEvidence })
```

The existing `npm run feature:rank` CLI has no adapter-loading flag. Commerce does not
modify that CLI or import OS private modules at runtime. The contract test imports the
pinned ranker implementation solely to verify compatibility. The OS owner must admit a
real candidate and use this callback before S06 can claim an adapter-backed verdict.
The unmodified canonical catalog still has no admissible candidate.

## Evidence and remaining transitions

Record later observations as new rows; do not overwrite earlier evidence. Keep private
financial documents outside version control and record only reviewable references.

| Reference / step | Current disposition | Required next evidence |
|---|---|---|
| ER-GTM-01 / S01 | `prospect-required` | Named prospect, workaround/cost, priced signal and acceptance criterion. |
| ER-GTM-02 / S02–S03 | `prospect-walkthrough-required` | Brand inputs, Dev activation and timed actual prospect walkthrough. |
| ER-GTM-03 / S05 | `external-payment-required` | Accepted deliverable, collected amount/currency and independent receipt reference. |
| S04 | Role mappings documented | Existing role/claim checks; results below. |
| S07 | Adapter implemented; no verifier enrolled | Independent public-key enrollment and authentic receipt/read transports. |
| S06 | `real-candidate-required` | ER-GTM-03 plus OS-owned candidate admission and adapter-backed ranking. |
| S08 | Deferred by ADR-G05 Phase 1 | Phase 2 successor ADR, independent evaluator, owned host/transport, version and route receipts, exact deployment authority. |
| S09 | Review candidate only | Full Integration Gate; protected integration and separate cleanup/sync receipts. |

Delivery remains `undocumented`; no buyer-demand label is upgraded by synthetic tests.

### Local observation — 2026-09-09

| Check | Observed result / scope |
|---|---|
| `node --test test/domain/demand-evidence-verifier.test.mjs` | 10 passed, including the pinned OS ranker join; synthetic independently signed receipts only. Repeated after the final text-bound change. |
| `npm run check` | Types and typecheck passed; 88 domain, 239 unit and 57 Worker tests passed. ADLC/evidence contracts and named source checks passed. Stopped at `check:browser`: `podman_workerd_override_required`. Full check is not green. |
| `node node_modules/@playwright/test/cli.js test` | 11 mobile Chromium component tests passed, including offline replay, visual confirmation and WebMCP. Component coverage only, not the paid Dev loop or a timed prospect walkthrough. |
| `npm run deploy:dev:dry`; `npm run deploy:production:dry` | Passed separately after the aggregate stopped. Production chunks: 196,661 and 487,955 bytes, below 500,000. No deployment performed. |
| `node scripts/checks/browser.ts --dev-only` | Blocked before runtime/artifact creation: verified local workerd override required. |
| `node scripts/checks/evidence.ts` | `evidence_runtime_context_incomplete`; all four runtime inputs missing and zero enrolled dispatch issuers. |
| OS `feature:rank` at `0580b20b48f01eb95dd2a40f3806199b5354f3a9` | `no-admissible-candidate`, five candidates, no selection. This is the baseline CLI without an adapter or real payer. |
| `git diff --check`; authored limits; terminology | Passed. Dependency manifests unchanged; verifier 92 lines. |

Recheck the paid Dev loop when a matching-platform workerd binary has independently
verified build/checksum evidence and its absolute path is supplied as
`MINIFLARE_WORKERD_PATH`. Recheck terminal evidence when the external evaluator supplies
its dispatch trust anchor, trusted Git executable, Canvas source root and isolated
executor, with independently enrolled issuer metadata. Neither condition supplies a
prospect or a payment. Protected CI must verify the exact published candidate separately.

[pr49]: https://github.com/huijoohwee/agentic-commerce-os/pull/49
[ci49]: https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34654535033
[release49]: https://github.com/huijoohwee/agentic-commerce-os/actions/runs/34654936540

## Experience assessment — reference implementation

This assessment consumes `PRD-TAD-ADR-COMMERCE-MVP-GTM-001@1.2.0` and the unchanged criterion and evidence scopes above. Core Requirements & Functionality, Innovation & Theme Alignment, Technical Execution & Integration, and Usefulness & Agentic Experience are **unassessed**: no criterion-scored user observation is attached to this planning revision. Existing sandbox and authoring receipts retain their recorded source, environment and expiry; this assessment neither renews them nor changes their readiness scope.

The document owner must capture one timed pilot in the buyer’s existing workspace, record the four observations using the shared maturity rubric, and measure accepted outcome, actual payment, repeat use and delivery/support cost separately. A successful sandbox checkout proves its declared mechanism only; it cannot establish willingness to pay, a commercial winner or collected customer revenue. Append the learn-loop result as a successor Context through the shared planning owner.
