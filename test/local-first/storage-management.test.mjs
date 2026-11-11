import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FILES, LOCAL_FIRST_ASSET_DIRECTORY, STORAGE_MANAGEMENT_SOURCE_FILES,
  assertLocalFirstConfig, prepareLocalFirstAssets, verifyStorageManagementSourceIndex,
} from '../../scripts/local-first-release/artifact.mjs';

test('storage guide has one static route owner and is excluded from the Commerce app bundle', () => {
  const index = verifyStorageManagementSourceIndex();
  assert.equal(index.sourceCount, 6);
  assert.equal(index.sourceFileCount, 9);
  assert.equal(index.servedFiles, 5);
  assert.ok(index.totalBytes < 80000);
  assert.ok(STORAGE_MANAGEMENT_SOURCE_FILES.some(file => file.endsWith('/sw.js')));
  assert.equal(FILES.some(file => file.startsWith('agentic-commerce-os/storage-management/')), false);

  const config = JSON.parse(fs.readFileSync('wrangler.local-first.jsonc', 'utf8'));
  assertLocalFirstConfig(config);
  const staged = prepareLocalFirstAssets();
  assert.equal(staged, path.resolve(LOCAL_FIRST_ASSET_DIRECTORY));
  assert.equal(fs.existsSync(path.join(staged, 'agentic-commerce-os/storage-management')), false);

  const worker = fs.readFileSync('public/local-first/sw.js', 'utf8');
  assert.doesNotMatch(worker, /STORAGE_GUIDE|storage-management/u);
});
