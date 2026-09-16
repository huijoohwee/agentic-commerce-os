import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { generateFile, generationManifest } from 'agentic-os/generation'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const esbuild: typeof import('esbuild') = wranglerRequire('esbuild')

function listingPlan() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, timeout: 20000 });
  const revision = git('rev-parse', 'HEAD').toString().trim(), file = 'docs/durable-fulfillment.md';
  if (!/^[a-f0-9]{40}$/.test(revision) || git('status', '--porcelain', '--untracked-files=all').length)
    throw new Error('listing_source_must_be_exact_and_clean');
  const bytes = fs.readFileSync(path.join(root, file));
  const committed = git('show', revision + ':' + file);
  if (bytes.length !== committed.length || bytes.some((byte, index) => byte !== committed[index]))
    throw new Error('listing_plan_changed');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.[1];
  if (!frontmatter) throw new Error('listing_plan_missing');
  const read = (key: string) => {
    const lines = frontmatter.split('\n').filter(line => line.startsWith(key + ':'));
    const value = lines.length === 1 ? new RegExp('^' + key + ': "([^"\\n]+)"$').exec(lines[0]!)?.[1] : null;
    if (!value) throw new Error('listing_plan_metadata_invalid');
    return value;
  };
  const continuityId = read('continuity_id'), version = read('version');
  const revisions = Object.fromEntries(['prd', 'tad', 'adr', 'mvp', 'gtm'].map(role => [role, read(role + '_revision')]));
  if (continuityId !== 'DURABLE-LISTING-FULFILLMENT-001' || version !== '0.2.0'
    || Object.values(revisions).some(value => value !== version)) throw new Error('listing_plan_join_invalid');
  return { repository: 'github.com/huijoohwee/agentic-commerce-os', path: file, revision,
    digest: createHash('sha256').update(bytes).digest('hex'), continuityId, revisions };
}

export async function buildLocalHost(directory: string, profile: 'sandbox' | 'listing' = 'sandbox'): Promise<string> {
  if (!['sandbox', 'listing'].includes(profile)) throw new Error('local_host_profile_invalid')
  const plan = profile === 'listing' ? listingPlan() : null;
  const entry = profile === 'listing' ? 'scripts/durable-fulfillment/main.mjs' : 'scripts/local-host/main.ts'
  fs.mkdirSync(directory, { recursive: true })
  directory = fs.realpathSync(directory)
  const outfile = path.join(directory, profile === 'listing' ? 'commerce-listing-host.mjs' : 'commerce-local-host.mjs')
  await generateFile({ destination: outfile, receipt: path.join(directory, 'build-receipt.json'),
    maxOutputBytes: 499999, timeoutMs: 30000,
    inputs: () => {
      if (plan && JSON.stringify(listingPlan()) !== JSON.stringify(plan)) throw new Error('listing_source_changed');
      return { source: generationManifest(root, {
      paths: ['scripts/local-host', ...(profile === 'listing' ? ['scripts/durable-fulfillment', 'docs/durable-fulfillment.md'] : []),
        'scripts/sandbox-podman-executor.ts', 'scripts/isolated-process.ts',
        'src', 'package.json', 'package-lock.json', 'tsconfig.json'],
      maxEntries: 2000, maxBytes: 16 * 1024 * 1024,
    }).digest, esbuild: esbuild.version, profile, plan };
    },
    produce: async ({ signal }) => {
      const context = await esbuild.context({ absWorkingDir: root,
        entryPoints: [entry], outfile, write: false,
        ...(plan ? { define: { __COMMERCE_LISTING_PLAN__: JSON.stringify(plan) } } : {}),
        bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, legalComments: 'none',
      })
      const cancel = () => { void context.cancel() }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) throw new Error('local_host_build_cancelled')
        const result = await context.rebuild()
        if (result.outputFiles?.length !== 1) throw new Error('local_host_bundle_output_invalid')
        return result.outputFiles[0]!.contents
      } finally { signal.removeEventListener('abort', cancel); await context.dispose() }
    },
  })
  return outfile
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg, index) => arg !== '--listing' || index !== 0)) throw new Error('local_host_build_argument_invalid')
  const profile = process.argv[2] === '--listing' ? 'listing' : 'sandbox'
  const file = await buildLocalHost(path.join(root, 'node_modules/.cache/' + (profile === 'listing' ? 'commerce-listing-host' : 'commerce-local-host')), profile)
  const bytes = fs.readFileSync(file)
  process.stdout.write(`${JSON.stringify({ file, bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') })}\n`)
}
