# Commerce and Graph runtime composition

Commerce owns `https://airvio.co/agentic-commerce-os/`. Graph owns
`https://airvio.co/agentic-graph/`. The Commerce console exposes an optional
**Open in canvas** link using Graph's existing `openEditorWorkspace=1` query
contract. The implementation is merchant-agnostic; it does not invent buyer,
price, revenue, or independent evaluator evidence.

## Execution availability

The current MVP permits execution to stop while the operator Mac sleeps or is
offline. Availability independent of that Mac is a future roadmap item. The
[device-session execution host](local-host-runtime.md) implements authenticated
local execution and explicit unavailable/busy responses. This availability
decision does not waive provider, transport, trust or release evidence.

## Runtime behavior

`GRAPH_WORKSPACE_URL` is nonsecret configuration. Production and Staging use
the canonical Graph path. Local and Dev leave it empty until an operator sets
their Graph server URL. HTTPS is required except for loopback in Local/Dev;
credentials, query strings, fragments, whitespace, oversized URLs, and Commerce
self-links are rejected. Misconfiguration fails visibly instead of redirecting
users to an invented destination.

The link opens a new tab with `noopener noreferrer` and no referrer. Commerce
loads no Graph code or iframe and passes no checkout, token, merchant, claim,
or browser storage state. Merchant-specific storefront pages do not add this
operator navigation. Closed delivery surfaces omit the link. Graph continues
to own its canvas, storage, editor, and authorization. This is workspace
navigation; it does not automatically import a Commerce workflow into Graph.

A future document embed must use Graph's published document-scoped iframe
contract in `docs/documents/agentic-graph-embeddability-contract.md` in the Graph
repository. It requires an actual shared document, rather than embedding the
entire operator application or copying its canvas into Commerce.

The existing production prefix now preserves operator MCP claim, lease and
fence headers when dispatching to the core. The already-normalized operator
route selects this authority; public MCP still cannot acquire it.

## Source and live namespace

On 2026-09-09, Graph source at
`4e9056ce12fc68a19ddec1381f2aee8b76de36ae` already builds and publishes
`/agentic-graph/`. Its `mirror-namespace-contract.mjs`, `pages-mirror-sync.mjs`,
and bounded legacy cleanup own migration of the previous namespace. No second
rename or downstream mirror edit is needed here.

The latest successful Graph release run `33191144343` targets older source
`1f7b529d42b0f0cff2c7cd749842fdfe51755bed`. Live apex HTML still references assets
under `/agenticgraph/`. The apex returned HTTP 200; the canonical Graph and
Commerce paths returned 404. Therefore the configured canonical workspace link
requires Graph's existing protected publication workflow to complete before
Commerce production acceptance. HTTP 200 alone does not prove editor readiness.

## Production investigation

Read-only authenticated checks on 2026-09-09 found:

- Commerce edge, core and sandbox production Workers are absent in the selected
  Cloudflare account (API code 10007).
- Configured checkout `agentic-travel-commerce-production` and marketplace
  `agentic-marketplace-production` Workers are also absent. Admission
  `agentic-canvas-os` and docs `agentic-mcp` have deployment records; those records
  alone do not prove the admission identity or provider evidence contract.
- Commerce has no production-release workflow runs or Actions artifacts.
- GitHub's production environment exists, restricted to main, with a User
  reviewer and self-review prevented. Repository-level variables and secrets
  are empty. The environment has eight secret names and route-authority metadata,
  but lacks the discovery bearer secret, admission revision/digest, provider
  evidence pins and human-presence trust anchor required by the controller.
- Local preflight reports incomplete configuration. These observations are not
  secret recovery, externally issued receipts, or permission to manufacture pins.

The release verification job previously omitted the Podman, verified workerd,
and Chromium setup required by its full implementation suite. CI and release
verification now consume the same local composite action, preserving the
existing checksums and direct process-isolation check. Production credentials
remain confined to the protected release job.

Production and Staging now use a private Worker relay to the device-session
Podman host. The controller binds its HTTPS origin, host bundle and image,
requires a fresh authenticated v2 probe, and checks the pins again before each
execution. Cloudflare Containers remain confined to the existing local Dev and
explicit proof configurations. The named tunnel at `commerce-executor.airvio.co`
has passed missing/wrong-token rejection, authenticated execution and disconnect
checks. This transport observation does not establish a deployed relay, provider
or independent trust.

## Acceptance and release handoff

Run the repository integration gate, mobile Chromium tests, and all three dry
bundles. Verify unsafe URLs are rejected; Graph opens only after an explicit
click with no opener; mobile controls stay usable; both prefixed and unprefixed
operator MCP mutations retain their authoring fence; wrong authority and
missing claims never dispatch a mutation.

Before live acceptance, publish the protected Graph candidate through its
source-owned release workflow and verify canonical assets/editor entry. Deploy
and observe the real provider owners, obtain independently issued evidence and
human-presence trust configuration, bind the adopted device-session host through authenticated production transport,
and complete Commerce's exact-candidate protected release controller. Verify
`/agentic-commerce-os/readyz`, provider-backed checkout, evaluator receipts and
recovery evidence. Do not label this source candidate production-ready while
those observations are absent. See [Production runtime contract](production-runtime.md).

## Validation of this change

Local type generation/type checking, 79 domain tests, 271 unit tests and 59 Worker
tests pass. After review fixes, 39 focused release tests and 10 host/relay tests
pass, including the compiled relay in workerd. The earlier navigation change
passed 12 mobile browser tests; this relay change awaits the hosted full browser gate. Graph's two existing mirror migration
suites pass all 29 tests without source changes. Dev dry deployment and
Production core/edge dry bundles pass; largest production chunk is 489,138
bytes. The full local integration command reaches the paid browser gate and
stops at `podman_workerd_override_required`; hosted CI must prove that lane with
the verified Linux runtime. External evidence separately refuses with
`evidence_runtime_context_incomplete` and zero enrolled dispatch issuers.
Graph's last successful release artifacts are expired, so that workflow record
cannot substitute for a freshly observed production receipt.
