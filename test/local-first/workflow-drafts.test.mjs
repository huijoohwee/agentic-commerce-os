import test from 'node:test';
import assert from 'node:assert/strict';
import { importDrafts, parseImport, validWorkflow } from '../../public/local-first/drafts.js';

const draft = { id: '12345678-1234-1234-1234-123456789abc', title: 'Ceramic mug', description: 'Blue, 300 ml',
  price: '', revision: 1, createdAt: 1, updatedAt: 1 };
const encode = (version, value) => JSON.stringify({ schema: 'commerce.local-drafts/v' + version, drafts: [value] });
const intent = { runId: null, inputRevision: 1, title: draft.title, description: draft.description,
  status: 'queued', text: null, outputDigest: null, reviewedDigest: null };
test('v1 and v2 backups preserve bytes and normalize into the existing store with no job', () => {
  assert.deepEqual(parseImport(encode(1, draft))[0], { ...draft, launch: null, workflow: null });
  assert.deepEqual(parseImport(encode(2, { ...draft, launch: null }))[0], { ...draft, launch: null, workflow: null });
  assert.throws(() => parseImport(encode(2, { ...draft, launch: null, workflow: intent })));
});
test('v3 retains pending offline intent and bounded read models without importing execution authority', () => {
  const value = { ...draft, launch: null, workflow: intent };
  assert.deepEqual(parseImport(encode(3, value))[0], value);
  const complete = { ...intent, status: 'completed', runId: 'listing-' + 'a'.repeat(64), text: '<script>plain text</script>',
    outputDigest: 'b'.repeat(64), reviewedDigest: 'b'.repeat(64) };
  assert.equal(Boolean(validWorkflow(complete)), true);
  const imported = parseImport(encode(3, { ...value, workflow: complete }))[0];
  assert.equal(imported.workflow.text, complete.text);
  assert.equal(imported.workflow.outputDigest, complete.outputDigest);
  assert.equal(imported.workflow.reviewedDigest, null, 'an imported acknowledgement requires a fresh local review');
  for (const invalid of [{ ...complete, token: 'private' }, { ...complete, reviewedDigest: 'c'.repeat(64) },
    { ...complete, text: '界'.repeat(5400) }, { ...intent, status: 'completed' }, { ...complete, inputRevision: 2 }]) {
    assert.throws(() => parseImport(encode(3, { ...value, workflow: invalid })));
  }
});

test('new v3 imports fail before storage when the execution host has not admitted workflow writes', async () => {
  const text = encode(3, { ...draft, launch: null, workflow: intent });
  await assert.rejects(importDrafts(text), /execution host must be available/);
  await assert.rejects(importDrafts(text, async () => false), /execution host must be available/);
  await assert.rejects(importDrafts(text, async () => { throw Error('host unavailable'); }), /host unavailable/);
  assert.deepEqual(parseImport(text)[0].workflow, intent, 'reader and export recovery remain available');
});
