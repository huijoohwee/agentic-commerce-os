import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const esbuild: typeof import('esbuild') = wranglerRequire('esbuild')

export async function buildLocalHost(directory: string): Promise<string> {
  const outfile = path.join(directory, 'commerce-local-host.mjs')
  await esbuild.build({ absWorkingDir: root, entryPoints: ['scripts/local-host/main.ts'], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, legalComments: 'none',
  })
  const bytes = fs.readFileSync(outfile)
  if (bytes.byteLength >= 500_000) throw new Error('local_host_bundle_limit_exceeded')
  return outfile
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = await buildLocalHost(path.join(root, 'node_modules/.cache/commerce-local-host'))
  const bytes = fs.readFileSync(file)
  process.stdout.write(`${JSON.stringify({ file, bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') })}\n`)
}
