import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CONFIG = 'wrangler.local-first.jsonc';
export const WORKER = 'agentic-commerce-edge-production';
export const FILES = Object.freeze(['index.html', 'app.js', 'drafts.js', 'style.css', 'sw.js']);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 20000 }).trim();
export function assertLocalFirstConfig(config) {
  const keys = ['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'version_metadata', 'assets', 'vars'];
  if (Object.keys(config).sort().join() !== keys.sort().join() || config.name !== WORKER
    || config.main !== 'src/local-first/worker.ts' || config.workers_dev !== false || config.preview_urls !== false
    || JSON.stringify(config.assets) !== JSON.stringify({ directory: './public/local-first', binding: 'ASSETS', run_worker_first: true })
    || JSON.stringify(config.version_metadata) !== JSON.stringify({ binding: 'CF_VERSION_METADATA' })
    || JSON.stringify(config.vars) !== JSON.stringify({ RELEASE_CANDIDATE_SHA: 'local-unreleased' })) {
    throw Error('Local-first configuration must remain asset-only, private until route activation, and free of providers/secrets.');
  }
}
export function sourceManifest(revision) {
  if (!/^[0-9a-f]{40}$/.test(revision) || git('rev-parse', 'HEAD') !== revision) throw Error('Candidate source mismatch');
  assertLocalFirstConfig(JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
  if (fs.readdirSync('public/local-first').sort().join() !== [...FILES].sort().join()) throw Error('Unexpected static asset inventory');
  const paths = [CONFIG, 'src/local-first/worker.ts', 'src/edge/production-prefix.ts', ...FILES.map(file => 'public/local-first/' + file)];
  const entries = paths.sort().map(file => {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Non-regular artifact source');
    const bytes = fs.readFileSync(file); if (bytes.length >= 500000) throw Error('Artifact file exceeds 500 kB');
    return { path: file, bytes: bytes.length, digest: digest(bytes) };
  });
  const body = { schema: 'commerce.local-first-artifact/v1', profile: 'local-first', checkout: 'deferred',
    sourceRevision: revision, sourceTree: git('rev-parse', 'HEAD^{tree}'), entries };
  return { ...body, artifactDigest: digest(JSON.stringify(body)) };
}
export function assertCleanCandidate(revision) {
  if (git('rev-parse', 'HEAD') !== revision || git('status', '--porcelain', '--untracked-files=all')) throw Error('Candidate must be exact and clean');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const revision = process.env.CANDIDATE_SHA || git('rev-parse', 'HEAD');
  const output = path.resolve(process.env.LOCAL_FIRST_EVIDENCE_DIR || 'node_modules/.cache/local-first-verification');
  fs.mkdirSync(output, { recursive: true });
  const manifest = sourceManifest(revision);
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '-c', CONFIG, '--dry-run', '--minify',
    '--outdir', path.join(output, 'bundle'), '--var', `RELEASE_CANDIDATE_SHA:${revision}`], { stdio: 'inherit', timeout: 120000 });
  const bundle = fs.readdirSync(path.join(output, 'bundle')).filter(file => /\.m?js$/.test(file));
  if (!bundle.length || bundle.some(file => fs.statSync(path.join(output, 'bundle', file)).size >= 500000)) throw Error('Worker chunk budget failed');
  fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, artifactDigest: manifest.artifactDigest, files: manifest.entries.length }));
}
