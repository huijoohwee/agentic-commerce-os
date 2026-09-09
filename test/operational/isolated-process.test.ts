import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runIsolatedProcess } from '../../scripts/isolated-process.ts'

const podmanExecutable = process.env.AG_PODMAN_EXECUTABLE
const imageId = process.env.AG_PODMAN_IMAGE_ID
if (!podmanExecutable || !imageId) throw new Error('isolated_process_operator_inputs_required')
const config = { podmanExecutable, imageId, entrypoint: 'probe.mjs' }

test('real untrusted code cannot access host files, credentials, privileges or network', async () => {
  process.env.AG_ISOLATION_SENTINEL = 'public-test-marker'
  try {
    const result = await runIsolatedProcess({ ...config, timeoutMs: 5000, files: { 'probe.mjs': `
      import fs from 'node:fs'; import net from 'node:net';
      if (process.env.AG_ISOLATION_SENTINEL) throw Error('environment_inherited');
      if (process.getuid() !== 65534) throw Error('privileged_uid');
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      if (!/NoNewPrivs:\\s+1/.test(status) || !/CapEff:\\s+0+\\n/.test(status)) throw Error('privileges_available');
      for (const [file, expected] of [['memory.max','268435456'],['memory.swap.max','0'],['pids.max','64']]) {
        if (fs.readFileSync('/sys/fs/cgroup/' + file, 'utf8').trim() !== expected) throw Error('limit_unenforced');
      }
      for (const file of ['/root', '/Users', '/run/podman/podman.sock']) {
        let denied = false; try { fs.readdirSync(file) } catch { denied = true }
        if (!denied) throw Error('host_path_available');
      }
      let denied = false; try { fs.writeFileSync('/usr/local/escape', 'x') } catch { denied = true }
      if (!denied) throw Error('root_writable');
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '1.1.1.1', port: 443 });
        socket.once('connect', () => { socket.destroy(); reject(Error('network_available')) });
        socket.once('error', () => { socket.destroy(); resolve() });
        socket.setTimeout(1000, () => { socket.destroy(); reject(Error('network_probe_inconclusive')) });
      });
      console.log('isolation-confirmed');
    ` } })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'isolation-confirmed')
    assert.equal(result.containerRemoved, true)
  } finally { delete process.env.AG_ISOLATION_SENTINEL }
})

test('real runaway code is stopped and its exact container removed', async () => {
  const result = await runIsolatedProcess({ ...config, timeoutMs: 1000,
    files: { 'probe.mjs': 'while (true) {}' } })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.exitCode, 0)
  assert.equal(result.containerRemoved, true)
})

test('real output flooding is bounded, terminated and never reported as success', async () => {
  const result = await runIsolatedProcess({ ...config, timeoutMs: 5000, maxOutputBytes: 4096,
    files: { 'probe.mjs': 'while (true) process.stdout.write("x".repeat(65536))' } })
  assert.equal(result.outputTruncated, true)
  assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4096)
  assert.notEqual(result.exitCode, 0)
  assert.equal(result.containerRemoved, true)
})

test('real memory exhaustion is kernel-enforced and retained as an OOM failure', async () => {
  const result = await runIsolatedProcess({ ...config, timeoutMs: 15000,
    files: { 'probe.mjs': 'const blocks = []; while (true) blocks.push(Buffer.alloc(16 * 1024 * 1024, 1))' } })
  assert.equal(result.oomKilled, true, JSON.stringify(result))
  assert.notEqual(result.exitCode, 0)
  assert.equal(result.containerRemoved, true)
})

test('real Unicode output cut inside a code point remains within the byte budget', async () => {
  const result = await runIsolatedProcess({ ...config, timeoutMs: 5000, maxOutputBytes: 4095,
    files: { 'probe.mjs': 'process.stdout.write("😀".repeat(4096))' } })
  assert.equal(result.outputTruncated, true)
  assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4095)
  assert(!result.stdout.includes('\uFFFD'))
  assert.equal(result.containerRemoved, true)
})

test('real malformed output is rejected without replacement-character expansion', async () => {
  await assert.rejects(runIsolatedProcess({ ...config, timeoutMs: 5000,
    files: { 'probe.mjs': 'process.stdout.write(Buffer.alloc(1024, 0x80))' } }),
  /isolated_process_output_encoding_invalid/u)
})
