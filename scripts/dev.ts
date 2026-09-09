import { spawn } from 'node:child_process'
import { podmanEnvironment } from './container-runtime.ts'

const child = spawn(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'dev',
  '-c', 'wrangler.edge.jsonc', '-c', 'wrangler.core.jsonc', '-c', 'wrangler.dev-provider.jsonc',
  '-c', 'wrangler.sandbox.jsonc', '--env', 'dev', ...process.argv.slice(2)],
{ env: podmanEnvironment(), stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child.kill(signal) })
child.once('error', () => { process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1) })
