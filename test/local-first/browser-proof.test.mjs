import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER_CHECKS, BROWSER_PROOF_SCHEMA, assertBrowserProof } from '../../scripts/local-first-release/browser-proof.mjs';

const revision = 'a'.repeat(40);
const proof = { schema: BROWSER_PROOF_SCHEMA, ok: true, sourceRevision: revision,
  checkout: 'deferred', checks: Object.values(BROWSER_CHECKS) };

test('release accepts the complete browser suite bound to the candidate', () => {
  assert.equal(assertBrowserProof(proof, revision), proof);
  assert.doesNotThrow(() => assertBrowserProof({ ...proof, checks: [...proof.checks].reverse() }, revision));
});

test('release rejects missing merchant checks, duplicates and unknown results even at the expected count', () => {
  const legacy = proof.checks.filter(check => ![BROWSER_CHECKS.launch, BROWSER_CHECKS.review, BROWSER_CHECKS.economics].includes(check));
  for (const checks of [legacy, undefined, {}, [], [...proof.checks, 'unknown'],
    [...proof.checks.slice(0, -1), 'unknown'], [...legacy, ...legacy.slice(0, 3)]]) {
    assert.throws(() => assertBrowserProof({ ...proof, checks }, revision), /browser proof/);
  }
});

test('a complete suite cannot substitute a different source, profile or failed proof', () => {
  for (const changed of [null, {}, { ...proof, ok: false }, { ...proof, sourceRevision: 'b'.repeat(40) },
    { ...proof, checkout: 'enabled' }, { ...proof, schema: 'unrecognized' }]) {
    assert.throws(() => assertBrowserProof(changed, revision), /browser proof/);
  }
  assert.throws(() => assertBrowserProof(proof, ''), /browser proof/);
});
