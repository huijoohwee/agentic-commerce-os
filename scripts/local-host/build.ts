import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { generateFile, generationManifest } from 'agentic-os/generation'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const esbuild: typeof import('esbuild') = wranglerRequire('esbuild')

export async function buildLocalHost(directory: string, profile: 'sandbox' | 'listing' = 'sandbox'): Promise<string> {
  if (!['sandbox', 'listing'].includes(profile)) throw new Error('local_host_profile_invalid')
  const entry = profile === 'listing' ? 'scripts/durable-fulfillment/main.mjs' : 'scripts/local-host/main.ts'
  fs.mkdirSync(directory, { recursive: true })
  directory = fs.realpathSync(directory)
  const outfile = path.join(directory, profile === 'listing' ? 'commerce-listing-host.mjs' : 'commerce-local-host.mjs')
  await generateFile({ destination: outfile, receipt: path.join(directory, 'build-receipt.json'),
    maxOutputBytes: 499999, timeoutMs: 30000,
    inputs: () => ({ source: generationManifest(root, {
      paths: ['scripts/local-host', ...(profile === 'listing' ? ['scripts/durable-fulfillment'] : []),
        'scripts/sandbox-podman-executor.ts', 'scripts/isolated-process.ts',
        'src', 'package.json', 'package-lock.json', 'tsconfig.json'],
      maxEntries: 2000, maxBytes: 16 * 1024 * 1024,
    }).digest, esbuild: esbuild.version, profile }),
    produce: async ({ signal }) => {
      const context = await esbuild.context({ absWorkingDir: root,
        entryPoints: [entry], outfile, write: false,
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
