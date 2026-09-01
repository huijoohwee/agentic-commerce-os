import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepositoryProfile } from 'agentic-os';

const root = new URL('../../', import.meta.url);

test('repository profile pins protected ADLC and bounded worktree quarantine', async () => {
  const profile = JSON.parse(await readFile(new URL('.agentic-os.json', root), 'utf8'));
  const validated = validateRepositoryProfile(profile);

  assert.deepEqual(validated, profile);
  assert.equal(profile.repository, 'github.com/huijoohwee/agentic-commerce-os');
  assert.deepEqual(profile.canonical, {
    localRef: 'refs/heads/main',
    remoteRef: 'refs/remotes/origin/main',
  });
  assert.deepEqual(profile.requiredChecks, ['Integration Gate']);
  assert.deepEqual(profile.authority, { runtime: 'consumer', release: 'consumer' });
  assert.deepEqual(profile.cleanup, {
    worktreeProjection: 'quarantine',
    worktreeRegistration: 'quarantine',
    remoteTrackingRef: 'retain',
    localBranch: 'retain',
    remoteBranch: 'retain',
    unreachableObjects: 'retain',
  });
  assert.ok(profile.capabilities.includes('protected-integration:pull-request'));
  assert.ok(profile.capabilities.includes('integration-method:squash'));
  assert.ok(profile.capabilities.includes('quarantine-worktree-cleanup-opt-in'));
  assert.ok(!profile.capabilities.includes('retain-all-cleanup'));
});

test('package scripts and dependency pin the exact governing runtime', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

  assert.equal(pkg.devDependencies['agentic-os'],
    'https://codeload.github.com/huijoohwee/agentic-os/tar.gz/5c16f240835978df99ccb464def70d8a3fe1f296');
  assert.deepEqual({
    setup: pkg.scripts.setup,
    doctor: pkg.scripts.doctor,
    lane: pkg.scripts.lane,
    land: pkg.scripts.land,
    status: pkg.scripts.status,
    reap: pkg.scripts.reap,
    sync: pkg.scripts['sync:canonical'],
    queue: pkg.scripts['queue:show'],
  }, {
    setup: 'agentic-os setup',
    doctor: 'agentic-os doctor',
    lane: 'agentic-os start',
    land: 'agentic-os land',
    status: 'agentic-os status',
    reap: 'agentic-os reap',
    sync: 'agentic-os canonical-sync',
    queue: 'agentic-os queue show',
  });
});
