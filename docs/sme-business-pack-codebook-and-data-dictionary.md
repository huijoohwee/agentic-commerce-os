# Business-pack codebook and data dictionary

**Contract:** `sme-business-pack/protocol/v1`  
**Runtime owner:** `public/local-first/sme-business-pack-core.js` and the active module selected by its pack registry  
**Status:** shared contract; currently one provisional pack is enabled

## Scope and ownership

The shared transport, table renderer, editor, and value formatting use the pack protocol rather than country, sector, currency, or field-name defaults. A pack declares its own identity, currency, fields, calculation lines, parameters, ratios, protocols, and review status. The registry is an explicit allowlist; syntactically valid but unregistered pack IDs are refused.

This separates a reusable contract from the current pilot data. The currently enabled pack remains a single provisional specialization. Its presence does not establish that another jurisdiction, sector, or calculation is available or reviewed. The cash-to-close evaluator still implements this task's arithmetic; adding a new task or calculation requires a reviewed contract change.

`pack.protocol` is the UI and tool dictionary. Its `claim_kinds` array is the only field collection used by the workflow table, editor, evidence selector, and field validation. Legacy `pack.required_fields` remains a separate compatibility response; it does not feed the current workflow table.

## Codebook

| Term | Meaning |
|---|---|
| Pack | Versioned, allowlisted declaration with opaque `id`, country/asset metadata, ISO 4217 currency, version, `as_of`, and `review_status`. |
| Claim field | One `claim_kinds` item. `name` is the stable key; `label` is display text; `type`, `required`, optional `unit`, bounds/values, `owner`, and `retiring_tier` describe accepted input and its use. |
| Unknown | No value entered. Rendered as `Unknown · not entered`; it is not zero, false, or an inferred value. |
| Evidence | A dated, person-entered observation attached to one declared field. Evidence is not authenticated or stored by the service. |
| Provenance tier | `seller_stated` and `buyer_assumed` = T0; `observed_on_site`, `measured_on_foot`, and `counted_on_site` = T1; `document_sighted` = T2; `third_party_confirmed` = T3. |
| Observer role | Closed shared vocabulary: `buyer`, `adviser`, `field_checker`. |
| Budget line | Pack-declared output line with an ID, label, source claim fields, optional formula, and retiring tier. It is not another input field. |
| Parameter | A pack-declared, reviewed calculation value separate from buyer input. Empty `parameters` means none are supplied. Do not infer one from a label or example. |
| Ratio | Pack-declared arithmetic relation. Its basis and review flag travel with the value. An unreviewed ratio is an arithmetic observation only, not a benchmark. |
| Tolerance | Pack-declared comparison tolerance. Empty `tolerances` means exact reported differences remain visible without an implicit allowance. |
| Claim status | `discrepancy`, `conflicting_evidence`, `no_discrepancy_found`, or `unsupported`; status describes evidence coverage, not whether a business or price is good. |
| Comparison slot | A buyer-entered record identified by A, B, or C in entry order. A missing slot stays `Not supplied.`; sets are not ranked or normalized. |

## Protocol data dictionary

The `pack.protocol` response contains:

| Key | Shape and use |
|---|---|
| `schema` | Versioned protocol identifier. |
| `pack` | Pack identity and review metadata; currency is declared here and controls all money entry and display. |
| `claim_kinds` | Ordered array of field definitions; the sole dynamic input-field source for the workflow table and editor. |
| `budget_lines` | Ordered output definitions. Each line identifies its input keys and optional deterministic formula. |
| `parameters` | Ordered reviewed pack-level values, separate from buyer inputs. Each declared entry appears as a read-only table column with its parameter metadata/value; an empty array adds no parameter columns. |
| `ratios` | Ordered pack-declared arithmetic relations and their review state. |
| `protocols` | Evidence task, claim key, provenance, tier, and optional effort estimate. |
| `tolerances` | Explicit reviewed tolerance declarations, or an empty array. |
| `review_note` | Human-readable limitation for this pack. It does not replace structured review metadata. |
| `inference_tokens` | Always zero for this deterministic local contract. |

Each claim field is keyed by a lowercase identifier matching `^[a-z][a-z0-9_]{0,63}$`. Runtime validation applies the active pack's exact type, enum, bounds, required status, and evidence target after the generic bounded transport schema accepts the envelope. Money is a whole amount or a low/high range in the pack currency. It is never assigned a default currency.

The enabled provisional pack currently declares these 18 input fields. This inventory is a reader aid only; field order, types, units, allowed values, required flags, and tiers are read from `pack.protocol.claim_kinds` at runtime.

| Field key | Type | Required | Unit or evidence tier |
|---|---|---:|---|
| `listing_source` | enum | yes | pack values |
| `subtype` | enum | yes | pack values |
| `price` | money | yes | T2 |
| `equipment_included` | boolean | yes | — |
| `equipment_cost` | money | yes | T1 |
| `rent_monthly` | money | yes | T3 |
| `lease_remaining_months` | integer | yes | months · T2 |
| `deposit_months` | integer | yes | months of rent · T2 |
| `utilities_deposits` | money | yes | T2 |
| `transfer_cost` | money | yes | T2 |
| `repairs_provision` | money | yes | T1 |
| `monthly_sales` | money | yes | T2 |
| `staff_count` | integer | yes | people · T1 |
| `payroll_monthly` | money | yes | T2 |
| `utilities_monthly` | money | yes | T2 |
| `runway_months` | integer | yes | months · buyer-supplied |
| `variable_cost_bps` | integer | yes | basis points · buyer-supplied |
| `licence_status` | enum | no | pack values · T2 |

The actual response is authoritative if this reader aid and the pack module ever differ. Changes to the protocol require updating this dictionary and its contract checks in the same lane.

## Invocation and interface dictionary

These terms align the pack with shared Agentic OS invocation dictionaries, Canvas discovery/skill contracts, and the AgenticRAG context. They are metadata references, not `sme-business-pack/protocol/v1` fields, business facts, local command definitions, or alternate tool names. The shared dictionaries own `/`, `#`, and `@` token meaning; consumers own execution and proof.

| Term or route | Canonical meaning and pack relationship | Owner and constraint |
|---|---|---|
| AgenticRAG invocation metadata | `invocationToken` is an optional set of already-defined tokens; `artifactFamily` may carry an existing semantic family; `continuityId` identifies related artifacts; `agentSurface` identifies a declared agent interface; `inputSchema` carries a tool's JSON Schema. None are pack fields or execution proofs. | `huijoohwee.github.io/schema/AgenticRAG/v1/context.jsonld` owns the neutral JSON-LD terms and allowed surface values. Resolve `/`, `#`, and `@` terms through the shared Agentic OS dictionaries; do not redefine them here. |
| `/` command token | The canonical invocation grammar selects one command; a command may be accompanied by one `#` semantic and one opaque `@` binding argument. `/sme-care-agent` is a shared source-grounded assistant route, not the local pack check or a tool alias. This pack declares no new slash command. | `agentic-os/docs/INVOCATION.md` and `catalog/dictionaries/DICTIONARY-COMMAND.md` own grammar and command metadata; execution remains with the named consumer. |
| `#` semantic token | A shared semantic filter/classifier; it is not a pack, country, sector, field, or table-view dimension. URL fragment `#sme-workflow` selects the Commerce page section and is not an invocation token. | `catalog/dictionaries/DICTIONARY-SEMANTIC.md` owns token meanings; the Commerce router owns its URL fragment. |
| `@` binding token | A reference to a source, actor, runtime, or boundary. It does not supply credentials, authenticate evidence, or grant tool, publish, or approval authority. The local form check needs no binding. | `catalog/dictionaries/DICTIONARY-BINDING.md` owns binding meanings; do not copy its binding list into this pack dictionary. |
| Existing skill | `agent.sme-care` is catalog metadata for provider-neutral SME source-grounded assistance. It is not an E2E workflow runner, pack calculation, or second pack skill. This pack adds no skill variant. | `agentic-canvas-os/docs/SKILLS.md` owns skill discovery and routing; shared command/semantic/binding references stay in the Agentic OS dictionaries. |
| MCP surface | The service descriptor and `tools/list` expose the pack's canonical `TOOL_NAMES`; explicit `tools/call` dispatches supplied arguments to the shared evaluator. It is stateless and does not read the form's in-memory row. There are no pack-owned MCP resources or prompts. | `src/local-first/sme-business-pack.ts` owns the local HTTP/stdio adapter and bounds. Canvas `MCP-GATEWAY.md` owns discovery-first federation; it is not a pack proxy or duplicate dispatch layer. |
| WebMCP surface | When the browser exposes `modelContext.registerTool` and the user enables registration, the adapter registers the same `TOOL_NAMES` and `TOOL_SCHEMAS` against the same evaluator; disabling unregisters them. Calls use explicit caller arguments and do not read the form's in-memory row. Unsupported WebMCP leaves local/offline checks available. | `public/local-first/sme-business-pack.js` owns optional browser registration. Canvas `MCP-GATEWAY.md` owns federation metadata and uses the existing `@webmcp-surface` / `#webmcp` references for graph-owned browser tools; those references do not add pack-local routing or authority. Capability discovery is not proof that WebMCP is supported or registered. |
| URL and transport paths | `#sme-workflow` is a local route fragment; `/agentic-commerce-os/services/sme-business-pack` selects the Commerce transport. Neither is a shared `/` command or a `#` semantic token. | Commerce owns route and transport mapping; Agentic OS owns invocation parsing. |
| Tool and schema inventory | `TOOL_NAMES` and `TOOL_SCHEMAS` in the shared pack core are the only canonical pack tool/schema inventory; browser, worker, stdio, MCP, and WebMCP adapters reuse them. Legacy client names remain compatibility inputs only. | `public/local-first/sme-business-pack-core.js` owns identity, schemas, validation, and evaluator dispatch. Do not add aliases, skill-local copies, or another registry. |

The pack protocol does not define MCP resources or prompts, slash-command aliases for individual tools, `@` bindings, `#` tags, or skill records. Canonical metadata stays in the existing Agentic OS dictionaries, Canvas `FACTS.md`, `MCP-GATEWAY.md` and `SKILLS.md`, and the AgenticRAG context. Dictionary resolution is metadata-only; each existing runtime owner remains responsible for execution, local proof, and approval boundaries.

## Unified E2E workflow table

The workflow is one Base `multiDimensional` table with one row per active claim set: one set for a local check, or two/three sets for comparison. Every declared `claim_kinds` input is a column after `Claim set`; its title, type, unit, allowed values, bounds, and required flag remain pack-driven. Context columns identify the pack and its review state. Every declared `parameters` item is a read-only column carrying the pack's parameter record; an empty parameter list adds none. The same row then carries input-coverage state; each entered evidence item with claim, value, provenance, observer, date, and tier; calculation state; cash-to-close and other outcome summaries; one status/value column per runtime `budget_lines` entry; arithmetic observations; numeric evidence differences; ordered next checks; and the optional transfer checklist. Missing input stays explicitly unknown and never becomes zero, false, a benchmark, or authenticated evidence.

Selecting a set row opens its single editor for the declared inputs and evidence metadata. The editor is not a second table or an alternate calculation surface. Results are invalidated when inputs change and refresh in place after a local check. With one active set, the same table shows the end-to-end check; with two or three, it shows those comparison records. The shared Base pivot transposes this same table and source projection; the default remains claim sets as rows and all input and workflow fields as columns.

The table reuses the pinned offline `agentic-base` browser adapter and generated `agentic-design-system` Commerce tokens. Commerce owns pack data, editing, validation, derived columns, and route lifecycle. There is one SME table host, one table projection, and one status channel; no separate Results table or duplicated result registry is maintained.

## Tool envelope and limits

The transport schema contains only generic pack IDs, field-key patterns, ISO currency syntax, bounded values, closed evidence metadata, and request-size limits. It does not list the active pack ID, country, sector, currency, or field names. The registry and `pack.protocol` provide those specifics at runtime. Unknown pack identities, mixed comparison identities, unsupported field values, private/free-text keys, invalid evidence, and oversized payloads fail closed.

Local form calculations run on device; their claims and reports stay in memory and clear when the route is left. The form does not send them to a service. An explicit MCP call carries only the caller-supplied bounded arguments to the stateless compute endpoint; an explicit WebMCP call runs the same evaluator in the browser with its supplied arguments. Neither tool reads the form's in-memory state. The versioned pack source, shared protocol, generated table projection, and this dictionary are the only owners for their respective concerns; no parallel pack table, renderer, tool-name inventory, or interface alias is maintained.
