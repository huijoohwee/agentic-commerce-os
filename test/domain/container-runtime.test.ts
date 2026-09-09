import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { podmanArguments, podmanEndpoint, podmanEnvironment, podmanIdentity } from '../../scripts/container-runtime.ts'

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
