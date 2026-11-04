# Business plan codebook and data dictionary

Version: `sme.business-plan@2.0.0`
Status: provisional, user-defined planning contract
Runtime owner: `public/local-first/sme-pack-business-plan.js`
Schema and evaluator owner: `public/local-first/sme-business-pack-core.js`

## Contract

The active plan is a general, local-first startup and small-business planning worksheet. It has no location, sector, benchmark, market data, default assumptions, inferred values, currency conversion, or external service dependency. The author chooses a three-letter currency code for each scenario. Text is limited to concise planning notes; unknown values remain unknown. User-recorded evidence is context and is not authenticated.

The versioned protocol is returned by `pack.protocol` as `sme-business-plan/protocol/v1`. Its source collections are `input_fields`, `model_outputs`, `artifacts`, `parameters`, `ratios`, `protocols`, and `tolerances`. The current contract declares input fields, model outputs, one pitch deck outline artifact, and evidence guidance; calculation parameters, ratios, and tolerances are explicitly empty. The tools and JSON Schemas are declared once in `sme-business-pack-core.js` and reused by local, worker, MCP, and optional WebMCP adapters.

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

The E2E table also projects required-input completeness, invalid entries, output coverage, each model output, one twelve-section pitch deck draft outline, and ordered next checks. Slide content is traced to declared input keys and calculated output keys; it does not fill gaps with generated facts. Markdown export contains the outline, financial model, and plan data. Next checks name missing model inputs or optional narrative context; they do not prescribe financing or claim a venture is viable. The selected scenario editor edits the same row's fields and evidence. There is no separate checklist or results model.

## Table contract

The E2E workspace renders one `agentic-base` `multiDimensional` table. Rows are scenarios A, B, and C in entry order. Columns are the scenario key, every `input_fields` field, plan status and validation, evidence, every `model_outputs` field, the `pitch_deck_outline` artifact, and next checks. One scenario builds a draft; two or three compare entered scenarios. Comparison requires a shared contract version and currency code. It preserves order and does not rank, sort, score, choose a winner, or convert currency. Pivoting changes only the orientation of that same table.

The Data dictionary route renders a second read-only `multiDimensional` table generated from the live protocol. It documents each input, output, artifact, evidence rule, tool schema, empty optional collection, and shared vocabulary owner. It is a different concern from the workflow table, not an alternate workflow or calculation surface. Both use the existing Base adapter; Commerce theme tokens continue to come from `agentic-design-system`.

## Tool and shared vocabulary dictionary

| Tool | Input | Result |
|---|---|---|
| `pack.list` | Empty object | Registered plan identities and zero inference tokens |
| `pack.protocol` | `pack_id` | Versioned `input_fields`, model outputs, evidence guidance, and review metadata |
| `business.plan.build` | `pack_id`, `inputs`, optional evidence | `sme-business-plan/report/v1` with completeness, model, pitch deck draft outline, next checks, and worksheet exports |
| `business.plan.compare` | Two or three ordered `plan_sets` | `sme-business-plan/comparison/v1`; same currency and contract required, no ranking |

The pack defines no `/` command, `#` semantic tag, `@` binding, skill alias, MCP resource, or MCP prompt. Invocation grammar and shared tokens stay owned by `agentic-os/catalog/dictionaries`; skill discovery and MCP gateway behavior stay owned by `agentic-canvas-os/docs`; shared JSON-LD invocation metadata stays owned by `huijoohwee.github.io/schema/AgenticRAG`. The dictionary view links to those owners without copying their taxonomies or granting execution authority. The transport exposes the canonical tools through MCP and optionally WebMCP; explicit calls evaluate only their supplied arguments and do not read form memory.

## Data handling

Calculations run locally and deterministically. Form inputs and reports remain in tab memory and are cleared when the workspace is left. JSON, CSV, Markdown, print, and import are user-triggered local worksheet operations. There is no account, upload, persistence, market-data fetch, paid service, added dependency, or network call for a local build.
