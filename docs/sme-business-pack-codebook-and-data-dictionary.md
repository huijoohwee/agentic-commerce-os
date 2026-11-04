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
| `parameters` | Ordered reviewed numeric/configuration values, or an empty array. |
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

## Single workflow table

The E2E input workflow is one Base `multiDimensional` table. Its ordered columns are `Claim set` followed by every `claim_kinds` field, using its declared label and unit. Rows are the active A/B/C sets in entry order. Unknown values remain visible. Evidence counts are appended to the corresponding field value; selecting a set opens its one editor and protocol guidance. There is no step-by-step input table, second field matrix, or duplicate claim editor.

The calculated report is a separate Base table because it has a different record shape: report dimensions are rows and claim sets are columns. Base owns that table's native pivot. Both tables use the pinned offline `agentic-base` browser adapter and the generated `agentic-design-system` Commerce tokens; Commerce owns pack data, editing, validation, and route lifecycle. The input table keeps every field in columns by default. No alternative input renderer is registered.

## Tool envelope and limits

The transport schema contains only generic pack IDs, field-key patterns, ISO currency syntax, bounded values, closed evidence metadata, and request-size limits. It does not list the active pack ID, country, sector, currency, or field names. The registry and `pack.protocol` provide those specifics at runtime. Unknown pack identities, mixed comparison identities, unsupported field values, private/free-text keys, invalid evidence, and oversized payloads fail closed.

Calculations run on device. Claims and reports stay in memory, are not sent to a service, and clear when the route is left. The versioned pack source, shared protocol, generated table projection, and this dictionary are the only owners for their respective concerns; no parallel pack table or renderer is maintained.
