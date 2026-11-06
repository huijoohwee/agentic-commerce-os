import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const manifestPath = path.join(root, 'config/graph-gantt-timeline.json')
const portablePath = value => value.split(path.sep).join('/')
const hash = value => createHash('sha256').update(value).digest('hex')
const adapter = 'scripts/sme-review/graph-gantt-adapter.tsx'
const projection = 'public/local-first/sme-review-workflow.js'
export function verifyTimelineBundle() {
  const pin = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (pin.schema !== 'agentic-commerce/graph-gantt-artifact/v1' || pin.owner !== 'github.com/huijoohwee/agentic-graph'
    || !/^[a-f0-9]{40}$/.test(pin.sourceRevision) || pin.sourceDirty !== false || pin.browserExport !== 'mountGanttTimeline'
    || hash(JSON.stringify(pin.inputs)) !== pin.inputDigest || !pin.inputs.some(input => input.path.endsWith('/VideoSequenceTimelineRuler.tsx'))
    || pin.inputs.length > 100 || pin.inputs.some(input => /useGraphStore|workspace-seeds|maplibre|elkjs/.test(input.path))) throw Error('gantt_source_contract_invalid')
  if (pin.consumerInputs.map(input => input.path).join() !== [adapter, 'scripts/sme-review/graph-gantt-host.css', projection, 'scripts/sme-review/build-timeline.mjs'].join()) throw Error('gantt_consumer_inventory_invalid')
  for (const input of pin.consumerInputs) if (hash(fs.readFileSync(path.join(root, input.path))) !== input.sha256) throw Error('gantt_adapter_changed_rebuild_required')
  if (pin.outputs.map(output => output.path).join() !== 'graph-gantt-timeline.js,graph-gantt-timeline.css') throw Error('gantt_output_inventory_invalid')
  for (const output of pin.outputs) {
    const bytes = fs.readFileSync(path.join(root, 'public/local-first', output.path))
    if (bytes.length !== output.bytes || bytes.length >= 500000 || hash(bytes) !== output.sha256) throw Error('gantt_output_mismatch')
    if (output.path.endsWith('.css') && /@import\b|url\(\s*['"]?(?:https?:|\/\/)/i.test(bytes.toString())) throw Error('gantt_external_css_forbidden')
  }
  return pin
}
export async function buildTimelineBundle(graphRoot) {
  const git = args => execFileSync('git', ['-C', graphRoot, ...args], { encoding: 'utf8' }).trim()
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw Error('gantt_graph_source_dirty')
  const sourceRevision = git(['rev-parse', 'HEAD'])
  const require = createRequire(path.join(graphRoot, 'package.json')), esbuild = require('esbuild')
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: [adapter], outdir: path.join(root, 'public/local-first'),
    entryNames: 'graph-gantt-timeline', bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.join(graphRoot, 'canvas/src'), '@graph': path.join(graphRoot, 'canvas/src'),
      'react': path.join(graphRoot, 'node_modules/react'), 'react-dom': path.join(graphRoot, 'node_modules/react-dom'), 'grph-shared': path.join(graphRoot, 'grph-shared/src') }, logLevel: 'silent' })
  const dependencyRoot = fs.realpathSync(path.join(graphRoot, 'node_modules'))
  const sourceInputs = Object.keys(result.metafile.inputs).map(file => path.resolve(root, file))
    .flatMap(file => file.startsWith(graphRoot + path.sep) ? [{ path: portablePath(path.relative(graphRoot, file)), file }]
      : file.startsWith(dependencyRoot + path.sep) ? [{ path: 'node_modules/' + portablePath(path.relative(dependencyRoot, file)), file }] : [])
  for (const file of ['package.json', 'package-lock.json']) sourceInputs.push({ path: file, file: path.join(graphRoot, file) })
  const inputs = sourceInputs.map(input => { const bytes = fs.readFileSync(input.file); return { path: input.path, bytes: bytes.length, sha256: hash(bytes) } })
    .sort((a, b) => a.path.localeCompare(b.path))
  const outputs = result.outputFiles.map(file => ({ path: path.basename(file.path), bytes: file.contents.length, sha256: hash(file.contents) }))
  if (outputs.some(output => output.bytes >= 500000) || inputs.length > 100 || inputs.some(input => /useGraphStore|workspace-seeds|maplibre|elkjs/.test(input.path))) throw Error('gantt_bundle_budget_exceeded')
  for (const file of result.outputFiles) fs.writeFileSync(file.path, file.contents)
  const consumerInputs = [adapter, 'scripts/sme-review/graph-gantt-host.css', projection, 'scripts/sme-review/build-timeline.mjs'].map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))) }))
  fs.writeFileSync(manifestPath, JSON.stringify({ schema: 'agentic-commerce/graph-gantt-artifact/v1', owner: 'github.com/huijoohwee/agentic-graph',
    sourceRevision, sourceDirty: false, browserExport: 'mountGanttTimeline', cssScope: 'shadow-root', hostTokens: 'graph-ui-tokens.css',
    inputs, inputDigest: hash(JSON.stringify(inputs)), consumerInputs, outputs }, null, 2) + '\n')
  verifyTimelineBundle(); return { sourceRevision, outputs, modules: inputs.length }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('usage: node scripts/sme-review/build-timeline.mjs <clean-agentic-graph-root>')
  console.log(JSON.stringify(await buildTimelineBundle(path.resolve(process.argv[2]))))
}
