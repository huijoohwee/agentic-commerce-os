import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETAIN_ALL_CLEANUP,
  validateRepositoryProfile,
} from 'agentic-os';

const root = new URL('../../', import.meta.url);

test('repository profile pins the protected retain-only ADLC consumer contract', async () => {
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
  assert.deepEqual(profile.cleanup, RETAIN_ALL_CLEANUP);
  assert.ok(profile.capabilities.includes('protected-integration:pull-request'));
  assert.ok(profile.capabilities.includes('integration-method:squash'));
  assert.ok(profile.capabilities.includes('retain-all-cleanup'));
});

test('package scripts and dependency pin the exact governing runtime', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

  assert.equal(pkg.devDependencies['agentic-os'],
    'https://codeload.github.com/huijoohwee/agentic-os/tar.gz/3d27ffd564d311709193ca11dd20746e0851b96a');
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
