import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System icon size from its offline shell assets', () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  assert.equal(pin.sourceRevision, '949cfc9b10b53f2d2b3b11e112203a404453c26b');
  assert.equal(pin.registryRevision, '082483d8829aed723ab31ff607944b54fa3ed5f3');
  const profile = fs.readFileSync('public/local-first/shared-ui-profile.css', 'utf8');
  assert.match(profile, /--agentic-font-size-body: 0\.875rem;/);
  assert.match(profile, /--agentic-line-height-body: 1\.25rem;/);
  const worker = fs.readFileSync('src/local-first/worker.ts', 'utf8');
  assert.match(worker, /'\/shared-ui-profile\.css'/);
})
