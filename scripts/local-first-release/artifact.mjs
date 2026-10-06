import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyGraphBundle } from '../workspace-pack/build-graph.mjs';
import { FULFILLMENT_CONFIG, readFulfillmentRelease } from './fulfillment.mjs';
import { readCheckoutRelease, liveAuthorizationScope } from './live-profile.mjs';

export const CONFIG = 'wrangler.local-first.jsonc';
export const WORKER = 'agentic-commerce-edge-production';
export const FILES = Object.freeze(['index.html', 'workspace.js', 'workspace-capabilities.js', 'workspace-tools.js', 'workspace-graph.js', 'graph-data-view.js', 'graph-data-view.css', 'graph-ui-tokens.css', 'app.js', 'drafts.js', 'launch.js', 'checkout.js', 'workflow.js', 'style.css', 'sw.js', 'workspace-pack.html', 'workspace-pack.js', 'workspace-pack.css', 'workspace-pack.simulation.js', 'workspace-pack.console.js']);
export const PRIVATE_FILES = Object.freeze(['education-materials.md']);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 20000 }).trim();
export function assertLocalFirstConfig(config) {
  const keys = ['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'version_metadata', 'assets', 'vars'];
  if (Object.keys(config).sort().join() !== keys.sort().join() || config.name !== WORKER
    || config.main !== 'src/local-first/worker.ts' || config.workers_dev !== false || config.preview_urls !== false
    || JSON.stringify(config.assets) !== JSON.stringify({ directory: './public/local-first', binding: 'ASSETS', run_worker_first: true })
    || JSON.stringify(config.version_metadata) !== JSON.stringify({ binding: 'CF_VERSION_METADATA' })
    || JSON.stringify(config.vars) !== JSON.stringify({ RELEASE_CANDIDATE_SHA: 'local-unreleased', CHECKOUT_MODE: 'sandbox' })) {
    throw Error('Local-first configuration must remain sandbox-only, private until route activation, and free of payment providers or financial resources.');
  }
}
export function verifyGraphDataView() {
  const manifestFile = 'config/graph-data-view.json', manifestStat = fs.lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size < 1 || manifestStat.size >= 500000) throw Error('Graph data view manifest invalid');
  const pin = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (pin.schema !== 'agentic-graph/data-view-artifact/v1' || pin.sourceDirty !== false || !/^[0-9a-f]{40}$/.test(pin.sourceRevision)) throw Error('Graph data view provenance invalid');
  if (pin.entry !== 'canvas/src/features/markdown/ui/dataViewBrowserAdapter.tsx' || pin.browserExport !== 'mountDataView' || pin.cssScope !== 'shadow-root' || pin.hostTokens !== 'graph-ui-tokens.css'
    || JSON.stringify(pin.browserExports) !== JSON.stringify(['mountDataView', 'mountSequenceGuide'])
    || !Array.isArray(pin.inputs) || !pin.inputs.length || pin.inputs.length > 100 || digest(JSON.stringify(pin.inputs)) !== pin.inputDigest) throw Error('Graph data view source contract invalid');
  const paths = new Set(); let totalInputBytes = 0, previousPath = '';
  for (const input of pin.inputs) {
    if (!input || typeof input.path !== 'string' || input.path.startsWith('/') || input.path.includes('..') || input.path.includes('\\') || input.path <= previousPath
      || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 2000000 || !/^[0-9a-f]{64}$/.test(input.sha256)
      || input.path.startsWith('canvas/src/') && /(?:\/hooks\/|useGraphStore|useSequenceDocument|\/(?:stores?|storage|three|mermaid|rich-media)\/)/.test(input.path)) throw Error('Graph data view input invalid');
    paths.add(input.path); previousPath = input.path; totalInputBytes += input.bytes;
  }
  const owners = [pin.entry, 'canvas/scripts/build-data-view-adapter.mjs', 'canvas/src/features/markdown/ui/MarkdownDataViewTableCore.tsx',
    'canvas/src/features/sequence/sequenceGuideBrowserAdapter.tsx', 'canvas/src/features/sequence/SequenceInspectorView.tsx',
    'canvas/src/features/sequence/SequenceFlow.css', 'canvas/src/components/ui/FloatingPanel.tsx', 'canvas/src/lib/ui/floatingPanelGeometry.ts',
    'canvas/src/index.css', 'canvas/src/styles/responsive-toolbar.css', 'grph-shared/src/ui/themeTokens.ts',
    'grph-shared/src/ui/kgTokens.ts', 'grph-shared/src/ui/typography.ts'];
  if (totalInputBytes > 8000000 || owners.some(owner => !paths.has(owner))) throw Error('Graph data view native owner missing or over budget');
  const names = ['graph-data-view.js', 'graph-data-view.css', 'graph-ui-tokens.css'];
  if (!Array.isArray(pin.outputs) || pin.outputs.length !== names.length || names.some(name => !pin.outputs.some(row => row.path === name))) throw Error('Graph data view inventory invalid');
  for (const output of pin.outputs) {
    const file = 'public/local-first/' + output.path, stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size >= 500000) throw Error('Graph data view asset invalid');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== output.bytes || digest(bytes) !== output.sha256) throw Error('Graph data view asset differs from its native owner');
    const text = bytes.toString('utf8');
    if (output.path.endsWith('.css') ? /@import\b|url\(\s*['"]?(?:https?:|\/\/)/i.test(text)
      : /\bimport\s*(?:\(|['"]|[^;\n]*?\bfrom\s*['"])|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(text)) throw Error('Graph data view asset must remain offline');
  }
  return pin;
}
export function sourceManifest(revision, selection = readCheckoutRelease()) {
  if (!/^[0-9a-f]{40}$/.test(revision) || git('rev-parse', 'HEAD') !== revision) throw Error('Candidate source mismatch');
  verifyGraphBundle();
  verifyGraphDataView();
  assertLocalFirstConfig(JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
  if (fs.readdirSync('public/local-first').sort().join() !== [...FILES, ...PRIVATE_FILES].sort().join()) throw Error('Unexpected static asset inventory');
  const paths = [CONFIG, 'src/local-first/worker.ts', 'src/local-first/workspace-pack.ts', 'src/local-first/workspace-service.ts', 'config/capability-token-map.json',
    'config/graph-data-view.json', 'config/workspace-pack-graph.json', 'src/generated/graph-workspace-pack.js', 'src/generated/graph-workspace-pack.d.ts',
    'scripts/workspace-pack/build-graph.mjs', 'src/edge/production-prefix.ts', 'src/shared/http.ts',
    ...['checkout', 'session', 'fulfillment-contract', 'fulfillment-definition', 'fulfillment', 'fulfillment-relay', 'stripe-checkout', 'checkout-offer', 'checkout-recovery', 'stripe-webhook'].map(file => `src/local-first/${file}.ts`),
    'src/sandbox/device-host.ts', 'package.json', 'package-lock.json',
    ...[...FILES, ...PRIVATE_FILES].map(file => 'public/local-first/' + file)];
  if (readFulfillmentRelease()) paths.push(FULFILLMENT_CONFIG);
  const entries = paths.sort().map(file => {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Non-regular artifact source');
    const bytes = fs.readFileSync(file); if (bytes.length >= 500000) throw Error('Artifact file exceeds 500 kB');
    return { path: file, bytes: bytes.length, digest: digest(bytes) };
  });
  const live = liveAuthorizationScope(selection);
  const body = { schema: live ? 'commerce.local-first-live-artifact/v1' : 'commerce.local-first-artifact/v2',
    profile: 'local-first', checkout: selection.checkout, ...(live ? {live} : {}),
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
