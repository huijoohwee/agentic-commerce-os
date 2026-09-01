import { spawnSync } from 'node:child_process'
import { readJson } from './common.ts'

const manifest = readJson<Readonly<{ devDependencies?: Readonly<Record<string, string>> }>>('package.json')
if (manifest.devDependencies?.['@playwright/test'] !== '1.62.1') {
  process.stdout.write(`${JSON.stringify({ ok: false, check: 'browser', code: 'playwright_not_exact_pinned' })}\n`)
  process.exitCode = 1
} else {
  const result = spawnSync(process.execPath, ['./node_modules/@playwright/test/cli.js', 'test'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4_000_000,
    timeout: 180_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  const ok = result.status === 0
  process.stdout.write(`${JSON.stringify({ ok, check: 'browser', exitCode: result.status })}\n`)
  if (!ok) process.exitCode = result.status ?? 1
}
