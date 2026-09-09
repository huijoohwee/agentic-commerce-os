# Merchant-agnostic MVP-to-GTM handoff

This implements the reusable slice of
[PRD-TAD-ADR-COMMERCE-MVP-GTM-001, revision 1.0.0](https://github.com/huijoohwee/agentic-commerce-os/blob/6e4ce92c48b14cfbc5a0b797901916ef404c4bd4/docs/prd-tad-adr-20260909T1320Z-solopreneur-mvp-gtm.md).
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
