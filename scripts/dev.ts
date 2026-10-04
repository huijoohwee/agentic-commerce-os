import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { podmanRuntimeEnvironment } from './container-runtime.ts'
import { build } from 'esbuild'

const args = process.argv.slice(2), pack = args[0] === '--workspace-pack', local = args[0] === '--local-first'
if (local && args.length !== 1) throw Error('local_first_dev_arguments_invalid')
if (pack) {
  if (args.length !== 1) throw Error('workspace_pack_dev_arguments_invalid')
  await build({ entryPoints: ['src/local-host/workspace-pack-host.ts'], bundle: true, platform: 'node',
    format: 'esm', target: 'node22', packages: 'external', outfile: 'node_modules/.cache/workspace-pack/host.mjs' })
}
// A fresh loopback origin prevents a previous offline cache from masking edited assets.
const localPort = local ? await new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); reject(Error('local_dev_port_unavailable')); return }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
}) : null
if (local) console.log('Local-first Dev: isolated loopback origin; use JSON export to retain drafts between sessions.')
const child = pack ? spawn(process.execPath, ['node_modules/.cache/workspace-pack/host.mjs'], {
  env: { ...process.env, COMMERCE_WORKSPACE_PACK_DEV: '1' }, stdio: 'inherit',
}) : local ? spawn(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'dev',
  '-c', 'wrangler.local-first.jsonc', '--local', '--ip', '127.0.0.1', '--port', String(localPort), '--inspector-port', '0'],
{ env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' })
: spawn(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'dev',
  '-c', 'wrangler.edge.jsonc', '-c', 'wrangler.core.jsonc', '-c', 'wrangler.dev-provider.jsonc',
  '-c', 'wrangler.sandbox.jsonc', '--env', 'dev', ...args],
{ env: podmanRuntimeEnvironment(), stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child.kill(signal) })
child.once('error', () => { process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1) })
