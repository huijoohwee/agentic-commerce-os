---
title: "Student Housing Comparison Workspace"
doc_type: "PRD-TAD-ADR-MVP-GTM"
version: "0.3.1"
revision: "0.3.1"
date: "2026-11-01"
updated_date: "2026-11-02"
lang: "en-US"
frontmatter_contract: "required"
owner: "Commerce product function"
continuity_id: "HOUSING-COMPARISON-001"
prd_revision: "0.3.1"
tad_revision: "0.3.1"
adr_revision: "0.3.1"
mvp_revision: "0.3.1"
gtm_revision: "0.3.1"
local_rung: "dev-proven"
delivered_rung: "undocumented"
lane: "authoring"
universal_scope: false
parent: "docs/prd-tad-adr-mvp-gtm-agentic-commerce-os.md"
parent_version: "0.1.0"
load_policy: "on-demand"
runtime_readiness_policy: "fail-closed"
---

# Student Housing Comparison Workspace

## Objective

Add an independently authored housing-comparison workspace inside the existing Commerce document and shared shell. It helps a student compare one to three housing options from locally entered information, see confirmed, inferred, and unknown details, and prepare questions before applying or paying. All product data and demo fixtures are original to this repository. The first release is local-first, offline-capable, free, and contains no account, payment, remote listing lookup, AI call, or document submission.

This plan describes functional coverage and independent implementation. It does not claim legal, safety, housing availability, landlord identity, or application approval.

## User and job

**Primary user:** a student evaluating housing for a defined study period, including applicants who may not have a local credit record or guarantor.

**Job:** enter stay dates, budget, application context, transportation, and priorities; compare researched listing facts consistently; understand costs, time fit, evidence gaps, and the next questions to resolve.

**Pain:** housing pages split essential terms across text, fees, photos, and follow-up conversations. A headline rent does not show total monthly cost, move-in cash, qualification fit, or whether a lease matches the student's stay.

**Evidence state:** the functionality is a product hypothesis. No buyer interviews, landlord reviews, market survey, or demand evidence is claimed. All bundled housing records are synthetic examples.

## User stories

| ID | User story | Priority |
|---|---|---|
| HU-01 | As a student, I enter arrival/departure dates, a monthly budget, application context, travel mode, and priorities without entering my name or uploading documents. | Must |
| HU-02 | I can use an illustrative profile, edit my answers, go back, and resume the current session. | Must |
| HU-03 | I choose one to three locally prepared listings or enter a listing through a closed-field form; listing selection order is retained. | Must |
| HU-04 | I compare the same application, monthly cost, move-in cash, lease fit, commute, amenities, and evidence for every listing in one multi-dimensional table, and pivot listings between rows and columns. | Must |
| HU-05 | Every value shows its evidence state; missing inputs remain unknown and are never treated as zero or approval. | Must |
| HU-06 | I see arithmetic mismatch signals, repeated local photo assets, and listing-specific trade-offs without a hidden composite score. | Must |
| HU-07 | I open a listing plan with next steps, questions, and an editable message draft that I may copy; the app never sends it. | Must |
| HU-08 | I save and remove shortlist IDs on this device and can explicitly export/import a bounded JSON comparison for another device. | Should |
| HU-09 | I can use the warmed workspace offline and can leave the route to clear session facts. Housing's lazy files become available to the service worker after the first visit, including when the first module import happened before the page was controlled; the UI shows Housing-specific readiness only after caching completes. | Must |
| HU-10 | I can complete the main journey with keyboard or touch at narrow and wide viewports. | Must |
| HU-11 | I browse and filter local listings, then see selected facts in the same comparison table before deciding what to save or inspect in a plan. | Must |
| HU-12 | I can correct or remove a manually entered or imported listing without losing unrelated selections, saved IDs, or local photos. | Must |

## Product contract

### One Housing workspace and one comparison surface

Housing has one primary route, `#housing`, and one facts surface: Agentic Base's existing `MultiDimTableView` in multi-dimensional layout. The Overview, Stay & context, Listings, and Comparison route variants are removed. Old `#housing-needs`, `#housing-priorities`, `#housing-listings`, and `#housing-compare` fragments resolve to `#housing`. A per-listing preparation plan may open as a subordinate action and returns to the same table.

The table uses the pinned Base `MultiDimTableView` and can pivot between listings as columns and listings as rows. Both orientations use the same facts and values. Context, local listing controls, and selected-listing actions live together in one expandable workflow section inside the Multi-dimensional Table panel; they are controls for that table, not parallel summaries or alternate detail views. Photos and plans open in local dialogs from that section. Do not create a second comparison renderer, overview cards, listing detail grid, or route-specific copy of the same facts.

Collect only structured fields: study start/end dates, monthly budget, preferred currency, qualification facts from closed choices, transport mode, furnished/quiet/privacy priorities, and optional campus label. A sample profile is optional and editable. Do not collect a student's name, birth date, passport number, school account, contacts, exact home address, or document contents. Leaving the Housing workspace clears session answers.

### Listing input and comparison

The workspace provides three fictional, clearly labelled sample records and a manual listing form. The form accepts a short local label, currency and amounts, lease dates/term, known fees and utilities, furnishing, closed qualification requirements, typed transport estimate with basis, source date, and optional local image files. It does not fetch the entered source or image URL. File processing is memory-only, limited to five images and 5 MiB total per comparison, and clears on exit. Invalid or unsupported fields fail visibly.

Compare one to three records in entry order using Agentic Base's pinned `MultiDimTableView` through the existing first-party local browser adapter. Default to columns orientation; provide one pivot control that updates the adapter's `orientation` between `columns` and `rows` while preserving the same records and facts. Load the adapter and shadow-root stylesheet only when the Housing table opens. Keep long tables in a keyboard-focusable, horizontally scrollable region. Keep stay context, listing selection/editing, selected-listing actions, photos, and plans in the same panel workflow; plans and photos open as local dialogs without a route change. Saving a listing is available once in its local listing control. Use identical rows:

1. Application route and known requirements.
2. Advertised rent, known recurring charges, explicit unknown recurring charges, and monthly subtotal.
3. Known move-in cash and unknown upfront amounts.
4. Lease dates against the entered stay dates, including any explicit rent overhang arithmetic.
5. Transport estimate and its unverified basis.
6. Furnishing, utilities, amenities, and listing-specific uncertainties.
7. Photo count and exact local image-file reuse across selected records.

Evidence states are `Confirmed`, `Inferred`, and `Unknown`. The report shows the basis beside every calculation, preserves unknowns, reports only deterministic arithmetic, and never presents an unknown value as zero. It may label an explicit contradiction as `Mismatch to verify` and show its source fields. It produces no safety rating, guarantee, approval verdict, legal conclusion, composite score, or unsupported market statistic.

### Local listing library

The local listing controls contain the synthetic examples and any facts entered during this visit. Search checks only the visible local label, ID, currency, commute basis, and last-checked date. A saved-only filter uses the existing on-device ID shortlist. Selecting a record places all its facts in the shared table; it does not open a second fact summary. Manually entered and imported records can be edited or removed; editing retains attached in-memory photos, while removal also removes the entry from selection, shortlist, and photo memory. No listing discovery request is made.

### Per-listing plan

Each listing has an independent plan with a transparent state: `No explicit mismatch found`, `More information needed`, or `Pause and verify`. State is rule-derived from the listing's stated facts and the entered profile. Show the exact facts that caused it. Include up to three next actions, an optional document-preparation checklist made only of generic document categories, relevant questions, and a message draft. Do not ask the user to upload, share, or transmit documents. `Copy message` writes only after a clear user action and reports success/failure; there is no send control.

Photos use a local gallery with accessible previous/next controls, a keyboard-operable dialog, Escape close, and focus return. Duplicate detection compares exact selected-file digests locally; it says that two selected files are identical and does not infer that two different rooms are the same unit.

### Saved and portable state

Only saved listing IDs persist in origin-local storage. Profile answers, unsaved listing facts, image bytes, reports, and message drafts exist in memory only and clear on workspace exit. Export is explicit and excludes profile answers, image bytes, and clipboard contents. Import validates exact keys, value bounds, payload size, and schema before replacing any current state. No sync server, telemetry, cookie, remote backup, or third-party analytics is added.

## Acceptance criteria

| ID | Given / when / then | Evidence |
|---|---|---|
| HU-V01 | A clean browser switches into the single `#housing` workspace; the existing Commerce shell root/header/footer stay mounted while only the Housing view changes. Legacy fragments canonicalize to `#housing`. | Live browser route checks |
| HU-V02 | A student enters and edits context, uses the sample profile, and selects options in the one expandable workflow section without any identity/document field. Leaving Housing clears context; re-entry starts clean. | Browser state assertions |
| HU-V03 | Selection accepts one to three entries, preserves order in both pivots, and blocks a fourth without losing prior selections or facts. | Domain and browser checks |
| HU-V04 | Known recurring amounts sum to the displayed monthly subtotal; unknown recurring charges remain visible and make the total explicitly incomplete. | Independent arithmetic fixtures |
| HU-V05 | Move-in cash includes only explicit rent/deposit/fee values; missing required values remain unknown. Lease overhang is computed only from explicit dates and rent. | Independent calculation fixtures |
| HU-V06 | Conflicting qualification, lease, or budget facts display the supporting fields and an actionable verification state; unsupported values produce `Unknown`. | Closed-vocabulary negative and boundary fixtures |
| HU-V07 | Identical selected photo bytes are recognized across records; distinct images are not flagged; image bytes clear when Housing exits. | Browser file fixtures and memory-state check |
| HU-V08 | The shared Base table pivots the same selected records between row and column orientations with unchanged facts; its region scrolls by touch or keyboard while the page itself has no horizontal overflow. No cross-listing winner, rank, or score appears. | Shared-table rendering and mobile/keyboard browser assertions |
| HU-V09 | Per-listing plan actions, next steps, questions, and message draft match the listing/context; Copy requires a direct click and no network send occurs. The plan stays a dialog on the same route. | Browser interaction and request capture |
| HU-V10 | Saved IDs survive reload; profile, listing facts, photos, and reports do not persist. Export excludes private/session-only values; malformed import leaves the current set intact. | Storage, export/import fixtures |
| HU-V11 | After the first Housing visit and service-worker control, all four lazy Housing files are cached and the UI reports Housing readiness. A reload of the one `#housing` route with network access disabled supports the table, local context, plans, and saved-ID reads; an uncached network probe fails, and no third-party requests or service writes occur. | Offline browser proof and request log |
| HU-V12 | At 320, 360, 390, 768, and 1280 CSS px, plus keyboard navigation, controls remain reachable, images/rows reflow, focus is visible, and page-level horizontal overflow is zero. | Responsive browser matrix |
| HU-V13 | Housing code is lazy-loaded; all authored files are under 600 lines, each emitted JavaScript chunk is below 500,000 bytes, and no paid service or new dependency is introduced. | Source/asset manifest and authored-limits checks |
| HU-V14 | Search and saved-only filters operate only on local listing selectors; selected facts appear in the shared table, and filtering never silently removes a selected listing. | Live browser filter and table assertions |
| HU-V15 | Editing a manual or imported listing preserves its ID, selection, saved state, and photo previews; removing it clears its selection, saved ID, and photo memory while leaving other records intact. | Live browser manual and import edit/remove journeys |
| HU-V16 | Housing has one primary comparison route and one shared table renderer. Legacy setup/comparison fragments canonicalize to `#housing`; no duplicate overview, context, listing-facts, or comparison route renders a second facts surface. | Route map and source inspection |
| HU-V17 | The pivot control switches the same Base table between listings as columns and listings as rows; listing values and shared facts stay unchanged and no second comparison surface is created. | Live browser pivot in both orientations |

All HU-V checks remain candidate evidence until the independent product evaluator accepts them.

## Architecture and safety

Reuse the existing `WorkspaceShell`, role switcher, local-first Worker, asset allowlist, artifact projection, and service worker. Add one lazy Housing UI owner, one pure calculation/validation owner, one synthetic data owner, and one scoped stylesheet. Keep these files lazy-loaded; after the worker controls a page that already visited Housing, warm the complete local Housing file set so an earlier uncontrolled module import does not leave offline reload incomplete. Reuse agentic-base-data-view.js and its shadow-root stylesheet under config/agentic-base-data-view.json; select the existing MultiDimTableView with layout=multiDimensional and do not duplicate its implementation or add a dependency. Load the adapter only on the single Housing table route and apply existing theme tokens; do not fork the shell, router, design system, or storage owner.

All calculations are pure and deterministic. Listing/profile input is validated before rendering. User strings are inserted as text, not markup. No external listing fetch, map tile, model request, MCP call, or network side effect is part of this MVP. No code from other products is used. The existing commerce, identity, checkout, publishing, admin, and payment owners remain unchanged.

The human UI owns the workflow; optional WebMCP read-only tools may be added only if they call the same pure functions and are covered by parity checks. No agent tool may send a message, submit an application, contact a landlord, make a payment, or store user input.

## ADRs

### ADR-H1 — Local, closed-field comparison before remote discovery

Use a built-in synthetic sample and a bounded manual entry form. This preserves the compare-and-plan journey offline without scraping or depending on a listing provider. Reconsider discovery only with a separate free-tier/quota/security proof and explicit scope.

### ADR-H2 — Evidence states instead of a single recommendation score

Display exact data basis, incomplete totals, and rule-triggered mismatches per listing. Do not rank homes or infer safety/approval. This keeps trade-offs inspectable and avoids hiding unknowns behind a score.

### ADR-H3 — Session-only profile and explicit local shortlist

Keep profile, listings, images, report, and message in memory; persist only a user's saved IDs. Use explicit bounded export/import for portability. Do not add an account or remote synchronization service.

### ADR-H4 — Manage a device-local listing library

Keep discovery, search, detail inspection, editing, and removal within synthetic or user-entered records. This gives students a reviewable shortlist workflow without a paid data provider, remote fetch, exact address collection, or cross-device account.

## Sprint bounds

One local candidate, one primary Housing route, and one subordinate plan action. Target 4 hours of active work; cap at 6 hours, 58 kB added authored runtime source (reforecast from 52 kB for the shared-table comparison glue; the pinned shared table artifact is 213,845 bytes of JavaScript plus 17,396 bytes of CSS, with the JavaScript chunk below the 500,000-byte ceiling), 3 new JavaScript owners, 32 changed paths (reforecast from 24 to include the complete shared-table adapter, browser proof, and retained mobile evidence set), 0 new dependencies, and 0 paid/model calls. Keep files below 600 lines and emitted chunks below 500,000 bytes. Load the Housing view and stylesheet only on entry. Preserve existing candidate work outside this lane. Recheck source drift and budgets after structural changes; an external wait is a blocker to recheck, not an ETA.

## Release boundary

This is a local, unreleased feature candidate. Passing local tests or browser checks does not establish independent acceptance, production readiness, housing advice, safety, demand, or authority to publish/deploy. Follow the product Release and Deploy workflows for any later effect; no production action is in scope.
