import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { podman, podmanArguments, podmanBuildTag, podmanEndpoint, podmanEnvironment, podmanIdentity, podmanRuntimeEnvironment } from '../../scripts/container-runtime.ts'

test('Wrangler build adapter removes only disabled BuildKit provenance', () => {
  const args = ['build', '--load', '--provenance=false', '--platform', 'linux/amd64', '-f', '-', '.']
  assert.deepEqual(podmanArguments(args), ['build', '--load', '--platform', 'linux/amd64', '-f', '-', '.'])
  assert.equal(args[2], '--provenance=false')
  assert.deepEqual(podmanArguments(['build', '--build-arg', '--provenance=false']), ['build', '--build-arg', '--provenance=false'])
  assert.deepEqual(podmanArguments(['run', 'image', '--provenance=false']), ['run', 'image', '--provenance=false'])
  assert.deepEqual(podmanArguments(['build', '--provenance=true']), ['build', '--provenance=true'])
})

test('one explicit Podman socket replaces ambient Docker routing without mutating parent', () => {
  const parent = { ...process.env, CONTAINER_HOST: 'unix:///tmp/podman.sock', DOCKER_HOST: 'tcp://foreign:2375',
    WRANGLER_DOCKER_HOST: 'unix:///foreign.sock', WRANGLER_DOCKER_BIN: 'docker', CONTAINER_CONNECTION: 'foreign' }
  const env = podmanEnvironment(parent)
  assert.equal(env.CONTAINER_HOST, parent.CONTAINER_HOST)
  assert.equal(env.DOCKER_HOST, parent.CONTAINER_HOST)
  assert.equal(env.WRANGLER_DOCKER_HOST, parent.CONTAINER_HOST)
  assert.match(env.WRANGLER_DOCKER_BIN!, /scripts\/container-runtime\.ts$/u)
  assert.equal(env.CONTAINER_CONNECTION, undefined)
  assert.equal(parent.DOCKER_HOST, 'tcp://foreign:2375')
})

test('Podman endpoint refuses remote, malformed and oversized socket inputs', () => {
  for (const invalid of [undefined, '', 'tcp://host:2375', 'ssh://host/run/podman.sock', 'unix://relative',
    'unix:///tmp/socket\n', `unix:///${'x'.repeat(1024)}`]) assert.throws(() => podmanEndpoint(invalid))
  assert.equal(podmanEndpoint('unix:///run/user/1000/podman/podman.sock'), 'unix:///run/user/1000/podman/podman.sock')
})

test('runtime prerequisites fail before Podman I/O and preserve an explicit executable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'podman-runtime-'))
  const parent = { ...process.env, PATH: directory, CONTAINER_HOST: 'unix:///tmp/podman.sock', MINIFLARE_WORKERD_PATH: undefined }
  try {
    assert.throws(() => podmanRuntimeEnvironment(parent), /podman_workerd_override_required/u)
    const file = join(directory, 'not-executable')
    writeFileSync(file, 'not executable', { mode: 0o600 })
    for (const runtime of ['relative/workerd', directory, file, join(directory, 'missing'), '/bad\npath']) {
      assert.throws(() => podmanRuntimeEnvironment({ ...parent, MINIFLARE_WORKERD_PATH: runtime }), /podman_workerd_override_invalid/u)
    }
    const input = { ...parent, MINIFLARE_WORKERD_PATH: process.execPath }
    assert.equal(podmanRuntimeEnvironment(input).MINIFLARE_WORKERD_PATH, process.execPath)
    assert.deepEqual(input, { ...parent, MINIFLARE_WORKERD_PATH: process.execPath })
  } finally { rmSync(directory, { recursive: true }) }
})

test('build identity ignores flag values, old aliases and ambiguous tags', () => {
  const tag = 'cloudflare-dev/sandbox:1234abcd'
  assert.equal(podmanBuildTag(['build', '--load', '-t', tag, '--build-arg', '--tag=ignored', '.']), tag)
  assert.equal(podmanBuildTag(['build', `--tag=${tag}`, '.']), tag)
  for (const args of [
    ['pull', tag], ['build', '--build-arg', '-t', tag], ['build', '--', '-t', tag],
    ['build', '-t', tag, '--tag', tag], ['build', '-t', 'foreign:image'], ['build', '-t'],
  ]) assert.equal(podmanBuildTag(args), null)
})

test('successful build emits only its requested image marker despite cached alias output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'podman-build-marker-'))
  try {
    const aliases = Array.from({ length: 12 }, (_, index) => `Successfully tagged localhost/cloudflare-dev/sandbox:${index.toString(16).padStart(8, '0')}`)
    writeFileSync(join(directory, 'podman'), `#!${process.execPath}\nconsole.log(${JSON.stringify(aliases.join('\n'))}); process.exit(Number(process.env.BUILD_EXIT ?? 0));\n`, { mode: 0o700 })
    const adapter = new URL('../../scripts/container-runtime.ts', import.meta.url)
    const args = [adapter.pathname, 'build', '--load', '-t', 'cloudflare-dev/sandbox:1234abcd', '.']
    for (const exit of [0, 125]) {
      const result = spawnSync(process.execPath, args, { env: { ...process.env, PATH: directory, BUILD_EXIT: String(exit) }, encoding: 'utf8', timeout: 5_000 })
      assert.equal(result.status, exit)
      const markers = result.stdout.split('\n').filter(line => line.startsWith('podman-built '))
      assert.deepEqual(markers, exit === 0 ? ['podman-built cloudflare-dev/sandbox:1234abcd'] : [])
    }
  } finally { rmSync(directory, { recursive: true }) }
})

// Exercise the actual Unix-socket observer without a live engine or new dependency.
test('identity is stable, detects storage changes, and rejects malformed or oversized replies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'podman-identity-'))
  const socket = join(directory, 'api.sock')
  let payload: unknown = { host: { hostname: 'engine', security: { rootless: true } },
    store: { graphRoot: '/storage/a' }, version: { APIVersion: '5.0.0' } }
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v4.0.0/libpod/info')
    response.end(JSON.stringify(payload))
  })
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve))
    const env = { ...process.env, CONTAINER_HOST: `unix://${socket}` }
    const initial = await podmanIdentity(env)
    assert.equal(await podmanIdentity(env), initial)
    payload = { host: { hostname: 'engine', security: { rootless: true } },
      store: { graphRoot: '/storage/b' }, version: { APIVersion: '5.0.0' } }
    assert.notEqual(await podmanIdentity(env), initial)
    payload = { ID: 'docker-compatible-only' }
    await assert.rejects(podmanIdentity(env), /podman_identity_invalid/u)
    payload = 'x'.repeat(65_537)
    await assert.rejects(podmanIdentity(env), /podman_identity_over_budget/u)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true })
  }
})


test('native command failures preserve a bounded diagnostic and exit status', () => {
  const directory = mkdtempSync(join(tmpdir(), 'podman-diagnostic-'))
  try {
    writeFileSync(join(directory, 'podman'), `#!${process.execPath}\nprocess.stderr.write('template field unavailable:' + 'x'.repeat(2000)); process.exit(125);\n`, { mode: 0o700 })
    assert.throws(() => podman(['container', 'inspect', 'owned'], { ...process.env, PATH: directory }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^podman_container_failed:125:template field unavailable:/u)
      assert.equal(error.message.length, 'podman_container_failed:125:'.length + 1024)
      return true
    })
  } finally { rmSync(directory, { recursive: true }) }
})
