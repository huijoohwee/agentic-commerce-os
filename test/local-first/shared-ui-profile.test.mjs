import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System icon size from its offline shell assets', () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  assert.equal(pin.sourceRevision, '3224afd19c086e511dcfd892d82d12b68460b971');
  assert.equal(pin.registryRevision, 'f5faa7887d22ffbd61121f30485a8d9ecca957e4');
  const worker = fs.readFileSync('src/local-first/worker.ts', 'utf8');
  assert.match(worker, /'\/shared-ui-profile\.css'/);
})
