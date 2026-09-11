import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { buildLocalHost } from '../../scripts/local-host/build.ts'

const podman = process.env.AG_PODMAN_EXECUTABLE
const imageId = process.env.AG_PODMAN_IMAGE_ID
if (!podman || !imageId) throw new Error('local_host_operator_inputs_required')

test('real device host preserves authenticated isolation and cancels disconnected jobs', { timeout: 90_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-local-host-test-'))
  const token = Buffer.from(randomBytes(32)).toString('hex')
  const tokenFile = path.join(directory, 'host-token')
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' })
  const bundle = await buildLocalHost(directory)
  const child = spawn(process.execPath, [bundle, '--token-file', tokenFile, '--podman', podman,
    '--image-id', imageId, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let output = '', diagnostics = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text })
  child.stderr.setEncoding('utf8').on('data', (text: string) => { diagnostics += text })
  try {
    for (let count = 0; !output.includes('\n') && child.exitCode === null && count < 100; count += 1) await delay(100)
    assert.equal(child.exitCode, null, diagnostics)
    assert(output.includes('\n'), 'host startup did not complete')
    const ready = JSON.parse(output.trim()) as { origin: string; availability: string }
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
    assert.equal(ready.availability, 'device-session')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const request = (source: string, seconds = 30) => JSON.stringify({
      instanceId: 'untrusted-client-instance', purpose: 'registration-dry-run',
      limits: { wallClockSeconds: seconds, memoryMegabytes: 256 },
      declaredAllowlist: ['commerce.catalog.search'],
      payload: { registration: { tools: [{ name: 'commerce.catalog.search', loading: 'direct' }] },
        toolCalls: [{ toolId: 'commerce.catalog.search', input: {} }],
        executableTarget: { contract: 'agentic-graph-sandbox-executable/v1', kind: 'javascript-module',
          source, sourceDigest: createHash('sha256').update(source).digest('hex') },
      },
    })
    await t.test('authenticates readiness and executes with no host-file access', async () => {
      assert.equal((await fetch(`${ready.origin}/readyz`)).status, 401)
      const probe = await fetch(`${ready.origin}/readyz`, { headers })
      assert.equal(probe.status, 200)
      assert.equal((await probe.json() as { imageId: string }).imageId, imageId.replace(/^sha256:/u, ''))
      const source = `import fs from 'node:fs'
import { Buffer } from 'node:buffer'; export async function executeTool() {
        let denied = false; try { fs.readFileSync(${JSON.stringify(tokenFile)}) } catch { denied = true }
        if (!denied) throw Error('host_file_accessible'); return { ok: true };
      }`
      const response = await fetch(`${ready.origin}/v1/run`, { method: 'POST', headers, body: request(source) })
      const result = await response.json() as { ok: boolean; record: { instanceId: string } }
      assert.equal(response.status, 200, JSON.stringify(result))
      assert.equal(result.ok, true)
      assert.match(result.record.instanceId, /^run-[a-f0-9]{32}$/u)
      assert.notEqual(result.record.instanceId, 'untrusted-client-instance')
    })
    await t.test('disconnect terminates the active job and restores readiness', async () => {
      const abort = new AbortController()
      const running = fetch(`${ready.origin}/v1/run`, { method: 'POST', headers, signal: abort.signal,
        body: request('export async function executeTool() { while(true) {} }'),
      }).then(() => 'completed', () => 'aborted')
      let busy = false
      for (let count = 0; count < 20 && !busy; count += 1) {
        await delay(50)
        const probe = await fetch(`${ready.origin}/readyz`, { headers })
        busy = probe.status === 503 && (await probe.json() as { code?: string }).code === 'local_host_busy'
      }
      assert(busy, 'execution did not reserve the host')
      abort.abort()
      assert.equal(await running, 'aborted')
      let recovered = false
      let lastProbe: unknown
      // Socket close aborts the executor immediately; allow Podman kill/rm to settle.
      for (let count = 0; count < 50 && !recovered; count += 1) {
        await delay(100)
        const probe = await fetch(`${ready.origin}/readyz`, { headers })
        recovered = probe.status === 200
        lastProbe = await probe.json()
      }
      assert(recovered, `cancelled job did not release its container and host slot: ${JSON.stringify(lastProbe)}`)
    })
    await t.test('shutdown closes the listener', async () => {
      child.kill('SIGTERM')
      await exited
      assert.equal(child.exitCode, 0, diagnostics)
      await assert.rejects(fetch(`${ready.origin}/livez`, { headers }))
    })
    assert(!output.includes(token) && !diagnostics.includes(token), 'credential leaked to logs')
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
    fs.rmSync(directory, { recursive: true })
  }
})
