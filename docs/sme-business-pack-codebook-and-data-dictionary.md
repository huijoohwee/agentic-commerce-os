# Business plan codebook and data dictionary

Version: `sme.business-plan@2.1.0`
Status: provisional, user-defined planning contract
Runtime owner: `public/local-first/sme-pack-business-plan.js`
Schema and evaluator owner: `public/local-first/sme-business-pack-core.js`

## Contract

The active plan is a general, local-first venture and organization planning worksheet. It has no location, sector, benchmark, market data, default assumptions, inferred values, currency conversion, or external service dependency. The author chooses a three-letter currency code for each scenario. Text is limited to concise planning notes; unknown values remain unknown. User-recorded evidence is context and is not authenticated.

The versioned protocol is returned by `pack.protocol` as `sme-business-plan/protocol/v2`. Its source collections are `input_fields`, `model_outputs`, `artifacts`, `parameters`, `ratios`, `protocols`, `tolerances`, `guideline_sources`, and `guideline_alignment`. The current contract declares input fields, model outputs, one pitch deck outline artifact, evidence guidance, and a versioned map to canonical projection requirements. Calculation parameters, ratios, and tolerances are explicitly empty. The tools and JSON Schemas are declared once in `sme-business-pack-core.js` and reused by local, worker, MCP, and optional WebMCP adapters.

## Canonical guideline alignment

The PRD/TAD/ADR guidelines are the shared parent contract. The Pitch Deck, Business Plan, and Financial Model guidelines own their projection rules; the Venture Record module owns the source registers and required content. The protocol records these exact owner revisions and anchor references. It does not copy their rule text, finding vocabulary, taxonomy, or template schemas into a second registry.

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

`guideline_alignment` is metadata for one dictionary projection, not new user inputs or a second workflow. `partial` and `not_in_mvp` rows remain visible so missing owner records are not implied to exist. The current A/B/C comparison is an ordered comparison of user-entered scenarios; it is not the guidelines' Base/Downside/Upside Scenario Set. The current monthly arithmetic is not a forecast or a linked statement model. The pitch output is an outline, not a rendered or deliverable deck. No projection claims readiness, demand, viability, or guideline conformance on its own.

The owner contract requires all three projections to belong to one source revision and one `continuity_id@revision`. This workspace currently shares its active pack revision across the displayed projections but does not bind to an actual parent PRD identity; the dictionary reports that as `workspace_only`. Every number or claim still needs its owner's source, evidence label, and revision. An absent value stays unknown; no currency, benchmark, market figure, conversion, forecast, reviewer, or evidence status is inferred.

## Input field codebook

Blank optional values are not zero, false, or a model estimate. Required fields are needed to call the plan complete; the evaluator still returns a partial plan when they are absent. `text` values are at most 280 characters (venture name: 80) and reject URL, email, and phone patterns. `money` is a nonnegative amount or inclusive low/high range, up to 1,000,000,000 with four decimal places. `integer` values are whole numbers within their declared bounds. `currency` is a user-selected uppercase three-letter code; no conversion is applied.

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
| `price_per_unit` | Price per unit or billing interval | Financial model | money / selected currency | No | One amount or low/high range |
| `units_per_month` | Units or billable events per month | Financial model | integer / units per month | No | 0–100,000,000 |
| `variable_cost_per_unit` | Variable cost per unit | Financial model | money / selected currency | No | One amount or low/high range |
| `fixed_costs_per_month` | Other fixed costs per month | Financial model | money / selected currency per month | No | One amount or low/high range |
| `payroll_per_month` | Team and contractor cost per month | Financial model | money / selected currency per month | No | One amount or low/high range |
| `setup_costs` | One-time setup and launch costs | Funding | money / selected currency | No | One amount or low/high range |
| `cash_available` | Cash available for this plan | Funding | money / selected currency | No | One amount or low/high range |
| `runway_target_months` | Planning runway | Funding | integer / months | No | 1–120 |
| `funding_requested` | Funding amount under consideration | Funding | money / selected currency | No | One amount or low/high range |
| `use_of_funds` | Proposed use of funds | Funding | text | No | 280 characters |

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
| `funding_gap` | Funding need for entered runway | setup costs, runway, operating result, cash available | max(0, setup costs + positive monthly burn × entered months − available cash) |
| `funding_requested_difference` | Proposed funding minus modeled need | requested funding, funding gap | funding requested − funding need calculated from entered runway |

## Evidence and readiness

Evidence rows use `{ field_key, value, provenance, observer_role, date }`. Provenance is one of `assumption`, `self_reported`, `directly_observed`, `counted`, `document_reviewed`, or `independently_reported`. Observer role is `author`, `observer`, or `reviewer`. These labels describe how a person recorded context; they do not authenticate it or prove the underlying value. The protocol supplies field-specific prompts. The local table shows evidence counts beside each input and evidence details in a workflow column.

The E2E table also projects required-input completeness, invalid entries, output coverage, each model output, one 12-role pitch deck outline, and ordered next checks. Roles are coverage obligations and may be combined in a final deck; the outline is not a fixed slide count. Outline content is traced to declared input keys and calculated output keys; it does not fill gaps with generated facts. Markdown export contains the outline, financial model, and plan data. Next checks name missing model inputs or optional narrative context; they do not prescribe financing or claim a venture is viable. The selected scenario editor edits the same row's fields and evidence. There is no separate checklist or results model.

## Table contract

The E2E workspace renders one shared `multiDimensional` table. Rows are scenarios A, B, and C in entry order. Columns are the scenario key, every `input_fields` field, plan status and validation, evidence, every `model_outputs` field, the `pitch_deck_outline` artifact, and next checks. One scenario builds a draft; two or three compare entered scenarios. Comparison requires a shared contract version and currency code. It preserves order and does not rank, sort, score, choose a winner, or convert currency. A/B/C are not Base/Downside/Upside scenarios. Pivoting changes only the orientation of that same table.

The Data dictionary route renders a second read-only `multiDimensional` table generated from the live protocol. It documents each input, output, artifact, evidence rule, guideline owner and projection-support status, tool schema, empty optional collection, and shared vocabulary owner. It is a different concern from the workflow table, not an alternate workflow or calculation surface.

## Reference implementation — shared tools and vocabulary owners

The following names and paths identify existing reference implementations only. The product contract remains provider-, tool-, and location-neutral; shared meanings stay with their canonical owners.

| Tool | Input | Result |
|---|---|---|
| `pack.list` | Empty object | Registered plan identities and zero inference tokens |
| `pack.protocol` | `pack_id` | Versioned `input_fields`, model outputs, evidence guidance, and review metadata |
| `business.plan.build` | `pack_id`, `inputs`, optional evidence | `sme-business-plan/report/v1` with completeness, model, pitch deck draft outline, next checks, and worksheet exports |
| `business.plan.compare` | Two or three ordered `plan_sets` | `sme-business-plan/comparison/v1`; same currency and contract required, no ranking |

The pack defines no `/` command, `#` semantic tag, `@` binding, skill alias, MCP resource, or MCP prompt. Invocation grammar and shared tokens stay owned by `agentic-os/catalog/dictionaries`; skill discovery and MCP gateway behavior stay owned by `agentic-canvas-os/docs`; shared JSON-LD invocation metadata stays owned by `huijoohwee.github.io/schema/AgenticRAG`. The dictionary view links to those reference owners without copying their taxonomies or granting execution authority. The transport exposes canonical tools through MCP and optionally WebMCP; explicit calls evaluate only their supplied arguments and do not read form memory.

## Data handling

Calculations run locally and deterministically. Form inputs and reports remain in tab memory and are cleared when the workspace is left. JSON, CSV, Markdown, print, and import are user-triggered local worksheet operations. There is no account, upload, persistence, market-data fetch, paid service, added dependency, or network call for a local build.
