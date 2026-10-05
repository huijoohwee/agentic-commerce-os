import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createAgentSwarmSqliteStore, createAgentToolkitSqliteStore } from 'agentic-os/agents/sqlite-store';
import { createListingRuntime } from '../../scripts/durable-fulfillment/runtime.mjs';
import { createListingMission } from '../../scripts/durable-fulfillment/mission.mjs';
import { listingPlanFixture, listingInputFixture, listingOutputFixture } from './fulfillment-fixture.mjs';

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'listing-mission-'));
  let store, toolkitStore, composition, calls = 0;
  let at = 1789545600000;
  const now = () => at;
  const access = { principalId: 'owner', principalExpiresAt: now() + 7 * 86400000 };
  const authorize = overrides.authorize ?? (async () => ({ allowed: true, approvalId: 'fixture-only' }));
  const close = () => { toolkitStore?.close(); store?.close(); };
  async function open(plan = listingPlanFixture()) {
    store = await createAgentSwarmSqliteStore({ directory, now });
    toolkitStore = await createAgentToolkitSqliteStore({ directory, now });
    composition = createListingRuntime({ stateStore: store, mission: { toolkitStore, plan }, now, authorize,
      executeListing: async call => { calls++; if (call.resourceBounds) assert.equal(call.resourceBounds.inputTokens, 2048);
        return overrides.output?.() ?? listingOutputFixture(); } });
  }
  await open(); t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { access, now, authorize, close, open, directory, advance: ms => { at += ms; }, calls: () => calls, get store() { return store; },
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

test('retained contextless jobs remain readable and cancelable without unbudgeted dispatch', async t => {
  const f = await fixture(t), input = listingInputFixture();
  const legacy = createListingRuntime({ stateStore: f.store, authorize: f.authorize, now: f.now,
    executeListing: async () => listingOutputFixture() });
  await legacy.runtime.start(input, f.access);
  assert.equal((await f.runtime.run(input, f.access)).reasonCode, 'context_required');
  assert.equal(f.calls(), 0);
  assert.notEqual((await f.runtime.status(input.runId, f.access)).status, 'blocked');
  assert.equal((await f.runtime.run(input, { ...f.access, principalId: 'peer' })).reasonCode, 'run_forbidden');
  assert.equal((await f.invoke('query', {})).items.length, 0);
  assert.notEqual((await f.runtime.cancel({ runId: input.runId, operationId: 'legacy-cancel', reason: 'operator_cancelled' }, f.access)).status, 'blocked');
});

const DAY = 86400000;
const recordCount = f => {
  const db = new DatabaseSync(join(f.directory, 'swarm.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM agent_records').get().count; }
  finally { db.close(); }
};
const inputFor = index => ({ ...listingInputFixture(), runId: 'listing-' + index.toString(16).padStart(64, '0') });
const accessFor = (f, index) => ({ principalId: 'session-' + index, principalExpiresAt: f.now() + 7 * DAY });
const missionFor = (f, toolkitStore = f.toolkitStore, stateStore = f.store) => createListingMission({
  stateStore, toolkitStore, authorize: f.authorize, plan: listingPlanFixture(), now: f.now });
const usage = { inputTokens: 0, outputTokens: 0, attempts: 1, elapsedMs: 0 };
const requestFor = (mission, input, access, operationId) => ({ context: mission.bind(input).context,
  principalId: access.principalId, runId: input.runId, agentId: input.agent.agentId, operationId, phase: 'plan' });

test('fresh sessions share the daily budget atomically across coordinators and restart', async t => {
  const f = await fixture(t), mission = missionFor(f), rows = [];
  for (let index = 1; index <= 12; index++) {
    const input = inputFor(index), access = accessFor(f, index);
    assert.notEqual((await f.runtime.start(input, access)).status, 'blocked');
    rows.push({ input, access });
    for (let op = 1; op <= (index <= 10 ? 7 : 6); op++) {
      const r = await mission.options.resources.reserve(requestFor(mission, input, access, 'budget-' + op));
      await mission.options.resources.settle(r, access.principalId, usage);
    }
  }
  const peerStore = await createAgentSwarmSqliteStore({ directory: f.directory, now: f.now });
  const peerToolkit = await createAgentToolkitSqliteStore({ directory: f.directory, now: f.now });
  const peer = missionFor(f, peerToolkit, peerStore);
  try {
    const a = rows[10], b = rows[11];
    const reservations = await Promise.all([
      mission.options.resources.reserve(requestFor(mission, a.input, a.access, 'budget-7')),
      peer.options.resources.reserve(requestFor(peer, b.input, b.access, 'budget-7')),
    ]);
    await mission.options.resources.settle(reservations[0], a.access.principalId, usage);
    await peer.options.resources.settle(reservations[1], b.access.principalId, usage);
    await assert.rejects(peer.options.resources.reserve(requestFor(peer, b.input, b.access, 'over-budget')),
      { reasonCode: 'budget_project_exhausted' });
    const visible = await mission.options.resources.inspect(mission.bind(a.input).context, a.access.principalId);
    assert.equal(visible.used.attempts, 8);
    assert.ok(!JSON.stringify(visible).includes('listing-host'));
  } finally { peerToolkit.close(); peerStore.close(); }
  f.close(); await f.open();
  const reopened = missionFor(f), last = rows[11];
  await assert.rejects(reopened.options.resources.reserve(requestFor(reopened, last.input, last.access, 'after-restart')),
    { reasonCode: 'budget_project_exhausted' });
  assert.equal(f.calls(), 0);
});

test('rolling host slots reject fresh-session floods before storage and allow multiday progress', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 16 }, (_, n) =>
    f.runtime.start(inputFor(n + 1), accessFor(f, n + 1))));
  assert.ok(results.filter(value => value.status !== 'blocked').length <= 12);
  for (let n = 0; n < results.length; n++) if (results[n].status === 'blocked') {
    assert.ok(['run_quota_exceeded', 'admission_busy'].includes(results[n].reasonCode), JSON.stringify(results[n]));
    assert.equal(await f.store.get(inputFor(n + 1).runId), null);
  }
  f.advance(8 * DAY + 1); f.close(); await f.open();
  let peak = 0;
  for (let day = 0; day < 20; day++) {
    const input = inputFor(day + 100), access = accessFor(f, day + 100);
    const result = await f.runtime.run(input, access);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    peak = Math.max(peak, recordCount(f));
    assert.ok(recordCount(f) < 128);
    f.advance(DAY); f.close(); await f.open();
  }
  assert.equal(f.calls(), 20); assert.ok(peak > 0 && peak < 128);
  t.diagnostic('20-day completed-run peak records: ' + peak);
});

test('unknown usage holds the host for new sessions and later days without exhausting storage', async t => {
  const f = await fixture(t, { output: () => { const result = listingOutputFixture(); delete result.costLog; delete result.output.usage; return result; } });
  assert.equal((await f.runtime.run(inputFor(1), accessFor(f, 1))).status, 'blocked');
  const heldContext = missionFor(f).bind(inputFor(1)).context;
  assert.equal((await f.runtime.run(inputFor(99), accessFor(f, 99))).reasonCode, 'allocation_usage_unknown');
  let peak = recordCount(f);
  for (let day = 0; day < 20; day++) {
    f.advance(DAY); f.close(); await f.open();
    const result = await f.runtime.run(inputFor(day + 2), accessFor(f, day + 2));
    assert.equal(result.reasonCode, 'allocation_policy_conflict');
    peak = Math.max(peak, recordCount(f));
    assert.ok(recordCount(f) < 128);
  }
  assert.equal(f.calls(), 1);
  assert.equal((await missionFor(f).options.resources.inspect(heldContext, 'session-1')).status, 'held');
  t.diagnostic('20-day unknown-hold peak records: ' + peak);
});

test('a partial host settlement keeps its receipt for an exact retry', async t => {
  const f = await fixture(t), input = inputFor(1), access = accessFor(f, 1);
  await f.runtime.start(input, access);
  let rejectSettlement = true;
  const store = { ...f.toolkitStore, replace: async (id, claim, record) => {
    if (rejectSettlement && record.schema === 'agent-resource-allocation/v1'
      && record.ownerPrincipalId === 'listing-host-budget/v1'
      && record.entries.some(entry => entry.operationId === 'partial-settlement' && entry.state === 'settled')) {
      rejectSettlement = false; throw Error('fixture-host-settlement-failure');
    }
    return f.toolkitStore.replace(id, claim, record);
  } };
  const mission = missionFor(f, store), request = requestFor(mission, input, access, 'partial-settlement');
  const reservation = await mission.options.resources.reserve(request);
  await assert.rejects(mission.options.resources.settle(reservation, access.principalId, usage), /fixture-host-settlement-failure/);
  assert.equal((await mission.options.resources.settle(reservation, access.principalId, usage)).state, 'settled');
  assert.equal((await mission.options.resources.inspect(request.context, access.principalId)).used.attempts, 2);
  await assert.rejects(mission.options.resources.settle(reservation, 'peer', usage), { reasonCode: 'allocation_forbidden' });
});


test('a replayed host hold is never refunded after caller reservation failure', async t => {
  const f = await fixture(t), first = inputFor(1), second = inputFor(2);
  const owner = accessFor(f, 1), peer = accessFor(f, 2);
  await f.runtime.start(first, owner); await f.runtime.start(second, peer);
  const mission = missionFor(f), request = requestFor(mission, first, owner, 'uncertain-attempt');
  const original = await mission.options.resources.reserve(request);
  await mission.options.resources.settle(original, owner.principalId, null);
  const callerRecord = original.recordId;
  const failing = missionFor(f, { ...f.toolkitStore, claim: (id, ...args) => {
    if (id === callerRecord) throw Error('fixture-caller-reservation-failure');
    return f.toolkitStore.claim(id, ...args);
  } });
  await assert.rejects(failing.options.resources.reserve(request), /fixture-caller-reservation-failure/);
  await assert.rejects(mission.options.resources.reserve(requestFor(mission, second, peer, 'fresh-session-attempt')),
    { reasonCode: 'allocation_usage_unknown' });
  assert.equal(f.calls(), 0);
});


test('malformed allowed grants cannot consume persistent host admission slots', async t => {
  let verdict = { allowed: true };
  const f = await fixture(t, { authorize: async () => verdict });
  for (const invalid of [{ allowed: true }, { allowed: true, approvalId: '' },
    { allowed: true, approvalId: 'fixture', unexpected: true }]) {
    verdict = invalid;
    for (let attempt = 1; attempt <= 13; attempt++) {
      assert.equal((await f.runtime.start(inputFor(attempt), accessFor(f, attempt))).reasonCode, 'authorization_failed');
      assert.equal(recordCount(f), 0);
    }
  }
  verdict = { allowed: true, approvalId: 'fixture-only' };
  assert.equal((await f.runtime.run(inputFor(20), accessFor(f, 20))).status, 'completed');
  assert.equal(f.calls(), 1);
});
