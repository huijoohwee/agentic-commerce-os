import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  STORAGE_MANAGEMENT_ASSETS, STORAGE_MANAGEMENT_SOURCE_FILES,
  verifyStorageManagementSourceIndex, assertCleanCandidate,
} from '../local-first-release/artifact.mjs';

export const CONFIG = 'wrangler.storage-management.jsonc';
export const WORKER = 'agentic-commerce-storage-management-static';
export const ROUTES = Object.freeze([
  'airvio.co/agentic-commerce-os/storage-management',
  'airvio.co/agentic-commerce-os/storage-management/*',
]);
export const PUBLIC_PREFIX = '/agentic-commerce-os/storage-management';
export const OUTPUT = 'node_modules/.cache/storage-management-static';
const SOURCE = 'public/local-first/agentic-commerce-os/storage-management';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);

export function verifyStaticConfig(value = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))) {
  assert.deepEqual(Object.keys(value).sort(), ['$schema', 'name', 'compatibility_date', 'workers_dev', 'preview_urls',
    'observability', 'assets', 'routes'].sort());
  assert.equal(value.name, WORKER);
  assert.equal(value.compatibility_date, '2026-09-04');
  assert.equal(value.workers_dev, false);
  assert.equal(value.preview_urls, false);
  assert.deepEqual(value.observability, { enabled: false });
  assert.deepEqual(value.assets, { directory: `./${OUTPUT}/assets` });
  assert.deepEqual(value.routes, ROUTES.map(pattern => ({ pattern, zone_name: 'airvio.co' })));
  assert.equal(Object.hasOwn(value, 'main'), false);
  assert.equal(Object.hasOwn(value, 'bindings'), false);
  assert.equal(Object.hasOwn(value, 'triggers'), false);
  assert.equal(Object.hasOwn(value, 'env'), false);
  return value;
}

function regularFiles(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return regularFiles(path.join(root, entry.name), relative);
    assert.equal(entry.isFile(), true, 'static assets must be regular files');
    return [relative];
  }).sort();
}

function assetEntries(assetRoot) {
  return regularFiles(assetRoot).map(file => {
    const bytes = fs.readFileSync(path.join(assetRoot, file));
    return { path: file, bytes: bytes.length, sha256: hash(bytes) };
  });
}

export function verifyCandidate({ candidateSha, output = OUTPUT, manifestPath = path.join(output, 'candidate.json') }) {
  assert.match(candidateSha, /^[a-f0-9]{40}$/u);
  verifyStaticConfig();
  const sourceIndex = verifyStorageManagementSourceIndex();
  assert.equal(sourceIndex.servedFiles, STORAGE_MANAGEMENT_ASSETS.length);
  const root = path.resolve(output), assets = path.join(root, 'assets');
  const candidate = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(candidate.schema, 'commerce.storage-management-static-candidate/v1');
  assert.equal(candidate.candidateSha, candidateSha);
  assert.equal(candidate.worker, WORKER);
  assert.deepEqual(candidate.routes, ROUTES);
  assert.equal(candidate.publicRoute, 'https://airvio.co/agentic-commerce-os/storage-management/');
  assert.equal(candidate.totalBytes < 80000, true);
  assert.equal(candidate.files.length, STORAGE_MANAGEMENT_ASSETS.length);
  assert.deepEqual(candidate.files.map(row => row.path).sort(), STORAGE_MANAGEMENT_SOURCE_FILES
    .filter(file => STORAGE_MANAGEMENT_ASSETS.some(name => file.endsWith(`/${name}`))).sort());
  const actual = assetEntries(assets).filter(row => !['_headers', '_redirects'].includes(row.path));
  const metadata = assetEntries(assets).filter(row => ['_headers', '_redirects'].includes(row.path));
  assert.deepEqual(metadata, candidate.metadata);
  assert.deepEqual(actual, candidate.files);
  assert.deepEqual(regularFiles(assets).sort(), [...candidate.files.map(row => row.path), '_headers', '_redirects'].sort());
  const totalBytes = actual.reduce((sum, row) => sum + row.bytes, 0);
  assert.equal(totalBytes, candidate.totalBytes);
  assert.equal(candidate.assetDigest, hash(Buffer.from(canonical({ candidateSha, worker: WORKER, routes: ROUTES,
    publicRoute: candidate.publicRoute, files: actual, metadata, totalBytes }))));
  return candidate;
}

export function prepareCandidate(candidateSha, output = OUTPUT, { requireClean = true } = {}) {
  assert.match(candidateSha, /^[a-f0-9]{40}$/u);
  if (requireClean) assertCleanCandidate(candidateSha);
  verifyStaticConfig();
  verifyStorageManagementSourceIndex();
  const root = path.resolve(output), assets = path.join(root, 'assets'), target = path.join(assets,
    'agentic-commerce-os/storage-management');
  assert.equal(root, path.resolve(OUTPUT), 'candidate output path must use the reserved cache location');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const name of STORAGE_MANAGEMENT_ASSETS) {
    const source = path.resolve(SOURCE, name), destination = path.join(target, name);
    const stat = fs.lstatSync(source);
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
    const bytes = fs.readFileSync(source);
    const outputBytes = name === 'sw.js'
      ? Buffer.from(bytes.toString('utf8').replace('__RELEASE__', candidateSha)) : bytes;
    fs.writeFileSync(destination, outputBytes, { flag: 'wx' });
  }
  for (const file of ['_headers', '_redirects']) {
    fs.copyFileSync(path.join(SOURCE, file), path.join(assets, file), fs.constants.COPYFILE_EXCL);
  }
  const files = assetEntries(assets).filter(row => !['_headers', '_redirects'].includes(row.path));
  const metadata = assetEntries(assets).filter(row => ['_headers', '_redirects'].includes(row.path));
  const totalBytes = files.reduce((sum, row) => sum + row.bytes, 0);
  assert.equal(totalBytes < 80000, true, 'storage management static assets exceed 80 kB');
  assert.equal(files.length, STORAGE_MANAGEMENT_ASSETS.length);
  const candidate = {
    schema: 'commerce.storage-management-static-candidate/v1', candidateSha,
    worker: WORKER, routes: ROUTES,
    publicRoute: 'https://airvio.co/agentic-commerce-os/storage-management/',
    files, metadata, totalBytes,
    assetDigest: hash(Buffer.from(canonical({ candidateSha, worker: WORKER, routes: ROUTES,
      publicRoute: 'https://airvio.co/agentic-commerce-os/storage-management/', files, metadata, totalBytes }))),
  };
  fs.writeFileSync(path.join(root, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
  return verifyCandidate({ candidateSha, output: root, manifestPath: path.join(root, 'candidate.json') });
}

async function main() {
  const [command, candidateSha, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  if (command === 'prepare') {
    const candidate = prepareCandidate(candidateSha);
    process.stdout.write(`${JSON.stringify({ candidateSha, worker: WORKER, routes: ROUTES,
      files: candidate.files.length, totalBytes: candidate.totalBytes, assetDigest: candidate.assetDigest })}\n`);
    return;
  }
  if (command === 'verify') {
    const candidate = verifyCandidate({ candidateSha });
    process.stdout.write(`${JSON.stringify({ candidateSha, worker: WORKER, routes: ROUTES,
      files: candidate.files.length, totalBytes: candidate.totalBytes, assetDigest: candidate.assetDigest })}\n`);
    return;
  }
  throw new Error('usage: verify.mjs prepare|verify <candidate-sha>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
