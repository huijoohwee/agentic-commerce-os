---
title: "Reference Implementation — Shared Utility and Invocation Reuse"
doc_type: "PRD-TAD-ADR-MVP-GTM"
artifact_role: "reuse-companion"
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
lane: "authoring"
universal_scope: false
load_policy: "on-demand"
lifecycle_status: "proposed"
runtime_readiness_policy: "fail-closed"
worktree_id: "device-0232231d4a19--native-commerce-transfer-plan"
agent_id: "codex-01a0cda3"
source_revision: "ee9805d9b159ff1d33cd083efb8602eb1ed68d48"
---

# Reference implementation — shared utility and invocation reuse

This companion extends T7 in [the joined plan](prd-tad-adr-mvp-gtm-native-commerce-transfer.md)
at `NATIVE-COMMERCE-TRANSFER-001@0.2.0`. PRD NT-10–13, ADR A6–A7, MVP R1a/R2/R4 and GTM
remain owned there. The [architecture companion](prd-tad-adr-mvp-gtm-native-commerce-transfer-architecture.md)
owns payment effects and five flows. This is a reuse map, not another runtime, catalog or roadmap.
All repository/package/tool names below describe this reference implementation.

## Inspected sources and installed boundaries

Read-only inspection on 2026-09-23. Source commits and installed package pins differ; inspecting an
upstream export does not install it in a consumer. No dependency or lockfile changed in this amendment.

| ID / repository | Exact inspected source | Declared and locked dependency revision |
|---|---|---|
| UO / agentic-os | `f6897811e1e92931e0f03b2737541aba1c4311a2` | Portable owner; source observation, not a new consumer pin |
| UA / agentic-canvas-os | `893bd6b63390e6f31dccc55715283aee675400d0` | OS `2a86d4321edbcc34ea38f3f4718fd4e49b80d153`; Commerce `a632166eb8e4258f55301b5089aa78da663e0d21` |
| UC / agentic-commerce-os | `ee9805d9b159ff1d33cd083efb8602eb1ed68d48` | OS `c99988c7bcd7ef3c8c6a68428af4750e5b7a09cd` |
| UG / agentic-graph | `2524fe6af3f619c0c4b2be5bb59e767e46bbbe71` | OS `1d0000c52f5b4e56e1dced82628d35857f25ba4c` |

Paths in the next table resolve within these exact repository commits. Named public exports must also
resolve at the selected consumer pin before migration. Refresh affected observations when either moves.

## T7 reuse decisions

| ID / capability and criterion | Native source/export and current consumers | Decision / smallest delta and deliberate boundary | Check / replacement disposition |
|---|---|---|---|
| U1 invocation grammar and dictionaries / NT-10 | UO [src/invocation.mjs][invocation], export `agentic-os/invocation`, `catalog/dictionaries/DICTIONARY-{COMMAND,SEMANTIC,BINDING}.md`; UA `scripts/invocation-resolve.mjs`, `scripts/dictionary-catalog-contract.mjs`, `scripts/dictionary-projections.mjs`; UG `mcp/agentic-canvas-os-docs-contract.mjs` | **reuse** existing owner in Canvas/Graph; **retain-local** Commerce declaration validation until compatibility is decided. No second dictionary/regex copied into UI, skills or transport | OS invocation and Canvas consumer tests; one declaration per token. Preserve discovery classification separately from executable parsing |
| U2 catalog/routing digest serialization / NT-10,11 | UO `serializeInvocationCatalogForDigest`, `serializeInvocationRoutingForDigest`; UG aliases already import both; UC [src/invocation/catalog.ts][catalog] locally implements `serializeInvocationCatalog`, `serializeInvocationRouting` | **extend-owner** only if admitted input-domain differences require it; otherwise direct reuse from installed public subpath with Commerce schema argument and typed local adapter. Preserve Commerce normalization, errors and cryptographic verification | Differential valid/invalid corpus before replacing the two local serializer bodies; retain public Commerce exports for callers. No copy or new shared package |
| U3 MCP contract helpers / NT-11 | UO `runtime/adapters/agentic-graph-mcp-contract-utils.js`, export `agentic-os/agents/agentic-graph-mcp-contract-utils`; UA `src/agentic-graph-mcp-contract-utils.js` re-exports bounded text, exact keys, hashes and stable encoding | **reuse** existing Canvas contract shim; **retain-local** UC `src/shared/digest.ts`, `src/shared/http.ts` pending semantic equivalence. Similar names do not prove identical ordering, null/error or object handling | Compare canonical bytes, unsupported values and error contracts before extraction. UO `runtime/json-contract.mjs` via `agentic-os/context/json` already serves UC durable-state transport; it is not automatically the payment digest owner |
| U4 skill proposal, promotion and command admission / NT-12 | UO `runtime/adapters/skill-proposer.js`, `skill-registry-gate.js`, public `agentic-os/agents/*` exports; UA `agent-api/src/skill-proposer.js`, `skill-registry-gate.js` are compatibility exports; `scripts/native-skill-harness-invocation-register.mjs` checks token ownership | **reuse** runtime gates and existing command/tool identities. Skills reference typed commands and exact evidence; no new Commerce skill registry, planner or implicit promotion | OS native-skill-harness tests and Canvas register/import-graph checks; leave proven shims for named callers until consumers migrate and their retirement checks pass |
| U5 Commerce admission / NT-12 | UC `src/admission/commerce-admission-{contract,authority,provider}.js` exported as `agentic-commerce-os/admission/*`; UA same-named `agent-api/src/` files re-export them | **reuse** Commerce domain owner; generic admission/state stays OS-owned. Canvas consumes the locked Commerce export; no Graph or UI dependency added to Commerce package | UC `test/admission/` and Canvas `commerce-admission-provider:check`; exact provider/effect authority remains necessary after shared validation |
| U6 transport and WebMCP projection / NT-11,12 | UC `src/edge/mcp.ts`, `src/edge/capability-authorization.ts`, `src/invocation/capability-map.ts`, `src/edge/client/webmcp-tools.ts`, `webmcp-runtime.ts`; UG `mcp/payment-tool-contract.js` | **retain-local** transport registration and domain policies; **reuse** each domain's handlers/schemas across its admitted surfaces. WebMCP storefront tools and server checkout tools have different capabilities; no forced name or effect parity | Commerce invocation coverage, WebMCP drift/tool tests and Graph payment-tool tests. Unknown mappings fail closed; native browser API absent remains unavailable |
| U7 payment command, readiness, receipts and MainPanel / NT-03–08,13 | UG `grph-shared/src/payments/paymentRuntimeContract.ts`, `agenticPurchaseReadinessContract.ts`, `canvas/src/features/payments/paymentSurfaceController.ts`; S01–S08 in architecture | **reuse** Graph domain contracts/controller for admitted collection; Commerce CheckoutSession owns order confirmation/fulfillment. Share across repositories through the existing versioned provider protocol, not sibling source imports. Keep R1 synthetic store isolated | MainPanel and payment fault cases; no extraction of demo terms/IDs into a live command, no second financial ledger or generalized transfer utility |

The lower-level utility owns syntax/encoding, the domain owner owns meaning and authorization,
the adapter owns I/O and authentication transport, and the view owns presentation. A utility must not
import React, a provider SDK, secrets, a filesystem loader or an effectful storage client merely to
validate a browser request. Browser/edge/Node export compatibility is checked before admitting a pin.
Share business behavior only when it has the same domain meaning; retain an explicit local policy otherwise.

### Compatibility evidence and gaps

A bounded read-only probe compared empty, three-entry and reversed catalogs: all six catalog/routing
serialization comparisons matched between UO and UC. This is not exhaustive equivalence. Existing
property tests exercise current behavior, not the proposed import replacement. Required migration corpus:
empty arrays, reordered entries, Unicode and whitespace, duplicate routes, empty `mcpTools` versus scalar
fallback, missing/unknown fields, wrong types, limits and exact final newline. Retain error codes and
reject-before-dispatch behavior. Hash both byte streams; never substitute a dictionary digest for a
discovery digest: `canonicalCatalogInput` uses kind ordering and no final newline, while discovery uses
token ordering and a final newline.

Observed grammar differences prevent a blind parser swap:

| Input | UC `validateToken` today | UO `parseInvocationToken` today | Migration treatment |
|---|---|---|---|
| `/a_b` | accepts | rejects underscore | Preserve/reject only through an explicit compatibility decision and caller audit |
| `/query:` | accepts | rejects argument on command prefix | Determine whether any admitted catalog declares it; no silent breaking change |
| `@url:https://example.invalid/` | rejects (declarations only) | accepts bounded opaque binding argument | Keep declaration lookup separate from argument parsing and authorization |

UC limits total declaration length to 128; UO bounds name to 128 and binding argument to 1024.
These are observed contracts, not an instruction to broaden Commerce acceptance. No argument is shell
text, ambient authority or permission to fetch a URL. Normalize only through the selected contract.

## Invocation Register joins and skill/command reuse

This table references existing owners; it does not declare additional commands or transfer tools.
`/` means command, `@` binds a target/reference, and `#` supplies semantic scope. Their resolution is
metadata until the owning runtime explicitly admits a supported action.

| Surface / source owner | Current route or identity | Mode and shared execution path | Required conformance / missing capability |
|---|---|---|---|
| Canvas command adapter / U1 | `scripts/invocation-resolve.mjs` with `/`, `@`, `#` | Metadata resolution using shared grammar and packaged dictionary projections | Opaque binding arguments, malformed/duplicate prefix rejection; no payment dispatch implied |
| Graph docs MCP / U1,U2 | `agentic-graph.agentic_canvas_os.docs.invoke` in `mcp/agentic-canvas-os-docs-contract.mjs` | Read-only catalog, source revision and digest projection of the OS dictionaries | Catalog/routing bytes stable; unsupported or incomplete discovery token cannot authorize execution |
| Commerce resolver / U1,U2,U6 | `commerce.invocation.resolve` → `src/invocation/index.ts` | Read-only configured docs MCP projection; verifies source revision, catalog/routing digests and exact entry | Mismatch/session expiry/oversize payload fails closed; offline discovery never implies live readiness |
| Commerce HTTP and MCP / U5,U6 | Existing `commerce.checkout.prepare`, `commerce.checkout.confirm`, `commerce.settlement.get`; `/mcp` and `/mcp/operator` | `capabilityBoundCore` joins mapped action to core authorization; CheckoutSession preserves human confirmation and readback | Role, tenant, stale confirmation and unknown action negative cases; registration hints cannot satisfy authority |
| Commerce WebMCP / U6 | `commerce.catalog.search`, `commerce.offer.select`, `commerce.checkout.initiate` | Existing storefront actions; initiate prepares `awaiting-human-confirmation`, cannot settle | Actual registered schema digest, 2-second registration bound, ≤16 tools, cancellation and absent API fallback to normal controls |
| Graph payment tools / U7 | Existing inventory in `mcp/payment-tool-contract.js` | Domain schema and payment runtime approval gates retained; tool annotations describe capability only | No new transfer name in R1/R1a; real transfer remains R3 admission work |
| Skills and command entrypoints / U1,U4,U5 | Existing `/propose-skill`, `#skill-candidate`, `@skill-registry`, `acos.skill_proposer.propose`, `acos.skill_registry.promote` register joins | Existing proposer/promotion gates; command/skill entrypoint references the same handler and schema | Proposal, promotion and money effect remain separate authorities; no model-assisted skill creation executed by this plan |
| MainPanel Commerce / U7 | Existing Commerce tab and Overview, Pay/transfer, Activity, Developer projection | R1 candidate is local synthetic rehearsal; later admitted collection uses the existing controller and receipt owner | UI does not import CLI, mint authority, expose keys or translate simulation activity into settlement |

Parity means the same admitted operation has consistent domain results, errors and effect restrictions.
It does not require every surface to expose every operation. Server identity, authorization, expiry,
idempotency and receipt checks cannot be replaced by browser hints or a skill's text. Map transport
errors explicitly while retaining safe domain reason codes and correlation IDs; redact sensitive evidence.

## Dependency order and bounded implementation handoff

Public import dependencies (consumer → owner): Canvas → OS; Commerce admission → OS; Canvas →
Commerce admission; Graph → OS. Graph internally owns its shared payment package. Commerce ↔ Graph
runtime requests use versioned protocols; those arrows do not license cyclic package dependencies.
Existing Canvas OS compatibility shims are transport/contract adapters, not permission to copy upstream.

Implementation follows the parent roadmap, with one release unit per affected source owner:

1. R1a: inspect U2 at the actual installed OS pin; establish differential corpus and its public type/runtime
   boundary. Existing OS export first; change OS only for a demonstrated missing contract. Record no-op
   if already equivalent. Do not upgrade unrelated pins or extract U3 on speculative similarity.
2. R1a: replace UC's two serializer bodies with the proven owner export behind its existing public names;
   pin/lock only if the selected compatible export is absent. Delete superseded bodies in the same diff.
   Preserve UC grammar, metadata validation, network limits and `InvocationClientError` vocabulary.
3. R2: after R1 acceptance and provider prerequisites, project admitted collection through existing U6/U7
   handlers. Exercise the same operation across supported transports, and refusals on unsupported ones.
   R1 demo state stays local, ephemeral and explicitly synthetic throughout.
4. R4: admit a new shared utility or skill only after two concrete consumers and repeated integration pain
   justify its maintenance. The source owner publishes checks/export before consumer pins and projections.
   Integrate dependency-first and rerun only affected contracts when source or lock identity changes.

Each unit records exact old/new source, export and lock pins, affected callers, byte/module delta,
check receipt, removed implementation and rollback source. Contract-only shims need a caller list,
retirement trigger and test; they contain no second implementation. Rollback restores a compatible
consumer pin/projection and disables only the new entry. Persisted records and operation keys retain
meaning; any schema change requires its own migration decision. No financial replay or settlement
rollback is inferred from a code revert. No package, registry, SDK or service is introduced by R1a.

## Evidence and remaining limits

Observed local checks on the inspected commits above, 2026-09-23:

| Check | Result and scope |
|---|---|
| UO `node --test __tests__/invocation-core.test.mjs __tests__/invocation.test.mjs` | PASS, 25 tests; syntax, bytes, dictionary limits and existing guarded CLI routes |
| UA `node --test __tests__/shared-invocation-consumer.test.mjs` | PASS, 2 tests; existing shared grammar consumer and binding bounds |
| UG `node --test mcp/__tests__/shared-invocation-core.test.mjs` | PASS, 4 tests; existing digest aliases and import-free browser bundle below 20 KB |
| UC `npm run test:unit -- test/shared/invocation-resolution.property.test.ts test/shared/webmcp-tools.test.ts test/shared/webmcp-drift.property.test.ts` | PASS, 3 files / 7 tests; existing resolution and WebMCP contracts |
| Direct UO/UC source probe | PASS, 6 serializer sample comparisons; 3 grammar differences confirmed in the table above. Full replacement equivalence unverified |

Documentation validation passed the three-role-companion continuity audit (13 criteria, 7 ADRs),
guideline/template digests, 27 exact source links, 35 reuse source paths, authored limits, terminology,
and five-diagram parsing. Shared guideline candidate `6f568208d813e46bb1531b326d8a6c70ea9ee8ed`
passed both required provider checks. These prove the authored contract, not the proposed utility migration.

Commerce's affected local runner on `c847d0791c0c94623e719770ad126bfb5a0617e5` passed ADLC and
evidence-contract groups. Named checks passed through local-first tests (109/109), local browser
fixtures, source and budget checks, then stopped at full-browser preflight:
`podman_workerd_override_required`. This machine lacks a configured verified platform-specific workerd
override; the existing Linux CI owns that setup. No bundled-runtime substitution or paid resource was
used. Final exact-candidate Integration Gate is required; recheck on its receipt or a verified local binary.

The Graph R1 candidate [PR #1211](https://github.com/huijoohwee/agentic-graph/pull/1211) at
`857891c214dc9785ea88a80b7fcbb602e8a75239` has focused local rehearsal evidence. It is unmerged;
[Integration Gate run](https://github.com/huijoohwee/agentic-graph/actions/runs/35849432538) failed in
XR MP4 browser verification (decoded 2.4478 seconds versus authored 2). The failed step is outside
the Commerce diff; no root-cause or production conclusion follows from that observation. NT-04–06
financial/multi-device invariants are not proved by this synthetic UI. Recheck on an exact corrected
candidate; do not promote it or conflate it with the canonical UG source.

This amendment implements documentation only. U2 migration, full cross-surface conformance, measured
integration savings, buyer demand and paid/provider effects remain unproved. No runtime acceptance is
advanced by the source tests above. Documentation checks and exact publication receipts belong to the
review candidate. Runtime work requires the separate R1a/R2 handoff, not a claim that these tables ran it.

[invocation]: https://github.com/huijoohwee/agentic-os/blob/f6897811e1e92931e0f03b2737541aba1c4311a2/src/invocation.mjs
[catalog]: https://github.com/huijoohwee/agentic-commerce-os/blob/ee9805d9b159ff1d33cd083efb8602eb1ed68d48/src/invocation/catalog.ts
