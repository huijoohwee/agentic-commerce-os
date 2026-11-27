import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_MIRROR_MANIFEST, CONTENT_MIRROR_SCHEMA, FILES, PRIVATE_FILES,
  digest, git, readLocalFirstAsset, verifyCommerceContentMirror } from '../../scripts/local-first-release/artifact.mjs';

const revision = git('rev-parse', 'HEAD'), tree = git('rev-parse', `${revision}^{tree}`);

function makeMirror(root) {
  const files = [...FILES, ...PRIVATE_FILES].sort().map(name => {
    const bytes = readLocalFirstAsset(name);
    fs.writeFileSync(path.join(root, name), bytes);
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  });
  const body = { schema: CONTENT_MIRROR_SCHEMA, repository: 'github.com/huijoohwee/agentic-commerce-os',
    sourceRevision: revision, sourceTree: tree, files, totalBytes: files.reduce((sum, row) => sum + row.bytes, 0) };
  fs.writeFileSync(path.join(root, CONTENT_MIRROR_MANIFEST), JSON.stringify({ ...body,
    manifestDigest: digest(JSON.stringify(body)) }, null, 2) + '\n');
}

test('Commerce mirror proves its exact source bytes, inventory and integrity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-mirror-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeMirror(root);
  const result = verifyCommerceContentMirror(root, { sourceRevision: revision, sourceTree: tree });
  assert.equal(result.sourceRevision, revision);
  assert.equal(result.fileCount, FILES.length + PRIVATE_FILES.length);
  assert(result.totalBytes <= 3000000);

  const victim = path.join(root, FILES[0]);
  fs.renameSync(victim, victim + '.saved');
  assert.throws(() => verifyCommerceContentMirror(root, { sourceRevision: revision, sourceTree: tree }), /missing or unexpected/u);
  fs.renameSync(victim + '.saved', victim);

  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'unexpected');
  assert.throws(() => verifyCommerceContentMirror(root, { sourceRevision: revision, sourceTree: tree }), /missing or unexpected/u);
  fs.rmSync(path.join(root, 'unexpected.txt'));

  fs.symlinkSync(victim, path.join(root, 'linked.txt'));
  assert.throws(() => verifyCommerceContentMirror(root, { sourceRevision: revision, sourceTree: tree }), /non-regular/u);
  fs.rmSync(path.join(root, 'linked.txt'));

  fs.appendFileSync(victim, 'tamper');
  assert.throws(() => verifyCommerceContentMirror(root, { sourceRevision: revision, sourceTree: tree }), /differs from its protected source/u);
});

test('Commerce release requires one exact protected content mirror in verify and deploy jobs', () => {
  const workflow = fs.readFileSync('.github/workflows/local-first-release.yml', 'utf8');
  assert.match(workflow, /mirror_sha:[\s\S]*required: true/u);
  assert.equal((workflow.match(/repository: huijoohwee\/huijoohwee/gu) ?? []).length, 2);
  assert.equal((workflow.match(/node scripts\/local-first-release\/artifact\.mjs verify-mirror/gu) ?? []).length, 2);
  assert.match(workflow, /contentMirror\?\.mirrorSha!==process\.env\.MIRROR_SHA/u);
});
