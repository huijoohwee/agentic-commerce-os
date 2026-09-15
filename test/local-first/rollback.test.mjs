import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearseLocalFirstRollback } from '../../scripts/local-first-release/deployment.mjs';

function fixture(options = {}) {
  const candidate = { deploymentId: 'candidate-deployment', versionId: 'candidate-version' };
  const reader = { versionId: 'reader-version', sourceRevision: 'b'.repeat(40), runId: 42 };
  let active = candidate, route = { id: 'route', pattern: 'airvio.co/agentic-commerce-os*',
    state: 'bound', script: 'agentic-commerce-edge-production' };
  const initialRoute = { ...route }, writes = [], observations = [], journal = {};
  const provider = {
    active: async () => active, route: async () => route,
    version: async (id, source, checkout, pins) => {
      if (options.invalidReader && id === reader.versionId) throw Error('reader binding mismatch');
      if (id === reader.versionId) { assert.equal(source, reader.sourceRevision); assert.equal(pins, null); }
      assert.equal(checkout, 'sandbox');
    },
  };
  const input = { provider, candidate, reader, revision: 'a'.repeat(40), pins: { fixture: true }, journal,
    routeAuthority: { mode: 'steady-state', routeId: route.id, pattern: route.pattern, script: route.script },
    checkMain() { if (options.sourceDrift && writes.length) throw Error('source changed'); },
    record(stage) { observations.push(stage); },
    async wrangler(args) {
      assert.deepEqual(args.slice(0, 2), ['versions', 'deploy']);
      assert.deepEqual(args.slice(3), ['-c', 'wrangler.local-first.jsonc', '--yes']);
      writes.push(args[2]);
      active = { deploymentId: 'deployment-' + writes.length, versionId: args[2].slice(0, -5) };
      if (options.lostResponse === writes.length) throw Error('provider response lost');
    },
    observation: {
      async prepare() {
        observations.push('job-prepared');
        if (options.changedBeforeRestore) active = { deploymentId: 'peer', versionId: 'peer' };
        if (options.failedJob) throw Error('job not complete');
        return { runId: 'listing-' + 'c'.repeat(64), outputDigest: 'd'.repeat(64) };
      },
      async reader() {
        assert.equal(active.versionId, reader.versionId); observations.push('reader-observed');
        if (options.peerAfterReader) active = { deploymentId: 'peer', versionId: 'peer' };
        if (options.routeAfterReader) route = { ...route, script: 'peer' };
        if (options.readerFailure) throw Error('reader lost draft');
      },
      async restored() {
        assert.equal(active.versionId, candidate.versionId); observations.push('restored-observed');
        if (options.restoredFailure) throw Error('job readback failed');
      },
    },
  };
  return { input, writes, observations, journal, active: () => active, route: () => route, initialRoute };
}

test('rehearsal restores a verified reader and the exact candidate around the same retained job', async () => {
  const f = fixture(); const receipt = await rehearseLocalFirstRollback(f.input);
  assert.deepEqual(f.writes, ['reader-version@100%', 'candidate-version@100%']);
  assert.equal(receipt.status, 'complete'); assert.equal(receipt.readerVerified, true);
  assert.equal(receipt.restoredVerified, true); assert.match(receipt.retainedJob.runId, /^listing-/);
  assert.deepEqual(f.route(), f.initialRoute); assert.equal(f.active().versionId, 'candidate-version');
  assert(f.observations.indexOf('job-prepared') < f.observations.indexOf('restore-exact-version'));
  assert.equal(receipt.realMoney, false);
});

test('source, reader, route and active candidate validation precede provider effects', async () => {
  for (const options of [{ invalidReader: true }, { changedBeforeRestore: true }, { failedJob: true }]) {
    const f = fixture(options); await assert.rejects(rehearseLocalFirstRollback(f.input));
    assert.deepEqual(f.writes, []);
  }
  for (const mutate of [x => { x.routeAuthority.mode = 'bootstrap'; },
    x => { x.routeAuthority.routeId = 'other'; }, x => { x.reader.versionId = x.candidate.versionId; }]) {
    const f = fixture(); mutate(f.input); await assert.rejects(rehearseLocalFirstRollback(f.input));
    assert.deepEqual(f.writes, []);
  }
});

test('a reader observation failure restores the owned candidate but never reports complete', async () => {
  const f = fixture({ readerFailure: true });
  await assert.rejects(rehearseLocalFirstRollback(f.input), /reader lost draft/);
  assert.deepEqual(f.writes, ['reader-version@100%', 'candidate-version@100%']);
  assert.equal(f.journal.rollback.status, 'preserve-required');
  assert.equal(f.journal.rollback.readerVerified, false); assert.equal(f.journal.rollback.restoredVerified, true);
  assert.equal(f.active().versionId, 'candidate-version');
});

test('peer deployment, route drift and changed source stop restoration without overwriting', async () => {
  for (const options of [{ peerAfterReader: true }, { routeAfterReader: true }, { sourceDrift: true }]) {
    const f = fixture(options); await assert.rejects(rehearseLocalFirstRollback(f.input));
    assert.deepEqual(f.writes, ['reader-version@100%']);
    assert.equal(f.journal.rollback.status, 'preserve-required');
    assert.equal(f.journal.rollback.restoredVerified, false);
    if (options.peerAfterReader) assert.equal(f.active().versionId, 'peer');
    if (options.routeAfterReader) assert.equal(f.route().script, 'peer');
  }
});

test('an ambiguous provider response is preserved without replay or another activation', async () => {
  for (const lostResponse of [1, 2]) {
    const f = fixture({ lostResponse });
    await assert.rejects(rehearseLocalFirstRollback(f.input), /provider response lost/);
    assert.equal(f.writes.length, lostResponse);
    assert.equal(f.journal.rollback.status, 'preserve-required');
    assert.equal(f.journal.rollback.restoredVerified, false);
    assert.equal(f.journal.rollback.writeResultUnknown, true);
  }
});

test('restoration needs the actual retained job readback after the provider version returns', async () => {
  const f = fixture({ restoredFailure: true });
  await assert.rejects(rehearseLocalFirstRollback(f.input), /job readback failed/);
  assert.deepEqual(f.writes, ['reader-version@100%', 'candidate-version@100%']);
  assert.equal(f.active().versionId, 'candidate-version');
  assert.equal(f.journal.rollback.status, 'preserve-required');
  assert.equal(f.journal.rollback.restoredVerified, false);
});
