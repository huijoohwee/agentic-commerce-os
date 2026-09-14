---
title: "Commerce validation adoption"
doc_type: "PRD-TAD-ADR-MVP-GTM"
version: "1.0.0"
owner: "agentic-commerce-os"
date: "2026-09-14"
lang: "en-US"
frontmatter_contract: "required"
load_policy: "on-demand"
continuity_id: "COMMERCE-VALIDATION-ADOPTION-001"
prd_revision: "1.0.0"
tad_revision: "1.0.0"
adr_revision: "1.0.0"
mvp_revision: "1.0.0"
gtm_revision: "1.0.0"
status: "implementation"
---

# Commerce validation adoption

## PRD

`COMMERCE-VALIDATION-ADOPTION-001@1.0.0`: the solo merchant-platform maintainer
validates changed implementation inputs while retaining external evidence and
production boundaries. Role/Subject: maintainer. Action/Verb: validates. Object:
affected source checks. Acceptance preserves the Integration Gate, shared ADLC
evaluation, evidence-contract checks and the full implementation fallback.

## TAD and ADR

The exact package/lock pin consumes Agentic OS's
`guides/REPOSITORY-VALIDATION.md` execution contract. The consumer owns only
`.agentic-os-validation.json` and its existing commands. `check:integration` now
invokes that owner; CI detects and verifies the provider event before fresh checks.
`check:plan` previews scope and `check:integration:all` explicitly requests broad
local validation. `check:integration:source` retains the original complete chain.

ADLC and evidence-contract checks remain mandatory. Source dependencies select
type, domain, unit, Worker, named or dry-run groups. Unknown/shared changes use
the existing `check:implementation` chain once rather than duplicate its narrower
groups. Installed toolchains, generated inputs and environment-sensitive checks
remain ineligible for local success reuse. The existing merge-agent command binding is regenerated for the new script closure;
automatic mutation and check execution remain disabled. No worker or payment runtime changes.

`npm run check` still requires `check:evidence` after source integration validation.
The shared runner never supplies external task verdicts or deployment authority.
The existing source-only CI entrypoint remains unchanged; dry-run commands retain
their existing guards and never become live deployment operations.

## MVP

Validate policy selection and the updated existing ADLC profile regression, then
run source integration checks and require the exact protected Integration Gate.
Keep full implementation, external evidence, runtime, payment and production
receipts distinct. 

## GTM

Measure executed groups and command time for a domain edit, documentation edit and
unchanged inputs. Faster validation supports delivery; it does not establish buyer
demand, completed checkout, revenue or a production release. Product and rollback
policy remain in the existing production-runtime and release owners.
