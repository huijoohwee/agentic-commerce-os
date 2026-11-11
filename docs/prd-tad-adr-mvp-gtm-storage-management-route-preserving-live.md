---
title: "Storage Management Static Route with Live Checkout Preserved"
doc_type: "PRD-TAD-ADR-MVP-GTM"
version: "0.3.0"
revision: "0.3.0"
date: "2026-11-11"
updated_date: "2026-11-11"
continuity_id: "COMMERCE-STORAGE-MANAGEMENT-ROUTE-001"
supersedes_revision: "0.2.0"
prd_revision: "0.3.0"
tad_revision: "0.3.0"
adr_revision: "0.3.0"
mvp_revision: "0.3.0"
gtm_revision: "0.3.0"
owner: "agentic-commerce-os"
lifecycle_status: "active"
verification_scope: "Serve the existing six-source storage index at its exact Commerce subpath without changing the active checkout Worker, profile, payment credentials, or application route."
---

# Storage Management Static Route with Live Checkout Preserved

## PRD — buyer and operator need

Publish one small, mobile-readable index for the six merged E2E storage-management updates at
`https://airvio.co/agentic-commerce-os/storage-management/`. Each source repository remains the
authority for its document and tests. The page links immutable revisions and does not copy source
documents or claim that documentation changed a runtime artifact.

The current Commerce checkout is `live`. Its protected local-first release requires a no-new-sales
reader before activating a new live candidate. The storage index must not change that checkout
profile or make the Commerce application unavailable. Keep the existing Commerce Worker and its
route unchanged.

## TAD — smallest independent delivery surface

- Serve only this page's static assets through one assets-only Worker and two narrowly scoped
  Cloudflare routes: the exact slashless address `airvio.co/agentic-commerce-os/storage-management`
  for its redirect, and `airvio.co/agentic-commerce-os/storage-management/*` for the page and its
  child assets. The browser URL is `https://airvio.co/agentic-commerce-os/storage-management/`.
- Cloudflare's most-specific matching route must select the static Worker ahead of the existing
  broader `airvio.co/agentic-commerce-os*` Commerce Worker route. Preserve both the broader route
  and its active deployment identity.
- Use no Worker entrypoint, runtime binding, storage service, paid feature, new package, account
  data, payment code, or external server request. Static links to GitHub open only when a reader
  follows them.
- Keep the service worker scoped to `/agentic-commerce-os/storage-management/`; cache only the
  page, stylesheet, guide script, source manifest, and service-worker script. Do not cache Commerce
  application or buyer data.
- Keep the exact existing public page path, source manifest, CSP, method policy, content hashes,
  slashless redirect, mobile layout, and offline acceptance from revision 0.1.0.
- Add at most one Worker and two exact route patterns, at most five served files, and no more than 80 kB of
  published assets. Use the repository's pinned Wrangler and production environment approval.
- Before route creation, prove current Cloudflare account/zone capacity is within the Workers Free
  limits and that no conflicting narrow route exists. Fail closed if the existing Commerce route,
  application `/readyz` identity, checkout profile, route quota, or worker quota differs from the
  recorded baseline.

## ADR — separate static route

Choose a separate assets-only Worker because publishing the merged Commerce application candidate
requires activating the no-new-sales reader, while this page is independent static content and the
operator has selected keeping live checkout unchanged. A more-specific static route isolates the
index from the Commerce application and avoids deploying other Commerce runtime changes that are
not required for the six-source index.

Cloudflare documents that the most-specific route wins, that assets-only Workers need no `main`,
and that static-asset requests and storage incur no additional charge. The free account's Worker
and route counts still require preflight. The Cloudflare Docs are linked from the repository's
deployment record; no paid plan, add-on, or overage is permitted.

## MVP — candidate and release proof

1. Verify the six immutable source revisions and per-file digests, exact asset allowlist, file and
   byte caps, `_headers`, offline scope, and Wrangler static-only configuration.
2. Run the existing required Integration Gate and the focused mobile/offline browser check against
   Wrangler's local preview. The candidate job must prove the route configuration contains no
   Worker entrypoint, runtime bindings, storage, cron, or paid feature.
3. In the protected Production job, re-read the exact Cloudflare route table, account/zone limits,
   existing broad Commerce route, current `/readyz` identity and `checkout=live` state immediately
   before the write. Bind the candidate SHA, exact new route patterns, absent or retained narrow-route
   baseline, static asset digest, repository Integration Gate and Production approval.
4. Deploy the exact candidate Worker and routes. Read back the canonical page, all four companion
   assets, MIME/security/cache headers, hashes, slashless redirect, unknown-path 404, and the
   specific route binding. Re-read the existing Commerce route and `/readyz`; the Worker version,
   source revision and live checkout state must match the pre-deploy observations.
5. Retain a typed receipt with candidate source and asset digests, Worker version/deployment,
   exact route identity, baseline, free-tier preflight, Production approval and runtime readback.
6. Read the Worker asset capability from the Worker Scripts API response, not the Beta Workers
   inventory model. Bind verification and cleanup to the exact Cloudflare deployment version ID.

## Rollback

- If the narrow routes are new and any post-deploy verification fails, remove only those exact routes
  and its newly created Worker, then verify the broad Commerce route and `/readyz` still resolve to
  the retained live Worker. Do not alter checkout or payment configuration.
- If a first bootstrap leaves an unverified Worker behind, use the protected recovery operation with
  the failed run's retained baseline, original Production approval, and exact `Current Version ID`
  from that run's deployment log. Recheck the exact version and route ownership before deletion;
  preserve state if the version or run evidence differs. The recovery must verify the broader
  Commerce route and live `/readyz` identity afterward.
- For a later page update, restore the exact retained static Worker version through the protected
  rollback path. Reverify the page assets and existing Commerce application identity.
- If route ownership, Worker version, or write result is ambiguous, preserve provider state and
  stop. Never retry a route write or delete a Worker by name alone.

## GTM and economics

The published index is a free read-only navigation surface for the already merged storage guidance.
Its value is immediate discovery; buyer demand and savings remain unmeasured. Static assets avoid a
new database, cache service, package, or dynamic Worker invocation. The Cloudflare Free-tier static
asset request and storage policy, account limits, and zero-billable-resource preflight must be
verified against current official documentation and provider state at release.

