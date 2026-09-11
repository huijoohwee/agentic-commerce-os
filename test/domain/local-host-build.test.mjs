import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLocalHost } from '../../scripts/local-host/build.ts'

test('local host build reuses verified output and repairs corruption without accumulating artifacts', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-build-cache-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = await buildLocalHost(directory)
  const original = fs.readFileSync(output), time = fs.statSync(output).mtimeMs
  assert(original.byteLength < 500000)
  await buildLocalHost(directory)
  assert.equal(fs.statSync(output).mtimeMs, time)
  assert.deepEqual(fs.readFileSync(output), original)
  fs.writeFileSync(output, 'corrupted')
  await buildLocalHost(directory)
  assert.deepEqual(fs.readFileSync(output), original)
  assert.deepEqual(fs.readdirSync(directory).sort(), ['build-receipt.json', 'commerce-local-host.mjs'])
})
