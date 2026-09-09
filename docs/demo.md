# AgenticGraph commerce Dev walkthrough

This walkthrough stays entirely in the Dev lane. It exercises the two revenue
paths without writing the generated Production mirror or the Cloudflare delivery
route. The live release state throughout is `liveReleaseReadiness: not-ready`.

For the merchant-agnostic concierge sprint, use the
[MVP-to-GTM handoff](mvp-gtm-handoff.md) for role profiles, prospect inputs,
the timed walkthrough and independent out-of-band payment verification.

The feature specification requests this document at
`.kiro/specs/agentic-graph-commerce-platform/demo.md`. That path belongs to the
workspace-level specification owner, outside this repository's admitted write
authority, so this repository carries the runnable source copy and records the
projection gap explicitly.

## 1. Install the locked toolchain

Command:

```bash
npm ci
```

Expected observable outcome: npm installs the exact committed dependency graph
with no range resolution. Complete the [local container runtime](container-runtime.md)
prerequisites and export `MINIFLARE_WORKERD_PATH` for every runtime/check command below.
Source integration and live release remain separate; every delivery boundary is `closed`.

## 2. Start the mobile-first Dev surface

Command:

```bash
npm run dev:apex
```

Expected observable outcome: the provider fixture, private Sandbox Executor, core, and edge Worker
start on the local Dev topology, with the edge listening on port 5173. No
live-mode provider call is issued. Deploy boundary: unchanged.

In another terminal, confirm the serving lane:

```bash
curl --fail-with-body http://127.0.0.1:5173/livez
```

Expected observable outcome: a `commerce.edge-live/v1` response names the Dev
lane and `dev-unreleased` candidate. This is liveness, not live-release proof.
Deploy boundary: unchanged.

## 3. Exercise settled markup

Command:

```bash
npm run test:workers -- --run test/workers/core.test.ts \
  -t "persists registry, exclusive routing, and guarded checkout state"
```

Expected observable outcome: the local provider settles the recorded checkout,
the core leaves the provider-requested amount unchanged, and one idempotent
Revenue Ledger row records the integer, half-up markup. The test also exercises
the typed `markup_deferred` path without reversing settlement. Deploy boundary:
unchanged; take-rate live billing remains `closed`.

## 4. Exercise a merchant deployment

Command:

```bash
npm run test:workers -- --run test/workers/core.test.ts \
  -t "persists registry, exclusive routing, and guarded checkout state"
```

Expected observable outcome: a valid Theme Manifest activates one merchant
storefront over its declared catalog scope; an unreachable asset or unregistered
agent preserves the prior activation. The capability is demonstrated, but no
merchant payment or demand is claimed. Deploy boundary: unchanged; mirror and
delivery remain closed.

## 5. Run the source gate, then inspect the independent evidence gate

Command:

```bash
npm run check:implementation
```

Expected observable outcome after every source prerequisite is present: the
existing verification lane, all named checks, the mobile browser measurement,
and both dry bundles pass. This is source evidence only. Next run:

```bash
npm run check
```

The terminal command additionally requires one current, independently issued
verdict for every bounded task. In a fresh lane it is expected to remain red
while those artifacts are absent. The portable task snapshot assigns task-level
contract and source closure to non-recursive checks, so the former aggregate
self-reference is closed without fabricating the still-absent verdict set.
Every Delivery boundary remains `closed`; live release remains not-ready.

This repository also has no evaluator-owned dispatch trust anchor or isolated
check executor. Evidence capture therefore stops before any candidate command
unless an external evaluator supplies the pinned trust policy, trusted Git
binary digest, signed dispatch receipt, and signed performer artifact.

The production Merge Agent command is a deliberate hard stop in this lane. The
bounded orchestration examples run only with injected fixture runners; the
production entrypoint starts no candidate-controlled observation, check, or
mutation subprocess until a separately trusted default-deny runner exists.
