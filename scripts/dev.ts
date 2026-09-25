import { spawn } from 'node:child_process'
import { podmanRuntimeEnvironment } from './container-runtime.ts'
import { build } from 'esbuild'

const args = process.argv.slice(2), pack = args[0] === '--workspace-pack'
if (pack) {
  if (args.length !== 1) throw Error('workspace_pack_dev_arguments_invalid')
  await build({ entryPoints: ['src/local-host/workspace-pack-host.ts'], bundle: true, platform: 'node',
    format: 'esm', target: 'node22', packages: 'external', outfile: 'node_modules/.cache/workspace-pack/host.mjs' })
}
const child = pack ? spawn(process.execPath, ['node_modules/.cache/workspace-pack/host.mjs'], {
  env: { ...process.env, COMMERCE_WORKSPACE_PACK_DEV: '1' }, stdio: 'inherit',
}) : spawn(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'dev',
  '-c', 'wrangler.edge.jsonc', '-c', 'wrangler.core.jsonc', '-c', 'wrangler.dev-provider.jsonc',
  '-c', 'wrangler.sandbox.jsonc', '--env', 'dev', ...args],
{ env: podmanRuntimeEnvironment(), stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child.kill(signal) })
child.once('error', () => { process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1) })
