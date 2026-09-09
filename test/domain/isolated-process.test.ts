import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertIsolatedProcessHost, runIsolatedProcess } from '../../scripts/isolated-process.ts'

const input = {
  podmanExecutable: '/absent/podman', imageId: 'a'.repeat(64),
  files: { 'probe.mjs': 'console.log("probe")' }, entrypoint: 'probe.mjs', timeoutMs: 1000,
}
test('invalid execution inputs fail before accessing Podman', async () => {
  for (const changed of [
    { imageId: 'node:latest' }, { podmanExecutable: 'podman' }, { timeoutMs: 0 },
    { timeoutMs: 300001 }, { maxOutputBytes: 1048577 }, { entrypoint: '../escape.mjs' },
    { files: { '../escape': 'x', ...input.files } },
    { files: { 'probe.mjs': 'x'.repeat(2097153) } },
    { environment: { NODE_OPTIONS: '--import=/host/code.mjs' } },
    { environment: { AG_SANDBOX_PURPOSE: 'line\nbreak' } },
  ]) await assert.rejects(runIsolatedProcess({ ...input, ...changed }), /isolated_process_/u)
})
test('pre-cancelled jobs create no container', async () => {
  await assert.rejects(runIsolatedProcess({ ...input, signal: AbortSignal.abort() }), /isolated_process_aborted/u)
})

test('isolation admission rejects unsupported hosts and the known conmon OOM race', () => {
  const host = { os: 'linux', cgroupVersion: 'v2', cgroupControllers: ['cpu', 'memory', 'pids'],
    security: { rootless: true, seccompEnabled: true }, conmon: { version: 'conmon version 2.2.0, commit: test' } }
  assert.doesNotThrow(() => assertIsolatedProcessHost(host))
  for (const changed of [null, {}, { ...host, os: 'freebsd' }, { ...host, cgroupVersion: 'v1' },
    { ...host, cgroupControllers: ['cpu', 'pids'] }, { ...host, security: { rootless: false, seccompEnabled: true } },
    { ...host, security: { rootless: true, seccompEnabled: false } },
    { ...host, conmon: { version: 'conmon version 2.1.10, commit: unknown' } },
    { ...host, conmon: { version: 'unknown' } },
  ]) assert.throws(() => assertIsolatedProcessHost(changed), /isolated_process_host_unsupported/u)
})
