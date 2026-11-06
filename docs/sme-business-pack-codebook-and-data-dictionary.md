# SME plan codebook and data dictionary

Plan contracts: `sme.business-plan@2.3.0`; `sme.takeover-checker@1.2.0`
Status: provisional, user-defined planning contracts
Contract and shared workflow definition owner: `public/local-first/sme-pack-business-plan.js`
Schema, shared evaluator, and registry owner: `public/local-first/sme-business-pack-core.js`

## Plan contracts

The plan contract selector contains one general business plan and one SME takeover checker. Both run inside the existing local-first SME workspace: one mode selector, one Base Multi-dimensional Table, one row editor, one evidence model, one evaluator entry point, and one set of worksheet actions. Selecting a different contract clears row inputs and evidence so values from different schemas cannot mix. The workspace mode defaults to Buy/Build and can be changed to Scenario for either contract; rows stay in entry order and no winner is produced.

The versioned protocol is returned by `pack.protocol` as `sme-business-plan/protocol/v3`. It exposes the active contract's modes, fields, calculation model, outputs, workflow columns, evidence guidance, examples, and optional guideline alignment. The shared tool registry and JSON Schemas are declared once in `sme-business-pack-core.js` and reused by local, worker, MCP, and optional WebMCP adapters. Illustrative values are applied only after the user activates the example-input action; they are never defaults.

Bounded empty or whitespace-only text is unknown across the editor, local/API/MCP builds and worksheet imports. The shared evaluator omits it from supplied inputs, completeness and exports, so missing-context checks remain visible. Blank evidence is refused, and invalid evidence leaves the current worksheet intact during import. Oversized text still fails validation; undeclared fields, including inherited object-property names, are refused.

### General business plan

This contract organizes user-defined venture and organization inputs into pitch roles, business-plan prompts, and single-period financial arithmetic. It makes no location, sector, benchmark, market-data, assumption, inference, or currency-conversion claims. It has twelve pitch roles, four scoped coverage outputs, evidence guidance, and a versioned map to canonical projection requirements. Calculation parameters, ratios, and tolerances are explicitly empty. The author chooses a three-letter currency code per row; concise user notes remain local and unknown values remain unknown.

### SME takeover checker

This contract records user-supplied transfer structure and scope, acquisition and asset inputs, operating figures and their stated basis, location obligations, transition period, working capital, and available cash in the same workflow. Optional context fields do not silently change cash-to-close arithmetic. It computes cash required to close and fund the user-selected period, remaining location payment exposure, cash shortfall, and a clearly labelled monthly revenue-minus-costs arithmetic result when its inputs are present. Required values remain unknown until entered; an explicit `not_applicable` location state is distinct from `unknown`. User-recorded renewal and assignment states are not evidence of legal rights or consent. The contract contains no default location, sector, currency, earnings, price threshold, benchmark, score, valuation, fairness opinion, or recommendation. It declares its own input and evidence prompts, shares the nine workflow columns and two modes, and has no pitch or projection mapping.

## Canonical guideline alignment

For the general business plan, the PRD/TAD/ADR guidelines are the shared parent contract. The Pitch Deck, Business Plan, and Financial Model guidelines own their projection rules; the Venture Record module owns the source registers and required content. The protocol records these exact owner revisions and anchor references. It does not copy their rule text, finding vocabulary, taxonomy, or template schemas into a second registry. The takeover checker declares no projection owners or mapped requirements.

| Owner | Version | Projection responsibility |
|---|---:|---|
| `prd-tad-adr-mvp-gtm-guidelines.md` | 3.4.0 | Scope and neutrality, the shared `continuity_id@revision` join, and C01–C16 |
| `pitch-deck-guidelines.md` | 1.2.0 | Variant, narrative, timing, ask, claim manifest, numbers, Reveal, notes, and delivery |
| `business-plan-guidelines.md` | 1.1.0 | Plan variants and depth, section claims, risks, cross-projection reconciliation, review, and operating use |
| `financial-model-guidelines.md` | 1.1.0 | Model layers, input provenance, headline register, scenarios, actuals, variance, and review |
| `prd-tad-adr-mvp-gtm-venture.md` | 2.1.3 | Slide Register, business-plan Section Contract, Assumption Register, statements, use of funds, capitalization, and scenarios |

Support labels describe this MVP's current surface; they do not weaken the owner contract:

- Aggregate projection states: `outline_only`, `starter_prompts`, and `single_period_arithmetic`.
- Requirement states: `applied`, `partial`, `workspace_only`, and `not_in_mvp`.
- `workspace_only` means views share one active pack revision in this table, but the runtime has not bound them to a parent PRD's actual `continuity_id@revision` record.

| Projection | Current support | Mapped stable keys | Required owner records not represented by the MVP |
|---|---|---|---|
| Pitch deck | `outline_only` | `problem_statement`, `target_customer`, `solution_offer`, `market_definition`, `market_basis`, `business_model`, `go_to_market`, `progress_evidence`, `team_capabilities`, `milestones`, `funding_requested`, `use_of_funds`, and selected financial inputs | Variant Register; audience decision and time budget; complete Slide Register evidence/bounds; Claim Manifest; VCC-bound Reveal/runbook; rehearsal; notes, objections, authorization, delivery and outcome log |
| Business plan | `starter_prompts` | Problem, customer, offer, market notes, business model, acquisition notes, team, risks, milestones, and selected funding inputs | Full Section Contract and dispositions; plan variants/depth; two-method market sizing; Section Claim Record; structured risk register; legal/domain reviews; cross-projection reconciliation; operating and outcome records |
| Financial model | `single_period_arithmetic` | User currency, price, volume, variable/fixed cost, payroll, setup cost, available cash, runway target, funding considered, and use of funds | Dated low/base/high Assumption Register; measurement basis and monthly horizon; driver schedules; unit economics; linked income, cash-flow and balance-sheet statements; Headline Register; Base/Downside/Upside and sensitivity; cash-floor contingencies; actuals/variance/reforecast; ADLC Cost Ledger; independent review |

`guideline_alignment` is metadata for one dictionary projection, not new user inputs or a second workflow. `partial` and `not_in_mvp` rows remain visible so missing owner records are not implied to exist. In Buy/Build mode, A/B/C are ordered user-entered plan options. In Scenario mode, A/B/C are ordered user-entered scenarios. Neither represents the guidelines' Base/Downside/Upside Scenario Set. Monthly arithmetic is not a forecast or a linked statement model. The pitch output is an outline, not a rendered or deliverable deck. No projection claims readiness, demand, viability, or guideline conformance on its own.

The owner contract requires all three projections to belong to one source revision and one `continuity_id@revision`. This workspace currently shares its active pack revision across the displayed projections but does not bind to an actual parent PRD identity; the dictionary reports that as `workspace_only`. Every number or claim still needs its owner's source, evidence label, and revision. An absent value stays unknown; no currency, benchmark, market figure, conversion, forecast, reviewer, or evidence status is inferred.

## Workflow modes

`mode` is a workspace-level value in build and compare requests, reports, and worksheets. It is not duplicated as a user-editable input on every row. Omitting it selects the single declared default. The selector preserves row values when switching modes and marks derived outputs stale until rebuilt.

| Mode key | Label | Default | Row label | Required path fields |
|---|---|---:|---|---|
| `buy_build` | Buy/Build | Yes | Plan option | `buy_build_path`; when `buy_existing`, `acquisition_price` and `transition_costs` |
| `scenario` | Scenario | No | Scenario | No Buy/Build path is required; any values supplied use the same validation and calculation rules |

## General business plan input field codebook

Blank optional values are not zero, false, or a model estimate. Mode-required and path-required fields contribute to completeness only when their conditions apply; the evaluator still returns a partial plan when they are absent. `text` values are at most 280 characters (venture name: 80) and reject URL, email, and phone patterns. `money` is a nonnegative amount or inclusive low/high range, up to 1,000,000,000 with four decimal places. `integer` values are whole numbers within their declared bounds. `currency` is a user-selected uppercase three-letter code; no conversion is applied.

| Stable key | Field | Section | Type / unit | Required | Limits or allowed values |
|---|---|---|---|---:|---|
| `venture_name` | Venture or project name | Venture | text | No | 80 characters |
| `venture_stage` | Current stage | Venture | enum | Yes | idea, discovery, validation, pre-launch, operating, growth, other |
| `problem_statement` | Problem or need | Pitch | text | Yes | 280 characters |
| `target_customer` | Intended customer or beneficiary | Pitch | text | Yes | 280 characters |
| `solution_offer` | Product, service, or offer | Pitch | text | Yes | 280 characters |
| `value_proposition` | Value proposition | Pitch | text | No | 280 characters |
| `market_definition` | Market definition and scope | Market | text | No | 280 characters; user-supplied basis |
| `market_basis` | Market evidence or basis | Market | text | No | 280 characters; cite the user's own offline source in notes |
| `business_model` | Revenue or operating model | Business plan | text | Yes | 280 characters |
| `go_to_market` | Customer access and delivery plan | Business plan | text | Yes | 280 characters |
| `progress_evidence` | Progress, tests, or traction evidence | Evidence | text | No | 280 characters; not authenticated |
| `team_capabilities` | Team capabilities and gaps | Operations | text | No | 280 characters |
| `key_risks` | Key risks and open assumptions | Risk | text | Yes | 280 characters |
| `milestones` | Next milestones and measures | Execution | text | Yes | 280 characters |
| `currency_code` | Model currency code | Financial model | currency | Yes | Three uppercase letters; no conversion |
| `buy_build_path` | Buy/Build approach | Buy/Build | enum | Buy/Build mode | `buy_existing`, `build_new`, `undecided` |
| `acquisition_price` | Existing business or asset purchase price | Buy/Build | money / selected currency | When path is `buy_existing` | One amount or low/high range |
| `transition_costs` | Acquisition and transition costs | Buy/Build | money / selected currency | When path is `buy_existing` | One amount or low/high range; enter zero only when established |
| `price_per_unit` | Price per unit or billing interval | Financial model | money / selected currency | No | One amount or low/high range |
| `units_per_month` | Units or billable events per month | Financial model | integer / units per month | No | 0–100,000,000 |
| `variable_cost_per_unit` | Variable cost per unit | Financial model | money / selected currency | No | One amount or low/high range |
| `fixed_costs_per_month` | Other fixed costs per month | Financial model | money / selected currency per month | No | One amount or low/high range |
| `payroll_per_month` | Team and contractor cost per month | Financial model | money / selected currency per month | No | One amount or low/high range |
| `setup_costs` | Build, setup and launch costs | Funding | money / selected currency | No | One amount or low/high range |
| `cash_available` | Cash available for this plan | Funding | money / selected currency | No | One amount or low/high range |
| `runway_target_months` | Planning runway | Funding | integer / months | No | 1–120 |
| `funding_requested` | Funding amount under consideration | Funding | money / selected currency | No | One amount or low/high range |
| `use_of_funds` | Proposed use of funds | Funding | text | No | 280 characters |

## SME takeover checker input field codebook

All money uses the row's user-selected ISO 4217 currency code, accepts a nonnegative amount or low/high range, and is never converted. Blank required values remain unknown. Location fields are conditional on `location_obligation=applies`; `not_applicable` and `unknown` are separate states.

| Stable key | Field | Section | Type / unit | Required | Limits or allowed values |
|---|---|---|---|---:|---|
| `currency_code` | Currency code | Measurement | currency / ISO 4217 | Yes | Three uppercase letters; no conversion |
| `transaction_structure` | Transfer structure | Acquisition | enum | No | `asset_transfer`, `entity_interest`, `other`, `unknown` |
| `purchase_price` | Business or asset purchase price | Acquisition | money / selected currency | Yes | User-supplied transfer amount; describe included and excluded scope; nonnegative single amount or range |
| `included_items` | Items or rights included | Acquisition | text | No | Up to 280 characters; user-described |
| `excluded_items` | Items or rights excluded | Acquisition | text | No | Up to 280 characters; user-described |
| `transition_costs` | Transition costs | Acquisition | money / selected currency | Yes | Additional outlay, excluding transfer price, transaction costs, and immediate reinvestment |
| `asset_setup_costs` | Additional asset acquisition and setup outlay | Acquisition | money / selected currency | Yes | Beyond transfer amount; do not double-count included items |
| `equipment_resale_estimate` | User-entered equipment resale estimate | Acquisition | money / selected currency | No | Single amount or low/high range; user-supplied basis |
| `improvements_current_estimate` | User-entered current improvements estimate | Acquisition | money / selected currency | No | Single amount or low/high range; user-supplied basis |
| `improvements_reference_year` | Improvements reference year | Acquisition | integer / year | No | 1800–3000 |
| `transaction_professional_costs` | Transaction and professional costs | Acquisition | money / selected currency | Yes | Nonnegative single amount or low/high range |
| `immediate_reinvestment_costs` | Immediate repairs or reinvestment | Acquisition | money / selected currency | Yes | Nonnegative single amount or low/high range |
| `handover_months` | User-stated handover period | Transition | integer / months | No | 0–1,200 |
| `monthly_revenue` | User-entered monthly revenue | Operating information | money / selected currency per month | No | Single amount or low/high range |
| `financial_basis` | Financial information basis | Operating information | enum | No | `historical_records`, `current_estimate`, `forward_estimate`, `unknown` |
| `financial_period_months` | Financial information period covered | Operating information | integer / months | No | 1–1,200 |
| `location_obligation` | Location payment obligation | Location | enum | Yes | `applies`, `not_applicable`, `unknown` |
| `location_deposit` | Location deposit | Location | money / selected currency | When applicable | Nonnegative single amount or low/high range |
| `location_monthly_cost` | Location cost per month | Location | money / selected currency per month | When applicable | Nonnegative single amount or low/high range |
| `location_term_months` | Location term remaining | Location | integer / months | When applicable | 0–1,200 whole months |
| `location_renewal_months` | User-stated location renewal period | Location | integer / months | No | 0–1,200; blank remains unknown |
| `location_assignment_status` | User-stated location assignment status | Location | enum | No | `reported_available`, `reported_not_available`, `conditional`, `unknown`; not authenticated |
| `monthly_operating_costs` | Monthly operating costs excluding location | Working capital | money / selected currency per month | Yes | Nonnegative single amount or low/high range |
| `working_capital_months` | Working capital period | Working capital | integer / months | Yes | 0–120 whole months |
| `available_cash` | Cash available for the acquisition | Funding | money / selected currency | Yes | Nonnegative single amount or low/high range |
| `opportunity_label` | Private opportunity alias | Opportunity | text | No | 80 characters |
| `business_activity` | User-described business activity | Opportunity | text | No | 120 characters |
| `operating_area` | Broad operating area | Opportunity | text | No | 120 characters |
| `transfer_reason` | User-recorded transfer reason | Opportunity | text | No | 280 characters |
| `buyer_budget` | Stated buyer budget | Buyer context | money / selected currency | No | Single amount or low/high range |
| `target_handover_months` | Desired time until handover | Buyer context | integer / months | No | 0–120 |
| `operator_experience` | User-stated operator experience | Buyer context | enum | No | `none_reported`, `related_reported`, `direct_reported`, `unknown` |
| `accounts_access` | User-stated accounts access | Review | enum | No | `not_requested`, `requested`, `reported_available`, `reviewed_by_user`, `reported_unavailable`, `unknown` |
| `permission_transfer_status` | User-stated operating permission context | Review | enum | No | `not_applicable`, `not_checked`, `reported_transferable`, `reported_new_application`, `conditional`, `unknown` |
| `team_continuity` | User-stated team continuity | Transition | enum | No | `not_applicable`, `not_discussed`, `reported_continuing`, `reported_changing`, `unknown` |
| `support_scope` | User-stated handover support | Transition | text | No | 280 characters |
| `review_stage` | User-selected review stage | Review | enum | No | `captured`, `clarifying`, `reviewing`, `handover_planning`, `paused`, `closed_by_user`, `unknown` |
| `next_action` | User-authored next action | Review | text | No | 280 characters |

The thirteen optional acquisition-review fields extend this contract under [sme-business-pack@1.5.0](https://github.com/huijoohwee/joohwee/blob/79f856571519749ba89c573cb034d5413de3a129/undocumented-draft/prd-tad-adr-mvp-gtm-sme-business-pack-mcp.md). The live protocol remains their definition owner. Buyer budget, desired timing and manual review stage never change cash arithmetic, satisfy missing prerequisites or authorize an effect. Accounts access, operating permissions, team continuity and support use the existing evidence prompts and next-check projection; all statuses are user assertions. `next_action` remains a separate user-authored input.

## Model output codebook

Every output is a deterministic arithmetic result from explicit inputs. Missing or unbounded prerequisites yield an unknown display and a list of required inputs. A range remains a range through calculations. No output is a forecast, probability, valuation, recommendation, accounting statement, or sector benchmark.

| Stable key | Output | Inputs | Formula |
|---|---|---|---|
| `monthly_revenue` | Revenue per month | `price_per_unit`, `units_per_month` | price × monthly units |
| `monthly_variable_cost` | Variable costs per month | `variable_cost_per_unit`, `units_per_month` | variable cost × monthly units |
| `monthly_contribution` | Contribution after variable costs | `monthly_revenue`, `monthly_variable_cost` | revenue − variable costs |
| `monthly_operating_costs` | Operating costs per month | `fixed_costs_per_month`, `payroll_per_month` | fixed costs + payroll |
| `monthly_operating_result` | Operating result per month | `monthly_contribution`, `monthly_operating_costs` | contribution − operating costs |
| `break_even_units` | Break-even volume | price, variable cost, fixed costs, payroll | operating costs ÷ positive contribution per unit; rounded up |
| `runway` | Cash runway | cash available, monthly operating result | cash ÷ positive monthly burn; no-burn and zero-crossing states remain explicit |
| `funding_gap` | Funding need for entered runway | Buy/Build path, path-specific costs, runway, operating result, cash available | max(0, acquisition price + transition costs for buy-existing, or build/setup costs for build-new, plus positive monthly burn × entered months, minus available cash); unknown until path and applicable costs are supplied |
| `funding_requested_difference` | Proposed funding minus modeled need | requested funding, funding gap | funding requested − path-specific funding need calculated from entered runway |

### SME takeover checker outputs

| Stable key | Output | Inputs | Formula |
|---|---|---|---|
| `cash_to_close` | Cash required to close and fund the selected period | Purchase, transition, asset/setup, transaction/professional, immediate reinvestment, applicable location deposit and monthly cost, operating costs, working-capital months, currency | Purchase + transition + asset/setup + transaction/professional + immediate reinvestment + applicable deposit + (monthly operating costs + applicable location cost) × selected months |
| `location_exposure` | Remaining location payment exposure | Obligation status, monthly location cost, remaining term, currency | Monthly location cost × remaining term; `Not applicable` only when explicitly selected |
| `cash_shortfall` | Cash shortfall after available cash | Cash-to-close inputs and available cash | max(0, cash required to close and fund the selected period − available cash) |
| `operating_difference_per_month` | User-entered monthly revenue less listed monthly costs | User-entered monthly revenue, monthly operating costs, location status and applicable location cost | Monthly revenue − monthly operating costs − applicable location cost; arithmetic only, not a profit claim |

Outputs are arithmetic on user-entered amounts. Missing inputs keep an output unknown; a low/high range propagates through the calculation. None is a price opinion, valuation, forecast, accounting result, or recommendation.

## Evidence and readiness

Evidence rows use `{ field_key, value, provenance, observer_role, date }`. Provenance is one of `assumption`, `self_reported`, `directly_observed`, `counted`, `document_reviewed`, or `independently_reported`. Observer role is `author`, `observer`, or `reviewer`. These labels describe how a person recorded context; they do not authenticate it or prove the underlying value. The protocol supplies field-specific prompts. The table exposes evidence values, provenance, observer role, date, and unauthenticated status as separate columns; multiple records remain grouped by their input key within each facet.

The E2E table also projects required-input completeness, invalid entries, coverage for pitch, business-plan, financial-model, and evidence prompts, every model output, each of the twelve pitch-role outputs, and ordered next checks. Coverage reports mapped requirements and supplied inputs within the MVP's declared scope; it is not a quality, readiness, verification, or guideline-conformance decision. Roles are coverage obligations and may be combined in a final deck; the outline is not a fixed slide count. Role content is traced to declared input keys and calculated output keys; it does not fill gaps with generated facts. Markdown export contains the mode, outline, financial model, and plan data. Next checks name missing model inputs or optional narrative context; they do not prescribe financing or claim a venture is viable. The selected row editor edits the same row's fields and evidence. There is no separate checklist or results model.

## Table contract

The E2E workspace renders one shared `multiDimensional` table. Its mode selector defaults to Buy/Build and also offers Scenario; its contract selector offers the two registry entries. Rows are plan options A, B, and C in Buy/Build mode, or scenarios A, B, and C in Scenario mode; rows remain in entry order. Columns include the row key, selected mode, every active contract input, every shared workflow column, each active coverage measure, every active model output, optional pitch roles, and next checks. Each input keeps its protocol key as the stable column ID. The metadata pivot exposes field attributes in separate columns and nests records by type, section and group through Base. Workflow, coverage, model, and pitch labels follow family and facet paths down to the field and stable protocol key. The Data dictionary presents the same protocol fields in native nested contract and section groups. These labels and groups make field purpose and ownership inspectable in either pivot without adding duplicate columns or a second workflow view. Evidence facets remain separate workflow columns; each recorded cell retains the input key and label beside its user-entered value or evidence attribute. The Base adapter's 64-column bound is preserved: general plan uses 64 columns and takeover uses 61 (38 inputs and seven protocol-owned review parameters). Tool input schemas admit at most 38 properties; the evaluator further limits keys to the selected contract's declared fields. Request/response limits remain 32/64 KB, and Base retains 4,096 characters per cell and 196,608 bytes per view. Exceeding a bound reports a limit without deleting entered input.

The general plan's Buy/Build mode requires a user-selected path; the takeover checker requires explicit acquisition costs and an explicit location-obligation state, with applicable location amounts required only when selected. The selected-row editor edits these same inputs and evidence records; the same Base adapter supplies pivoting, and local worksheet actions remain attached to this workflow. One row builds a draft; two or three compare entered rows in the selected mode. Comparison requires a shared contract ID/version, mode, and currency code. Each takeover operating result includes its user-stated basis and period. Missing, unknown or differing bases/periods produce a non-comparability next check while retaining each row’s cash arithmetic. Unknown location obligations keep affected arithmetic unknown; explicit zero purchase price does not erase other outlays. It preserves order and does not rank, sort, score, choose a winner, or convert currency. Scenario rows are not Base/Downside/Upside cases. Pivoting changes only the orientation of that same table.

The Data dictionary route renders a read-only `multiDimensional` table generated from the live protocol. Base nested rows group records by contract, input section, output family, projection role, evidence guidance, and canonical owner. Group rows are display structure only; they do not declare extra inputs, calculations, evidence, or requirements. It documents each input, output, artifact, evidence rule, guideline owner and projection-support status, tool schema, empty optional collection, and shared vocabulary owner. This remains the dictionary surface, separate from the single workflow table and its calculation surface.

### One schema across Plan options, Review steps and Gantt

`pack.protocol.review_workflow` owns view labels, step guidance, focus-field references and the view-note exchange contract. Each existing `input_fields` definition has one `review_step` association; all 38 takeover inputs are covered exactly once. Review steps changes their grouping. Gantt replaces the field table in the same workflow host using the native Graph timeline; it does not render a companion table. Returning to table views reuses the existing Plan options metadata projection: the same stable keys, labels, data types, units, requirements, values, bounds, patterns and definitions. No independent nine-column review schema or client-owned step/field inventory remains.

Seven `workflow_columns` with `kind: review_view` define Step ID, predecessor, successor, instructions, linked input keys, optional start and optional exclusive end. They appear in Plan options, its metadata pivot and this protocol-backed dictionary. Only timing fields are writable local view notes; they are separate from financial inputs and never affect cash calculations. Gantt receives the same input-field definitions for its linked parameters and uses the same selected-option editor.

`review_workflow.exchange` declares `sme-business-plan/view-notes/v1`. Export contains pack ID/version, mode and timing records keyed by canonical `review-start` and `review-end`; it does not duplicate financial inputs or field definitions. Import validates exact identity, keys, count, dates and the declared 64 KB bound before changing notes. Old review-record files and mismatched contracts are refused atomically; no compatibility variant is retained. The existing financial worksheet contract, four tools and calculation schema are unchanged.

## Reference implementation — shared tools and vocabulary owners

The following names and paths identify existing reference implementations only. The product contract remains provider-, tool-, and location-neutral; shared meanings stay with their canonical owners.

| Tool | Input | Result |
|---|---|---|
| `pack.list` | Empty object | Registered plan identities and zero inference tokens |
| `pack.protocol` | `pack_id` | Active versioned contract, mode, calculation model, inputs, outputs, evidence guidance, example bundle, and review metadata |
| `business.plan.build` | `pack_id`, optional `mode` (defaults to `buy_build`), `inputs`, optional evidence | `sme-business-plan/report/v2` with active contract, selected mode, completeness, contract outputs, optional pitch outline, next checks, and local worksheet exports |
| `business.plan.compare` | Optional shared `mode`, two or three ordered `plan_sets` | `sme-business-plan/comparison/v2`; same mode, currency, and contract required, no ranking |

The pack defines no `/` command, `#` semantic tag, `@` binding, skill alias, MCP resource, or MCP prompt. Invocation grammar and shared tokens stay owned by `agentic-os/catalog/dictionaries`; skill discovery and MCP gateway behavior stay owned by `agentic-canvas-os/docs`; shared JSON-LD invocation metadata stays owned by `huijoohwee.github.io/schema/AgenticRAG`. The dictionary view links to those reference owners without copying their taxonomies or granting execution authority. The transport exposes canonical tools through MCP and optionally WebMCP; explicit calls evaluate only their supplied arguments and do not read form memory.

## Data handling

Calculations run locally and deterministically. Form inputs and reports remain in tab memory and are cleared when the workspace is left. JSON, CSV, Markdown, print, and import are user-triggered local worksheet operations. There is no account, upload, persistence, market-data fetch, paid service, added dependency, or network call for a local build.

## Worksheet identity and recovery

Local exports include every displayed option in entry order. Each record retains `sme-business-plan/worksheet/v2`, exact pack ID/version, mode, currency, inputs and evidence; JSON uses one record or an ordered array for multiple options. CSV carries the same identity as explicit metadata with a plan index, and Markdown contains one canonical JSON block after the readable reports. Print projects the same rows. No new tool or workflow is introduced.

Import validates all records before changing the table. A stale `1.1.0` takeover worksheet, an identity-free legacy CSV, mixed identities, invalid values, extra keys or an oversized file is refused with current inputs retained. No implicit migration or schema fallback occurs. Imports and exports captured before an input change, contract switch or route exit cannot overwrite newer state. Maximum import/export file size is 64 KB; decoded evaluation requests and reports retain their 32/64 KB bounds. MCP also counts its text/structured-content envelope toward 64 KB, so a larger three-row report can fit locally yet be explicitly refused by MCP; reduce rows or evidence instead of truncating results. Recovery uses the previous complete artifact with its matching worksheet version; user files are never rewritten during rollback.

### Review timeline semantics

The existing takeover review uses three neutral activities: Frame the review, Examine the transfer, and Record questions and next action. Their stable IDs (`limits`, `transfer`, `questions`) are unchanged. The protocol owns the descriptions and suggested relationship order; activities can be revisited or paused. No duration, jurisdiction, approval, suitability or transfer outcome is inferred.

Dates remain optional local view notes using the same seven review parameters, Plan options field definitions and dictionary. Each activity shows its recorded start/end and relationship endpoints, including unknowns. Calendar-day boundary differences are arithmetic between an entered start and its preceding activity's exclusive end within the same option. Actual window overlap is reported only when both complete date pairs establish a positive intersection; no missing date is imputed. When at least one complete date pair is entered, the native ruler places complete intervals on separate activity lanes, including overlapping or reverse-ordered intervals. Partial or unknown pairs stay in the same activity controls without fabricated bars. With no complete pairs, the ruler shows explicit dependency order. These observations never reschedule an activity or change financial inputs, stages or outcomes. The single selected-activity date editor sits above the ruler and each activity can focus it through Edit dates; labels and values remain those of the same workflow parameters. Complete pairs enable the existing calendar ruler; this is not a completion forecast. The existing view-note format and strict import identity remain unchanged.

The workflow has one render host and shadow root. Switching between Base and Gantt disposes the inactive renderer and invalidates pending mounts. Inputs, evidence, option selection, timing and table orientation remain shared. The active heading and region identify Gantt or table mode. A Gantt load failure reports in that same host and preserves the data for a deliberate switch back to a table view.

Gantt receives the exact `createSmeWorkflowFieldView({ review: true })` projection used by Review steps. Every hierarchy, input, review parameter, plan state, evidence, readiness and output record appears once per plan option, with the same metadata columns and that option's current value. Each native workflow row contains its existing bar, expandable guidance, date action and shared input groups inside the ruler body. Remaining shared groups occupy a timeless native workflow row. There is no separate activity-card grid or below-chart record panel. The shared Graph owner measures expanded row content and aligns sidebar rows and native scrolling; legacy fixed-row callers remain unchanged. Unknown or partial timing retains the same inline activity without a fabricated interval. Expand a record for its value and record details, or activate an editable input/date record to use the existing option editor. Stable record keys preserve disclosure state across live updates. The three existing activities own optional timing; field and output records have no independent dates or durations. No companion Base table, second schema or copied values are mounted.
