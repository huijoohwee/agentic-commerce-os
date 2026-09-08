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
    'https://codeload.github.com/huijoohwee/agentic-os/tar.gz/22a1a3eff6fc5e6cb3494f0f35cf1b410c92a9bc');
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

test('protected integration runs shared ADLC evaluations before product checks', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');

  assert.equal(pkg.scripts['check:adlc'], 'npm --prefix node_modules/agentic-os run evals');
  assert.equal(pkg.scripts['check:integration'],
    'npm run check:adlc && npm run check:evidence-contract && npm run check:implementation');
  assert.match(workflow, /^\s+run: npm run check:integration$/m);
  assert.equal(pkg.scripts.check, 'npm run check:integration && npm run check:evidence');
});
