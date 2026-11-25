import { gunzipSync } from 'node:zlib';
import { verifyGeoProjection } from '../agentic-geo-projection.mjs';
import fs from 'node:fs';
import { verifyTimelineBundle } from '../sme-review/build-timeline.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyGraphBundle } from '../workspace-pack/build-graph.mjs';
import { FULFILLMENT_CONFIG, readFulfillmentRelease } from './fulfillment.mjs';
import { readCheckoutRelease, liveAuthorizationScope } from './live-profile.mjs';

export const CONFIG = 'wrangler.local-first.jsonc';
export const WORKER = 'agentic-commerce-edge-production';
export const FILES = Object.freeze(['index.html', 'favicon.svg', 'workspace.js', 'workspace-navigation.js', 'workspace-pack.route.js', 'workspace-view-styles.js', 'commerce-toolbar.js', 'commerce-shell.css', 'workspace-layout.js', 'commerce-dashboard.js', 'dashboard.js', 'dashboard-columns.js', 'toolbar-icons.js', 'icons.json', 'workspace-singleton.js', 'shopper-demo-detail.js', 'workspace-tour.js', 'workspace-capabilities.js', 'workspace-tools.js', 'workspace-graph.js', 'agentic-base-data-view.js', 'dropdown-menus.js', 'agentic-base-data-view.css', 'graph-data-view.js', 'graph-data-view.css', 'graph-ui-tokens.css', 'commerce-theme.css', 'workspace-shell.css', 'shared-ui-profile.css', 'collection-layout.css', 'listing-geo.js', 'agentic-geo-core.mjs', 'app.js', 'offer-simulator.js', 'offer-simulator-view.js', 'drafts.js', 'record-links.js', 'checkout.js', 'launch.js', 'workflow.js', 'style.css', 'sw.js', 'workspace-pack.html', 'workspace-pack.js', 'workspace-pack.css', 'floating-panel.css', 'floating-panel.js', 'skills-commands.css', 'toolbar.css', 'workspace-pack.simulation.js', 'workspace-pack.console.js', 'sme-business-pack.js', 'sme-business-pack.css', 'sme-business-pack-core.js', 'sme-decision-contract.js', 'sme-workflow-editor.js', 'key-type-value.js', 'markdown.js', 'markdown-parser.js', 'color.js', 'rich-text.css', 'viewer-surface.js', 'viewer-surface.css', 'panel-section.js', 'panel-section.css', 'hover.js', 'hover-text.js', 'hover.css', 'sme-review-workflow.js', 'graph-gantt-timeline.js', 'graph-gantt-timeline.css', 'sme-pack-business-plan.js', 'sme-pack-dictionary.js', 'housing-comparison.js', 'housing-engine.js', 'housing-sample.js', 'housing-comparison.css']);
export const PRIVATE_FILES = Object.freeze(['education-materials.md', '_headers', '_redirects']);
export const STORAGE_MANAGEMENT_ASSETS = Object.freeze(['index.html', 'style.css', 'guide.js', 'sources.json', 'sw.js']);
export const STORAGE_MANAGEMENT_SOURCE_FILES = Object.freeze([
  ...STORAGE_MANAGEMENT_ASSETS.map(file => `agentic-commerce-os/storage-management/${file}`),
  'agentic-commerce-os/storage-management/_headers', 'agentic-commerce-os/storage-management/_redirects',
]);
export const LOCAL_FIRST_ASSET_DIRECTORY = './node_modules/.cache/local-first-assets';
export const LOCAL_FIRST_DEV_INDEX_ALIAS = '__local-first-index.html';
export const digest = value => createHash('sha256').update(value).digest('hex');
function readDesignSystemStaticRelease() {
  const release = JSON.parse(fs.readFileSync('config/design-system-static-release.json', 'utf8'));
  if (release.schema !== 'agentic-commerce-design-system-static-release/v1'
    || release.source?.repository !== 'github.com/huijoohwee/agentic-design-system'
    || !/^[a-f0-9]{40}$/.test(release.source?.revision ?? '') || !Array.isArray(release.files)
    || !release.profilePins?.sharedUi)
    throw Error('Design System static release provenance invalid');
  const files = new Map(release.files.map(file => [file.path, file]));
  if (files.size !== release.files.length) throw Error('Design System static release has duplicate paths');
  return { owner: release.source.repository, revision: release.source.revision, profilePins: release.profilePins, files };
}
function readSharedUiIconPin() {
  const pin = JSON.parse(fs.readFileSync('config/shared-ui-profile.pin.json', 'utf8'));
  const profile = pin.profile;
  if (pin.schema !== 'agentic-design-system/consumer-pin/v1' || profile?.id !== 'shared-ui'
    || profile.owner !== 'github.com/huijoohwee/agentic-design-system'
    || !/^[a-f0-9]{40}$/.test(profile.sourceRevision ?? '') || !/^[a-f0-9]{40}$/.test(profile.registryRevision ?? '')
    || profile.sourcePath !== 'site/tokens/shared-ui-profile.json'
    || !/^sha256:[a-f0-9]{64}$/.test(profile.sourceSha256 ?? '')
    || profile.projectionPath !== 'site/vendor/shared-ui-profile.css'
    || !/^sha256:[a-f0-9]{64}$/.test(profile.projectionSha256 ?? ''))
    throw Error('Design System shared UI profile pin invalid');
  return Object.freeze({ owner: profile.owner, sourceRevision: profile.sourceRevision, registryRevision: profile.registryRevision,
    profileSha256: profile.sourceSha256.slice(7), projectionSha256: profile.projectionSha256.slice(7) });
}
export const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 20000 }).trim();
export function assertLocalFirstConfig(config) {
  const keys = ['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'version_metadata', 'assets', 'vars'];
  if (Object.keys(config).sort().join() !== keys.sort().join() || config.name !== WORKER
    || config.main !== 'src/local-first/worker.ts' || config.workers_dev !== false || config.preview_urls !== false
    || JSON.stringify(config.assets) !== JSON.stringify({ directory: LOCAL_FIRST_ASSET_DIRECTORY, binding: 'ASSETS', run_worker_first: ['/agentic-commerce-os/*', '!/agentic-commerce-os/storage-management', '!/agentic-commerce-os/storage-management/*'] })
    || JSON.stringify(config.version_metadata) !== JSON.stringify({ binding: 'CF_VERSION_METADATA' })
    || JSON.stringify(config.vars) !== JSON.stringify({ RELEASE_CANDIDATE_SHA: 'local-unreleased', CHECKOUT_MODE: 'sandbox' })) {
    throw Error('Local-first configuration must remain sandbox-only, private until route activation, and free of payment providers or financial resources.');
  }
}
const baseBundle = 'agentic-base-data-view.js';
const sourceName = name => name === baseBundle ? name + '.gz' : name;
export function readLocalFirstAsset(name) {
  const source = path.resolve('public/local-first'), input = path.resolve(source, sourceName(name));
  if (!input.startsWith(source + path.sep)) throw Error('Local-first asset escaped its source directory');
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= 500000) throw Error('Invalid local-first asset source');
  const bytes = fs.readFileSync(input);
  if (name !== baseBundle) return bytes;
  const raw = gunzipSync(bytes, { maxOutputLength: 499999 });
  const pin = JSON.parse(fs.readFileSync('config/agentic-base-data-view.json', 'utf8'));
  const output = pin.outputs.find(row => row.path === baseBundle);
  if (output?.bytes !== raw.length || output.sha256 !== digest(raw)) throw Error('Packed Base bundle differs from its pinned source');
  return raw;
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
    || pin.contract?.cssScope !== 'shadow-root' || pin.contract?.defaultLayout !== 'table'
    || JSON.stringify(pin.contract?.layoutModes) !== JSON.stringify(['table', 'multiDimensional', 'kanban'])
    || JSON.stringify(pin.contract?.hostThemeSlots) !== JSON.stringify(['--agentic-base-text', '--agentic-base-surface', '--agentic-base-border', '--agentic-base-muted', '--agentic-base-header', '--agentic-base-selected', '--agentic-base-hover', '--agentic-base-focus'])
    || !Array.isArray(pin.inputs) || !pin.inputs.length || pin.inputs.length > 64
    || !/^\d+\.\d+\.\d+$/.test(pin.build?.esbuild ?? '')) throw Error('Agentic Base data view source contract invalid');
  const inputPaths = new Set(); let totalInputBytes = 0;
  for (const input of pin.inputs) {
    if (!input || typeof input.path !== 'string' || input.path.startsWith('/') || input.path.includes('..') || input.path.includes('\\')
      || inputPaths.has(input.path) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 2000000
      || !/^[0-9a-f]{64}$/.test(input.sha256)) throw Error('Agentic Base data view input invalid');
    inputPaths.add(input.path); totalInputBytes += input.bytes;
  }
  if (totalInputBytes > 8000000 || !inputPaths.has('packages/views-react/src/browser/DataViewBrowserAdapter.tsx')
    || !inputPaths.has('packages/views-react/src/kanban/KanbanView.tsx') || !inputPaths.has('packages/views-react/src/browser/RecordViewToolbar.tsx')
    || !inputPaths.has('packages/views-react/src/table/MultiDimTableView.tsx')
    || !inputPaths.has('packages/views-react/src/controls/icons.json') || !inputPaths.has('packages/views-react/src/controls/icons.pin.json')
    || !inputPaths.has('packages/views-react/src/browser/base-profile.css') || !inputPaths.has('packages/views-react/src/browser/base-profile.pin.json')
    || !inputPaths.has('packages/views-react/src/table/TableView.tsx') || !inputPaths.has('packages/views-react/src/table/TableCore.tsx')) {
    throw Error('Agentic Base data view native owner missing or over budget');
  }
  const relationshipSource = pin.inputs.find(input => input.path === 'src/record-links.mjs');
  const relationshipBytes = readLocalFirstAsset('record-links.js');
  if (relationshipSource?.bytes !== relationshipBytes.length || relationshipSource.sha256 !== digest(relationshipBytes))
    throw Error('Commerce record links differ from the pinned Base source');
  const sharedProfile = pin.inputs.find(input => input.path === 'packages/views-react/src/browser/shared-ui-profile.css');
  const sharedProfileProjection = fs.readFileSync('public/local-first/shared-ui-profile.css');
  if (!sharedProfile || sharedProfile.bytes !== sharedProfileProjection.length || sharedProfile.sha256 !== digest(sharedProfileProjection))
    throw Error('Agentic Base must consume the exact Design System shared UI profile');
  const outputs = ['agentic-base-data-view.js', 'dropdown-menus.js', 'agentic-base-data-view.css'];
  if (!Array.isArray(pin.outputs) || pin.outputs.length !== outputs.length || outputs.some(name => !pin.outputs.some(row => row.path === name))) throw Error('Agentic Base data view inventory invalid');
  for (const output of pin.outputs) {
    if (output.sourcePath !== (output.path === 'dropdown-menus.js' ? 'dropdown-menus.js' : output.path.endsWith('.js') ? 'browser-data-view.js' : 'browser-data-view.css')) throw Error('Agentic Base output source invalid');
    const bytes = readLocalFirstAsset(output.path);
    if (bytes.length !== output.bytes || digest(bytes) !== output.sha256) throw Error('Agentic Base data view asset differs from its pinned source');
    const text = bytes.toString('utf8');
    if (output.path.endsWith('.css') ? /@import\b|url\(\s*['"]?(?:https?:|\/\/)/i.test(text)
      : /\bimport\s*(?:\(|['"]|[^;\n]*?\bfrom\s*['"])|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(text)
        || (output.path === 'dropdown-menus.js' ? !text.includes('enhanceSelects') || !text.includes('agentic-menu') : !text.includes('mountDataView') || !text.includes('mountRecordViewToolbar') || !text.includes('multiDimensional') || !text.includes('DATA_VIEW_BROWSER_LIMITS'))) throw Error('Agentic Base data view asset must remain self-contained and offline');
  }
  return pin;
}

export function verifyStorageManagementSourceIndex() {
  const filename = 'public/local-first/agentic-commerce-os/storage-management/sources.json'
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
  const expected = new Map([
    ['github.com/huijoohwee/agentic-os', 682],
    ['github.com/huijoohwee/agentic-canvas-os', 969],
    ['github.com/huijoohwee/agentic-commerce-os', 254],
    ['github.com/huijoohwee/agentic-graph', 1954],
    ['github.com/huijoohwee/agentic-base', 63],
    ['github.com/huijoohwee/agentic-design-system', 37],
  ])
  if (manifest.schema !== 'commerce.storage-management-source-index/v1'
    || manifest.route !== 'https://airvio.co/agentic-commerce-os/storage-management/'
    || manifest.sources.length !== expected.size) throw Error('Storage management source index invalid')
  const page = fs.readFileSync('public/local-first/agentic-commerce-os/storage-management/index.html', 'utf8')
  const routeRoot = 'public/local-first/agentic-commerce-os/storage-management/'
  const headers = fs.readFileSync(routeRoot + '_headers', 'utf8')
  const redirects = fs.readFileSync(routeRoot + '_redirects', 'utf8')
  const guide = fs.readFileSync(routeRoot + 'guide.js', 'utf8')
  const serviceWorker = fs.readFileSync(routeRoot + 'sw.js', 'utf8')
  if (!headers.startsWith('/*\n')
    || !headers.includes('Content-Security-Policy: default-src')
    || !headers.includes('X-Content-Type-Options: nosniff')
    || !headers.includes('Cache-Control: public, max-age=0, must-revalidate, no-transform')
    || redirects.trim() !== '/agentic-commerce-os/storage-management /agentic-commerce-os/storage-management/ 308'
    || !guide.includes("register('./sw.js', { scope: './' })")
    || !serviceWorker.includes("const FILES = ['', 'style.css', 'guide.js', 'sources.json', 'sw.js']")
    || serviceWorker.includes('http://') || serviceWorker.includes('https://'))
    throw Error('Storage management static route headers invalid')
  const seen = new Set()
  for (const source of manifest.sources) {
    if (!expected.has(source.repository) || expected.get(source.repository) !== source.pullRequest
      || seen.has(source.repository) || !/^[a-f0-9]{40}$/.test(source.revision)
      || !Array.isArray(source.files) || !source.files.length) throw Error('Storage management source pin invalid')
    seen.add(source.repository)
    for (const file of source.files) {
      if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('..')
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes >= 500000
        || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !page.includes(`https://${source.repository}/blob/${source.revision}/${file.path}`))
        throw Error('Storage management source file pin invalid')
    }
  }
  const totalBytes = STORAGE_MANAGEMENT_ASSETS.reduce((total, file) => total + fs.statSync(routeRoot + file).size, 0)
  if (totalBytes >= 80000) throw Error('Storage management route exceeds its 80 kB payload cap')
  return { sourceCount: seen.size, sourceFileCount: manifest.sources.reduce((total, source) => total + source.files.length, 0), totalBytes,
    servedFiles: STORAGE_MANAGEMENT_ASSETS.length }
}
export function prepareLocalFirstAssets() {
  const output = path.resolve(LOCAL_FIRST_ASSET_DIRECTORY)
  fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(output, { recursive: true })
  for (const file of [...FILES, ...PRIVATE_FILES]) {
    const target = path.resolve(output, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readLocalFirstAsset(file), { flag: 'wx' })
  }
  fs.copyFileSync(path.join(output, 'index.html'), path.join(output, LOCAL_FIRST_DEV_INDEX_ALIAS), fs.constants.COPYFILE_EXCL)
  if (listRegularFiles(output).join() !== [...FILES, ...PRIVATE_FILES, LOCAL_FIRST_DEV_INDEX_ALIAS].sort().join()) {
    throw Error('Local-first staged asset inventory invalid')
  }
  return output
}
function listRegularFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) return listRegularFiles(path.join(directory, entry.name), relative)
    if (!entry.isFile()) throw Error('Unexpected non-regular static asset')
    return [relative]
  }).sort()
}
export function verifyGraphDataView() {
  const manifestFile = 'config/graph-data-view.json', manifestStat = fs.lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size < 1 || manifestStat.size >= 500000) throw Error('Graph data view manifest invalid');
  const pin = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (pin.schema !== 'agentic-graph/data-view-artifact/v1' || pin.sourceDirty !== false || !/^[0-9a-f]{40}$/.test(pin.sourceRevision)) throw Error('Graph data view provenance invalid');
  if (pin.entry !== 'canvas/src/features/markdown/ui/dataViewBrowserAdapter.tsx' || pin.browserExport !== 'mountDataView' || pin.cssScope !== 'shadow-root' || pin.hostTokens !== 'graph-ui-tokens.css'
    || JSON.stringify(pin.browserExports) !== JSON.stringify(['mountDataView', 'mountSequenceGuide', 'mountSequenceGuideContent'])
    || !Array.isArray(pin.inputs) || !pin.inputs.length || pin.inputs.length > 160 || digest(JSON.stringify(pin.inputs)) !== pin.inputDigest) throw Error('Graph data view source contract invalid');
  const paths = new Set(); let totalInputBytes = 0, previousPath = '';
  for (const input of pin.inputs) {
    if (!input || typeof input.path !== 'string' || input.path.startsWith('/') || input.path.includes('..') || input.path.includes('\\') || input.path <= previousPath
      || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 2000000 || !/^[0-9a-f]{64}$/.test(input.sha256)
      || input.path.startsWith('canvas/src/') && /(?:\/hooks\/|useGraphStore|useSequenceDocument|\/(?:stores?|storage|three|mermaid|rich-media)\/)/.test(input.path)) throw Error('Graph data view input invalid');
    paths.add(input.path); previousPath = input.path; totalInputBytes += input.bytes;
  }
  const owners = [pin.entry, 'canvas/scripts/build-data-view-adapter.mjs', 'node_modules/@agentic-base/views-react/packages/views-react/src/table/TableCore.tsx', 'node_modules/@agentic-base/views-react/packages/views-react/src/browser/DataViewBrowserAdapter.tsx',
    'canvas/src/features/sequence/sequenceGuideBrowserAdapter.tsx', 'canvas/src/features/sequence/SequenceInspectorView.tsx',
    'canvas/src/features/sequence/SequenceFlow.css', 'node_modules/agentic-design-system/packages/react-panels/src/FloatingPanelShell.tsx',
    'node_modules/agentic-design-system/packages/react-panels/src/FloatingPanelCloseButton.tsx',
    'node_modules/agentic-design-system/packages/react-panels/src/FloatingPanelTabs.tsx',
    'node_modules/agentic-design-system/packages/react-panels/src/PanelControlButton.tsx',
    'node_modules/agentic-design-system/packages/react-panels/src/PanelControlGroup.tsx',
    'node_modules/agentic-design-system/site/floating-panel.css',
    'node_modules/agentic-design-system/site/toolbar.css',
    'node_modules/agentic-design-system/site/icons.json',
    'canvas/src/index.css', 'canvas/src/styles/responsive-toolbar.css', 'canvas/src/styles/shared-ui-profile.css',
    'grph-shared/src/ui/shared-ui-profile.json', 'node_modules/agentic-design-system/packages/react-panels/src/PanelSection.tsx',
    'node_modules/agentic-design-system/site/panels.css',
    'grph-shared/src/ui/graph-profile.json', 'grph-shared/src/ui/graph-profile.pin.json', 'grph-shared/src/ui/design-runtime-profile.json',
    'canvas/src/styles/shared-ui-profile.pin.json', 'canvas/src/styles/kgTokens.generated.css',
    'node_modules/@agentic-base/views-react/packages/views-react/src/controls/icons.json'];
  if (totalInputBytes > 8000000 || owners.some(owner => !paths.has(owner))) throw Error('Graph data view native owner missing or over budget');
  const panelIndex = fs.readFileSync('public/agentic-design-system/panels.css', 'utf8');
  // The Graph data-view adapter bundle excludes collection-layout.css (see agentic-graph
  // canvas/scripts/build-data-view-adapter.mjs); it is a Commerce-side layout asset sealed from the
  // same Design System release, so it is not part of the Graph adapter's panel stylesheet inventory.
  const panelImports = [...panelIndex.matchAll(/@import "\.\/([^";]+)";/gu)].map(match => match[1])
    .filter(file => file !== 'collection-layout.css');
  for (const file of ['panels.css', ...panelImports]) {
    const entry = pin.inputs.find(input => input.path === 'node_modules/agentic-design-system/site/' + file);
    if (entry?.sha256 !== digest(fs.readFileSync('public/agentic-design-system/' + file)))
      throw Error('Graph and Commerce must use the same panel stylesheet: ' + file);
  }
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
  const release = readDesignSystemStaticRelease();
  const catalogBytes = fs.readFileSync('public/agentic-design-system/catalog.json');
  if (digest(catalogBytes) !== release.files.get('catalog.json')?.sha256)
    throw Error('Commerce theme catalog differs from its pinned Design System release');
  const profile = JSON.parse(catalogBytes).registry.profiles.find(item => item.id === 'commerce');
  if (!profile || profile.owner !== release.owner || profile.source !== './tokens/commerce-profile.json'
    || profile.projection?.path !== './vendor/commerce-theme.css' || provenance?.[1] !== profile.revision
    || 'sha256:' + provenance?.[2] !== profile.digest || profile.digest !== 'sha256:' + release.files.get('tokens/commerce-profile.json')?.sha256
    || profile.projection.digest !== 'sha256:' + digest(themeBytes) || digest(themeBytes) !== release.files.get('vendor/commerce-theme.css')?.sha256)
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
    const source = readLocalFirstAsset(file).toString('utf8');
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
  for (const file of ['style.css', 'sme-business-pack.css', 'housing-comparison.css', 'workspace-shell.css']) {
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
  for (const symbol of ['icon-search']) {
    if (symbols.filter(id => id === symbol).length !== 1) throw Error(`Shared Commerce icon missing or duplicated: ${symbol}`);
  }
  const navigationTemplates = [...html.matchAll(/<template\s+id="(shop|vendor|admin|sme|housing)-navigation-content">([\s\S]*?)<\/template>/g)];
  if (navigationTemplates.length !== 5) throw Error('Each commerce role must use the shared navigation icon template contract');
  for (const [, role, source] of navigationTemplates) {
    const refs = [...source.matchAll(/<use\b[^>]*href=["']#(icon-[\w-]+)["']/g)].map(match => match[1]);
    if (!refs.length || refs.some(ref => !symbols.includes(ref)) || /<(?:path|circle|rect|line|polyline|polygon)\b/.test(source))
      throw Error(`Commerce ${role} navigation must reference shared icon symbols without duplicate path art`);
  }
  const navigation = fs.readFileSync(path.join(directory, 'workspace-navigation.js'), 'utf8');
  if (!navigation.includes("createIcon('icon-search')")
    || /<(?:path|circle|rect)\b/.test(navigation)
    || !navigation.includes('export function assertSharedWorkspaceShell()')
    || !navigation.includes("document.querySelectorAll('.topbar').length !== 1")
    || !navigation.includes("document.querySelectorAll('.console-sidebar').length !== 1")
    || !navigation.includes("document.querySelectorAll('.workspace-footer').length !== 1")) {
    throw Error('Shared shell components and icons must keep one fail-loud source');
  }
  return { owner: 'commerce-theme.css', tokenCount: tokenNames.length, iconCount: symbols.length };
}
export function verifySharedUiIconProfile(directory = 'public/local-first') {
  if (!FILES.includes('shared-ui-profile.css')) throw Error('Shared UI icon profile must be a released local-first asset');
  const designSystemFiles = readDesignSystemStaticRelease().files;
  for (const file of ['icons.json', 'toolbar-icons.js', 'toolbar.css', 'key-type-value.js', 'markdown.js', 'markdown-parser.js', 'color.js', 'rich-text.css', 'viewer-surface.js', 'viewer-surface.css', 'panel-section.js', 'panel-section.css', 'hover.js', 'hover-text.js', 'hover.css']) {
    const central = designSystemFiles.get(file);
    if (!central || !FILES.includes(file)
      || digest(fs.readFileSync(path.join(directory, file))) !== central.sha256)
      throw Error('Commerce must consume the exact pinned Design System icon and toolbar projection: ' + file);
  }
  const sharedUiPin = readSharedUiIconPin();
  const releaseProfile = readDesignSystemStaticRelease().profilePins.sharedUi;
  const centralCatalog = JSON.parse(fs.readFileSync('public/agentic-design-system/catalog.json', 'utf8'));
  const centralProfile = centralCatalog.registry?.profiles?.find(profile => profile.id === 'shared-ui');
  if (!centralProfile || releaseProfile.id !== 'shared-ui'
    || releaseProfile.owner !== sharedUiPin.owner
    || releaseProfile.sourceRevision !== sharedUiPin.sourceRevision
    || releaseProfile.registryRevision !== sharedUiPin.registryRevision
    || releaseProfile.sourceSha256 !== `sha256:${sharedUiPin.profileSha256}`
    || releaseProfile.projectionSha256 !== `sha256:${sharedUiPin.projectionSha256}`
    || centralProfile.revision !== sharedUiPin.sourceRevision
    || centralProfile.digest !== `sha256:${sharedUiPin.profileSha256}`
    || centralProfile.projection?.digest !== `sha256:${sharedUiPin.projectionSha256}`)
    throw Error('Commerce shared UI profile pin differs from the exact Design System registry source');
  const cssBytes = fs.readFileSync(path.join(directory, 'shared-ui-profile.css'));
  const css = cssBytes.toString('utf8');
  const provenance = css.match(/^\/\* Generated from agentic-design-system@([a-f0-9]{40}); profile sha256 ([a-f0-9]{64})\. Do not edit\. \*\//u);
  if (!provenance || provenance[1] !== sharedUiPin.sourceRevision
    || provenance[2] !== sharedUiPin.profileSha256 || digest(cssBytes) !== sharedUiPin.projectionSha256
    || /@import\b|url\(\s*["']?(?:https?:|\/\/)/i.test(css))
    throw Error('Shared UI icon projection differs from its pinned Design System profile or uses a network dependency');
  for (const name of ['floating-panel', 'toolbar', 'dashboard-columns']) {
    const file = name + (name === 'dashboard-columns' ? '.js' : '.css');
    const artifactPin = JSON.parse(fs.readFileSync(new URL('../../config/' + name + '.pin.json', import.meta.url), 'utf8'));
    const bytes = fs.readFileSync(path.join(directory, file));
    if (name === 'toolbar' && (!FILES.includes('toolbar-icons.js')
      || digest(fs.readFileSync(path.join(directory, 'toolbar-icons.js'))) !== artifactPin.iconsSha256))
      throw Error('Commerce differs from the pinned Design System icon helpers');
    if (artifactPin.owner !== sharedUiPin.owner || !/^[a-f0-9]{40}$/.test(artifactPin.revision)
      || artifactPin.path !== 'site/' + file || !FILES.includes(file) || digest(bytes) !== artifactPin.sha256)
      throw Error('Commerce differs from the pinned Design System shell: ' + file);
    if (name !== 'dashboard-columns' && artifactPin.revision !== readDesignSystemStaticRelease().revision)
      throw Error('Commerce panel and toolbar must use one pinned Design System revision');
  }
  const renderer = JSON.parse(fs.readFileSync('config/dashboard-renderer.pin.json', 'utf8'));
  if (renderer.owner !== sharedUiPin.owner || renderer.revision !== readDesignSystemStaticRelease().revision
    || renderer.path !== 'site/dashboard.mjs' || digest(fs.readFileSync(path.join(directory, 'dashboard.js'))) !== renderer.sha256)
    throw Error('Commerce dashboard renderer differs from its Design System pin');
  const panelShell = fs.readFileSync(path.join(directory, 'commerce-shell.css'), 'utf8');
  const imports = css => [...css.matchAll(/@import "\.\/(?:vendor\/)?([^"/]+)";/gu)].map(match => match[1]);
  const owner = fs.readFileSync('public/agentic-design-system/panels.css', 'utf8');
  const assets = imports(owner);
  if (!assets.length || JSON.stringify(imports(panelShell)) !== JSON.stringify(assets))
    throw Error('Commerce must import the ordered Design System panel styles exactly once');
  for (const file of [...assets, 'floating-panel.js']) {
    const source = file === 'shared-ui-profile.css' ? 'vendor/' + file : file;
    if (!fs.readFileSync(path.join(directory, file)).equals(fs.readFileSync('public/agentic-design-system/' + source)))
      throw Error('Commerce must use the exact Design System panel asset: ' + file);
  }
  if (/\.agentic-(?:base-floating-panel|floating-panel|panel-(?:main|bottom|section|tab|control|body|scroll))/.test(panelShell))
    throw Error('Commerce must not override Design System panel layout or appearance');
  const shell = fs.readFileSync(path.join(directory, 'workspace-shell.css'), 'utf8');
  const rule = shell.match(/\.workspace-shell>\.sidebar \.console-search>svg\s*\{([^}]*)\}/u)?.[1] ?? '';
  if (JSON.stringify(imports(shell)) !== JSON.stringify(['commerce-shell.css'])
    || !rule.includes('width: var(--agentic-icon-size-default)')
    || !rule.includes('height: var(--agentic-icon-size-default)')
    || !rule.includes('flex: 0 0 var(--agentic-icon-size-default)')
    || /(?:width|height|flex):[^;]*(?:16px|1rem)/.test(rule))
    throw Error('Commerce console search icon must use the owned default icon-size token');
  const serviceWorker = fs.readFileSync(path.join(directory, 'sw.js'), 'utf8');
  if (!/\bshared-ui-profile\.css\b/u.test(serviceWorker))
    throw Error('Shared UI icon projection must be cached for offline use');
  return sharedUiPin;
}
export function sourceManifest(revision, selection = readCheckoutRelease()) {
  if (!/^[0-9a-f]{40}$/.test(revision) || git('rev-parse', 'HEAD') !== revision) throw Error('Candidate source mismatch');
  verifyGeoProjection();
  verifyGraphBundle();
  verifyAgenticBaseDataView();
  verifyGraphDataView();
  verifyTimelineBundle();
  verifySharedThemeOwner();
  verifySharedUiIconProfile();
  const layout = JSON.parse(fs.readFileSync('config/collection-layout.pin.json', 'utf8'));
  if (layout.owner !== 'github.com/huijoohwee/agentic-design-system' || !/^[a-f0-9]{40}$/u.test(layout.revision)
    || layout.path !== 'site/collection-layout.css'
    || layout.sha256 !== digest(fs.readFileSync('public/local-first/collection-layout.css'))) {
    throw Error('Shared collection layout differs from its pinned Design System asset');
  }
  verifyStorageManagementSourceIndex();
  assertLocalFirstConfig(JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
  if (listRegularFiles('public/local-first').join() !== [...FILES.map(sourceName), ...PRIVATE_FILES, ...STORAGE_MANAGEMENT_SOURCE_FILES].sort().join()) throw Error('Unexpected static asset inventory');
  const paths = [CONFIG, 'src/local-first/worker.ts', 'src/local-first/pack-assets.ts', 'src/local-first/workspace-pack.ts', 'src/local-first/workspace-service.ts', 'src/local-first/sme-business-pack.ts', 'public/local-first/sme-business-pack-core.js', 'config/capability-token-map.json', 'config/shared-ui-profile.pin.json', 'config/floating-panel.pin.json', 'config/toolbar.pin.json',
    'config/dashboard-columns.pin.json', 'config/dashboard-renderer.pin.json', 'config/collection-layout.pin.json', 'config/agentic-base-data-view.json', 'config/graph-data-view.json', 'config/workspace-pack-graph.json', 'src/generated/graph-workspace-pack.js', 'src/generated/graph-workspace-pack.d.ts',
    'scripts/workspace-pack/build-graph.mjs', 'src/edge/production-prefix.ts', 'src/shared/http.ts',
    ...['checkout', 'session', 'fulfillment-contract', 'fulfillment-definition', 'fulfillment', 'fulfillment-relay', 'stripe-checkout', 'checkout-offer', 'checkout-recovery', 'stripe-webhook'].map(file => `src/local-first/${file}.ts`),
    'src/sandbox/device-host.ts', 'package.json', 'package-lock.json',
    ...[...FILES, ...PRIVATE_FILES].map(file => 'public/local-first/' + sourceName(file))];
  if (readFulfillmentRelease()) paths.push(FULFILLMENT_CONFIG);
  const entries = paths.sort().map(file => {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Non-regular artifact source');
    const bytes = fs.readFileSync(file); if (bytes.length >= 500000) throw Error('Artifact file exceeds 500 kB');
    return { path: file, bytes: bytes.length, digest: digest(bytes) };
  });
  prepareLocalFirstAssets();
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
