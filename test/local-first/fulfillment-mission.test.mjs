import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSwarmSqliteStore, createAgentToolkitSqliteStore } from 'agentic-os/agents/sqlite-store';
import { createListingRuntime } from '../../scripts/durable-fulfillment/runtime.mjs';
import { createListingMission } from '../../scripts/durable-fulfillment/mission.mjs';
import { listingPlanFixture, listingInputFixture, listingOutputFixture } from './fulfillment-fixture.mjs';

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'listing-mission-'));
  let store, toolkitStore, composition, calls = 0;
  const now = () => 1789545600000;
  const access = { principalId: 'owner', principalExpiresAt: now() + 7 * 86400000 };
  const authorize = async () => ({ allowed: true, approvalId: 'fixture-only' });
  const close = () => { toolkitStore?.close(); store?.close(); };
  async function open(plan = listingPlanFixture()) {
    store = await createAgentSwarmSqliteStore({ directory, now });
    toolkitStore = await createAgentToolkitSqliteStore({ directory, now });
    composition = createListingRuntime({ stateStore: store, mission: { toolkitStore, plan }, now, authorize,
      executeListing: async call => { calls++; if (call.resourceBounds) assert.equal(call.resourceBounds.inputTokens, 2048);
        return overrides.output?.() ?? listingOutputFixture(); } });
  }
  await open(); t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { access, now, authorize, close, open, calls: () => calls, get store() { return store; },
    get toolkitStore() { return toolkitStore; }, get runtime() { return composition.runtime; },
    invoke: (op, input, context = access) => composition.product.invoke(op, input, context) };
}

test('listing joins actual draft/source, settles measured usage and survives SQLite restart', async t => {
  const f = await fixture(t), input = listingInputFixture();
  const result = await f.runtime.run(input, f.access);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(f.calls(), 1);
  const query = await f.invoke('query', {}); assert.equal(query.items.length, 1);
  const trace = await f.invoke('trace', { runId: input.runId });
  assert.equal(trace.context.plan.revision, listingPlanFixture().revision);
  assert.equal(trace.context.taskId, input.runId); assert.match(trace.context.receipt.id, /^draft\//);
  assert.equal(trace.profileSummary.tokenUsage.promptTokens, 10);
  assert.equal(trace.profileSummary.tokenUsage.completionTokens, 8);
  assert.equal(trace.resources.used.inputTokens, 10);
  assert.ok(trace.spans.some(span => span.operation === 'work'));
  assert.ok(!JSON.stringify(trace).includes(input.input.description));
  f.close(); await f.open();
  assert.equal((await f.invoke('status', { runId: input.runId })).status, 'completed');
  assert.equal((await f.runtime.run(input, f.access)).status, 'completed'); assert.equal(f.calls(), 1);
  assert.equal((await f.invoke('trace', { runId: input.runId })).context.receipt.digest, trace.context.receipt.digest);
  const peer = { ...f.access, principalId: 'peer' };
  assert.equal((await f.invoke('status', { runId: input.runId }, peer)).reasonCode, 'run_forbidden');
  assert.equal((await f.invoke('query', {}, peer)).items.length, 0);
  assert.equal((await f.invoke('trace', { runId: input.runId }, peer)).reasonCode, 'run_not_found');
});

test('forged context and stale persisted plan stop before any model call', async t => {
  const f = await fixture(t), input = listingInputFixture();
  const mission = createListingMission({ stateStore: f.store, toolkitStore: f.toolkitStore,
    authorize: f.authorize, plan: listingPlanFixture(), now: f.now });
  const bound = mission.bind(input); bound.context.plan.revision = 'b'.repeat(40);
  const forged = await f.runtime.start(bound, f.access);
  assert.equal(forged.reasonCode, 'listing_context_mismatch'); assert.equal(f.calls(), 0);
  await f.runtime.start(input, f.access);
  f.close(); await f.open(listingPlanFixture('b'.repeat(40)));
  const stale = await f.runtime.work({ runId: input.runId, workerId: 'fixture-worker', operationId: 'stale-work' }, f.access);
  assert.equal(stale.reasonCode, 'context_stale'); assert.equal(f.calls(), 0);
});

test('contract evaluation binds the actual subject and replays without another allocation charge', async t => {
  const f = await fixture(t), input = listingInputFixture(); await f.runtime.run(input, f.access);
  const before = await f.invoke('trace', { runId: input.runId });
  const evaluation = { runId: input.runId, operationId: 'evaluate-one', subjectDigest: before.subjectDigest,
    evidence: { id: 'listing-contract', digest: before.subjectDigest } };
  const result = await f.invoke('evaluate', evaluation);
  assert.equal(result.evaluation.status, 'reported', JSON.stringify(result)); assert.equal(result.evaluation.score, 1);
  const charged = await f.invoke('trace', { runId: input.runId });
  await f.invoke('evaluate', evaluation);
  assert.deepEqual((await f.invoke('trace', { runId: input.runId })).resources, charged.resources);
  const wrong = await f.invoke('evaluate', { ...evaluation, operationId: 'changed-subject', subjectDigest: '0'.repeat(64) });
  assert.equal(wrong.status, 'blocked'); assert.equal(f.calls(), 1);
  const work = before.spans.find(span => span.operation === 'work');
  const spanEvaluation = await f.invoke('evaluate', { runId: input.runId, spanId: work.spanId,
    operationId: 'evaluate-work', subjectDigest: work.subjectDigest,
    evidence: { id: 'listing-work-contract', digest: work.subjectDigest } });
  assert.equal(spanEvaluation.evaluation.status, 'reported');
  assert.equal(spanEvaluation.evaluation.score, 1);
  f.close(); await f.open(listingPlanFixture('b'.repeat(40)));
  const nextInput = listingInputFixture('2');
  assert.equal((await f.runtime.run(nextInput, f.access)).status, 'completed');
  const next = await f.invoke('trace', { runId: nextInput.runId });
  const compared = await f.invoke('compare', { cohortId: before.cohortId,
    baseline: before.candidate, candidate: next.candidate });
  assert.equal(compared.status, 'insufficient-evidence');
  assert.equal((await f.invoke('trace', { runId: input.runId })).context.plan.revision, listingPlanFixture().revision);
});

test('unknown inference usage holds the shared allocation across restart', async t => {
  const f = await fixture(t, { output: () => { const value = listingOutputFixture(); delete value.costLog; delete value.output.usage; return value; } });
  const first = await f.runtime.run(listingInputFixture(), f.access);
  assert.equal(first.status, 'blocked'); assert.equal(f.calls(), 1);
  f.close(); await f.open();
  const next = await f.runtime.run(listingInputFixture('2'), f.access);
  assert.equal(next.status, 'blocked'); assert.equal(f.calls(), 1);
});

test('retained contextless jobs keep their original policy and do not gain synthetic traces', async t => {
  const f = await fixture(t), input = listingInputFixture();
  const legacy = createListingRuntime({ stateStore: f.store, authorize: f.authorize, now: f.now,
    executeListing: async () => listingOutputFixture() });
  await legacy.runtime.start(input, f.access);
  assert.equal((await f.runtime.run(input, f.access)).status, 'completed');
  assert.equal((await f.invoke('query', {})).items.length, 0);
});
