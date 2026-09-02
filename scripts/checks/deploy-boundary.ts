import { authorizeAndAdvance } from '../release-controller.ts'
import { fileContains, readJson, report, source, type Assertion } from './common.ts'

type PackageManifest = Readonly<{ scripts: Readonly<Record<string, string>> }>
type BoundaryRegister = Readonly<{
  productionMirror: Readonly<{ generatedOutput: boolean; authoredEditTargets: readonly string[] }>
  boundaries: readonly Readonly<{ state: string }>[]
}>

const manifest = readJson<PackageManifest>('package.json')
const runtimeEntries = Object.entries(manifest.scripts)
  .filter(([, command]) => /^wrangler dev\b/u.test(command))
  .map(([name]) => name)
  .sort()
const boundaries = readJson<BoundaryRegister>('docs/deploy-boundary-register.json')
const controller = source('scripts/release-controller.ts')
const refusal = await authorizeAndAdvance(null, 1_000)
const assertions: Assertion[] = [
  { condition: JSON.stringify(runtimeEntries) === JSON.stringify(['dev', 'dev:apex']), detail: 'exactly two Wrangler Dev entries' },
  { condition: manifest.scripts['dev:offline'] === 'vitest --config vitest.worker.config.ts', detail: 'offline harness retained outside runtime entries' },
  { condition: Object.entries(manifest.scripts).filter(([name]) => name.startsWith('deploy:production:')).every(([, command]) => command.startsWith('node scripts/release-controller.ts guard') && !/\bwrangler\s+deploy\b/u.test(command)), detail: 'all Production entrypoints are controller-only and contain no deploy command' },
  { condition: Object.values(manifest.scripts).every((command) => !/\bwrangler\s+deploy\b/u.test(command)), detail: 'repository package scripts expose no raw Wrangler deploy command' },
  { condition: manifest.scripts['deploy:dev:dry'] === 'node scripts/dry-deploy-controller.ts', detail: 'Dev dry bundles use the fixed-argument credentialless controller' },
  { condition: boundaries.productionMirror.generatedOutput && boundaries.productionMirror.authoredEditTargets.length === 0, detail: 'Production mirror is generated only' },
  { condition: boundaries.boundaries.every(({ state }) => state === 'closed' || state === 'pending-protected-integration'), detail: 'all delivery boundaries remain closed' },
  { condition: refusal.ok === false && refusal.code === 'release_authorization_incomplete', detail: 'missing authorization refuses' },
  { condition: !/node:child_process|wrangler\s+deploy|git\s+push/u.test(controller), detail: 'controller adapter has zero deployment or canonical-write mechanism' },
  fileContains('wrangler.edge.jsonc', /"routes"\s*:\s*\[\s*\{\s*"pattern"\s*:\s*"airvio\.co\/agentic-commerce-os"/u),
  fileContains('docs/demo.md', 'liveReleaseReadiness: not-ready'),
]

report('deploy-boundary', assertions)
