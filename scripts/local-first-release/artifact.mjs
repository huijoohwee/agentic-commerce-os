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
export const FILES = Object.freeze(['index.html', 'favicon.svg', 'workspace.js', 'workspace-navigation.js', 'workspace-singleton.js', 'shopper-demo-detail.js', 'workspace-tour.js', 'workspace-capabilities.js', 'workspace-tools.js', 'workspace-graph.js', 'agentic-base-data-view.js', 'agentic-base-data-view.css', 'graph-data-view.js', 'graph-data-view.css', 'graph-ui-tokens.css', 'commerce-theme.css', 'workspace-shell.css', 'app.js', 'drafts.js', 'launch.js', 'checkout.js', 'workflow.js', 'style.css', 'sw.js', 'workspace-pack.html', 'workspace-pack.js', 'workspace-pack.css', 'workspace-pack.simulation.js', 'workspace-pack.console.js', 'sme-business-pack.js', 'sme-business-pack.css', 'sme-business-pack-core.js', 'sme-pack-sg.js', 'sme-pack-my.js']);
export const PRIVATE_FILES = Object.freeze(['education-materials.md']);
export const digest = value => createHash('sha256').update(value).digest('hex');
const COMMERCE_THEME_PIN = Object.freeze({
  sourceRevision: 'c18253b35e8bcc0bed548cfb717ec31909422dbe',
  profileDigest: '000adeb267d0d0ff9527e1227faefcd5fd2c15faee463fa70173204783ea7c9e',
  stylesheetDigest: 'c512ee76dc6160ff41e8bac9706b8e8d0b9e56f42b6c4b128594605e19c93474',
});
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
export function verifyAgenticBaseDataView() {
  const manifestFile = 'config/agentic-base-data-view.json', manifestStat = fs.lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size < 1 || manifestStat.size >= 500000) throw Error('Agentic Base data view manifest invalid');
  const pin = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (pin.schema !== 'agentic-base/consumer-artifact/v1' || pin.source?.repository !== 'github.com/huijoohwee/agentic-base'
    || pin.source?.sourceDirty !== false || !/^[0-9a-f]{40}$/.test(pin.source?.revision ?? '')
    || pin.source?.package !== '@agentic-base/views-react' || pin.source?.packageVersion !== '0.1.0'
    || pin.source?.packagePath !== 'packages/views-react' || pin.source?.buildManifest !== 'packages/views-react/dist/browser-data-view.manifest.json'
    || !/^[0-9a-f]{64}$/.test(pin.source?.buildManifestSha256 ?? '')) throw Error('Agentic Base data view provenance invalid');
  if (pin.contract?.source !== 'agentic-base/browser-data-view/v1' || pin.contract?.browserExport !== 'mountDataView'
    || pin.contract?.cssScope !== 'shadow-root'
    || JSON.stringify(pin.contract?.hostThemeSlots) !== JSON.stringify(['--agentic-base-text', '--agentic-base-surface', '--agentic-base-border', '--agentic-base-muted', '--agentic-base-header', '--agentic-base-selected', '--agentic-base-hover', '--agentic-base-focus'])
    || !Array.isArray(pin.inputs) || !pin.inputs.length || pin.inputs.length > 20
    || !/^\d+\.\d+\.\d+$/.test(pin.build?.esbuild ?? '')) throw Error('Agentic Base data view source contract invalid');
  const inputPaths = new Set(); let totalInputBytes = 0;
  for (const input of pin.inputs) {
    if (!input || typeof input.path !== 'string' || input.path.startsWith('/') || input.path.includes('..') || input.path.includes('\\')
      || inputPaths.has(input.path) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 2000000
      || !/^[0-9a-f]{64}$/.test(input.sha256)) throw Error('Agentic Base data view input invalid');
    inputPaths.add(input.path); totalInputBytes += input.bytes;
  }
  if (totalInputBytes > 8000000 || !inputPaths.has('packages/views-react/src/browser/DataViewBrowserAdapter.tsx')
    || !inputPaths.has('packages/views-react/src/table/DataTableCore.tsx') || !inputPaths.has('packages/views-react/src/table/TableCore.tsx')) {
    throw Error('Agentic Base data view native owner missing or over budget');
  }
  const outputs = ['agentic-base-data-view.js', 'agentic-base-data-view.css'];
  if (!Array.isArray(pin.outputs) || pin.outputs.length !== outputs.length || outputs.some(name => !pin.outputs.some(row => row.path === name))) throw Error('Agentic Base data view inventory invalid');
  for (const output of pin.outputs) {
    if (output.sourcePath !== (output.path.endsWith('.js') ? 'browser-data-view.js' : 'browser-data-view.css')) throw Error('Agentic Base output source invalid');
    const file = 'public/local-first/' + output.path, stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size >= 500000) throw Error('Agentic Base data view asset invalid');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== output.bytes || digest(bytes) !== output.sha256) throw Error('Agentic Base data view asset differs from its pinned source');
    const text = bytes.toString('utf8');
    if (output.path.endsWith('.css') ? /@import\b|url\(\s*['"]?(?:https?:|\/\/)/i.test(text)
      : /\bimport\s*(?:\(|['"]|[^;\n]*?\bfrom\s*['"])|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(text)
        || !text.includes('mountDataView') || !text.includes('DATA_VIEW_BROWSER_LIMITS')) throw Error('Agentic Base data view asset must remain self-contained and offline');
  }
  return pin;
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
export function verifySharedThemeOwner() {
  const directory = 'public/local-first';
  const themeBytes = fs.readFileSync(path.join(directory, 'commerce-theme.css'));
  const theme = themeBytes.toString('utf8');
  const provenance = theme.match(/^\/\* Generated from agentic-design-system ([a-f0-9]{40}); profile sha256 ([a-f0-9]{64})\. Do not edit\. \*\//u);
  if (!provenance || provenance[1] !== COMMERCE_THEME_PIN.sourceRevision
    || provenance[2] !== COMMERCE_THEME_PIN.profileDigest
    || digest(themeBytes) !== COMMERCE_THEME_PIN.stylesheetDigest)
    throw Error('Commerce theme projection differs from its pinned design-system profile');
  if (/@import\b|url\(\s*["']?(?:https?:|\/\/)/i.test(theme))
    throw Error('Commerce theme projection must stay self-contained and offline');
  const tokenNames = [...theme.matchAll(/(?:^|[;{])\s*(--commerce-[\w-]+)\s*:/g)].map(match => match[1]);
  if (!theme.includes(':root {') || !tokenNames.length || new Set(tokenNames).size !== tokenNames.length)
    throw Error('Commerce theme tokens must have one generated owner and one definition each');
  const shell = fs.readFileSync(path.join(directory, 'workspace-shell.css'), 'utf8');
  if (/(?:^|[;{])\s*--commerce-[\w-]+\s*:/i.test(shell))
    throw Error('Shared shell layout must not redefine Commerce theme tokens');
  const stylesheets = fs.readdirSync(directory).filter(name => name.endsWith('.css'));
  const declaredTokens = new Set(tokenNames);
  const oldNames = '(?:ink|muted|line|control|paper|green|surface|accent|soft|focus|mono|radius-control|radius-panel|space-[\\w-]+)';
  if (new RegExp(`--${oldNames}(?![\\w-])`).test(theme) || new RegExp(`--${oldNames}(?![\\w-])`).test(shell))
    throw Error('Legacy Commerce theme tokens remain in the shared owner');
  const unresolvedTokens = new Set();
  for (const file of stylesheets) {
    const css = fs.readFileSync(path.join(directory, file), 'utf8');
    if (file !== 'commerce-theme.css' && /--commerce-[\w-]+\s*:/i.test(css)) {
      throw Error(`Shared Commerce theme override found in ${file}`);
    }
    for (const [, name] of css.matchAll(/var\(\s*(--commerce-[\w-]+)/g)) {
      if (!declaredTokens.has(name)) unresolvedTokens.add(name);
    }
  }
  for (const file of FILES.filter(name => !name.endsWith('.css'))) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    if (/(?:^|[;{])\s*--commerce-[\w-]+\s*:/i.test(source)) throw Error(`Non-CSS Commerce theme override found in ${file}`);
  }
  if (unresolvedTokens.size) throw Error(`Unresolved Commerce theme tokens: ${[...unresolvedTokens].join(', ')}`);
  for (const file of ['style.css', 'sme-business-pack.css', 'workspace-pack.css']) {
    const css = fs.readFileSync(path.join(directory, file), 'utf8');
    if (new RegExp(`--${oldNames}(?![\\w-])`).test(css)) throw Error(`Legacy generic theme alias found in ${file}`);
  }
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const themeImports = html.match(/<link\b[^>]*href=["'][^"']*commerce-theme\.css(?:\?[^"']*)?["'][^>]*>/gi) || [];
  const shellImports = html.match(/<link\b[^>]*href=["'][^"']*workspace-shell\.css(?:\?[^"']*)?["'][^>]*>/gi) || [];
  if (themeImports.length !== 1 || shellImports.length !== 1 || html.indexOf(themeImports[0]) > html.indexOf(shellImports[0]))
    throw Error('Commerce routes must load one generated theme and one shared shell');
  const legacyPalette = ['#315ff5', '#202a39', '#cbd8ef', '#eaf0ff', '#8391a8', '#7788a4', '#526581', '#43536d',
    '#b6c8eb', '#f5f8ff', '#f8faff', '#f7f9fd', '#f9fbff', '#fbfcff', '#f4f7fd', '#edf3ff', '#eef3ff', '#f0f4ff', '#9999a1', '#fff'];
  for (const file of ['index.html', 'style.css', 'workspace-shell.css', 'sme-business-pack.css']) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    const stale = legacyPalette.find(color => new RegExp(`${color}(?![a-f0-9])`, 'i').test(source));
    if (stale) throw Error(`Shared Commerce palette literal remains in ${file}: ${stale}`);
  }
  const illustrationPalette = new Set(['#eaf0f9', '#edf1f8', '#e8eef8', '#dce7fb', '#d7e2f5', '#e3ebfa', '#526587', '#7183a3', '#34445f', '#eaf0fb', '#00000004']);
  for (const file of ['style.css', 'sme-business-pack.css', 'workspace-shell.css']) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    if (/var\(\s*--commerce-[^)]+\)[a-f0-9]{2,8}/i.test(source)) throw Error(`Malformed Commerce color token in ${file}`);
    const unowned = [...source.matchAll(/#[a-f0-9]{3,8}\b/gi)].map(match => match[0].toLowerCase()).find(color => !illustrationPalette.has(color));
    if (unowned) throw Error(`Unowned Commerce color literal remains in ${file}: ${unowned}`);
  }
  const canvas = theme.match(/--commerce-canvas\s*:\s*(#[a-f0-9]{6})\s*;/i)?.[1]?.toLowerCase();
  const browserTheme = html.match(/<meta\b[^>]*name=["']theme-color["'][^>]*content=["'](#[a-f0-9]{6})["'][^>]*>/i)?.[1]?.toLowerCase();
  if (!canvas || browserTheme !== canvas) throw Error('Browser theme color must match the shared Commerce canvas token');
  if (/(?:^|[;{])\s*--commerce-[\w-]+\s*:/i.test(html)) throw Error('Inline Commerce theme overrides are not allowed');
  const symbols = [...html.matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  if (new Set(symbols).size !== symbols.length) throw Error('Commerce icon symbol IDs must be unique');
  for (const symbol of ['icon-navigation', 'icon-search']) {
    if (symbols.filter(id => id === symbol).length !== 1) throw Error(`Shared Commerce icon missing or duplicated: ${symbol}`);
  }
  const navigationTemplates = [...html.matchAll(/<template\s+id="(shop|vendor|admin|sme)-navigation-content">([\s\S]*?)<\/template>/g)];
  if (navigationTemplates.length !== 4) throw Error('Each commerce role must use the shared navigation icon template contract');
  for (const [, role, source] of navigationTemplates) {
    const refs = [...source.matchAll(/<use\b[^>]*href=["']#(icon-[\w-]+)["']/g)].map(match => match[1]);
    if (!refs.length || refs.some(ref => !symbols.includes(ref)) || /<(?:path|circle|rect|line|polyline|polygon)\b/.test(source))
      throw Error(`Commerce ${role} navigation must reference shared icon symbols without duplicate path art`);
  }
  const navigation = fs.readFileSync(path.join(directory, 'workspace-navigation.js'), 'utf8');
  if (!navigation.includes("createIcon('icon-navigation')") || !navigation.includes("createIcon('icon-search')")
    || /<(?:path|circle|rect)\b/.test(navigation)
    || !navigation.includes('export function assertSharedWorkspaceShell()')
    || !navigation.includes("document.querySelectorAll('.topbar').length !== 1")
    || !navigation.includes("document.querySelectorAll('.console-sidebar').length !== 1")
    || !navigation.includes("document.querySelectorAll('.workspace-footer').length !== 1")) {
    throw Error('Shared shell components and icons must keep one fail-loud source');
  }
  return { owner: 'commerce-theme.css', tokenCount: tokenNames.length, iconCount: symbols.length };
}
export function sourceManifest(revision, selection = readCheckoutRelease()) {
  if (!/^[0-9a-f]{40}$/.test(revision) || git('rev-parse', 'HEAD') !== revision) throw Error('Candidate source mismatch');
  verifyGraphBundle();
  verifyAgenticBaseDataView();
  verifyGraphDataView();
  verifySharedThemeOwner();
  assertLocalFirstConfig(JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
  if (fs.readdirSync('public/local-first').sort().join() !== [...FILES, ...PRIVATE_FILES].sort().join()) throw Error('Unexpected static asset inventory');
  const paths = [CONFIG, 'src/local-first/worker.ts', 'src/local-first/workspace-pack.ts', 'src/local-first/workspace-service.ts', 'src/local-first/sme-business-pack.ts', 'public/local-first/sme-business-pack-core.js', 'config/capability-token-map.json',
    'config/agentic-base-data-view.json', 'config/graph-data-view.json', 'config/workspace-pack-graph.json', 'src/generated/graph-workspace-pack.js', 'src/generated/graph-workspace-pack.d.ts',
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
