import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createPodmanSandboxExecutor } from '../sandbox-podman-executor.ts'
import { runIsolatedProcess } from '../isolated-process.ts'
import { startLocalHost, LOCAL_HOST_CONTRACT } from './server.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'token-file': { type: 'string' }, 'podman': { type: 'string' },
    'image-id': { type: 'string' }, port: { type: 'string', default: '5191' },
  }, strict: true, allowPositionals: false })
  if (!values['token-file'] || !path.isAbsolute(values['token-file'])
    || !values.podman || !path.isAbsolute(values.podman)
    || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(values['image-id'] ?? '')
    || !/^\d{1,5}$/u.test(values.port)) throw new Error('local_host_arguments_invalid')
  const tokenFile = fs.openSync(values['token-file'], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let token: string
  try {
    const stat = fs.fstatSync(tokenFile)
    if (!stat.isFile() || stat.size < 64 || stat.size > 65 || (stat.mode & 0o077) !== 0
      || stat.uid !== process.getuid?.()) throw new Error('local_host_token_file_invalid')
    token = fs.readFileSync(tokenFile, 'utf8').replace(/\n$/u, '')
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('local_host_token_file_invalid')
  } finally { fs.closeSync(tokenFile) }
  const config = { podmanExecutable: values.podman, imageId: (values['image-id'] as string).replace(/^sha256:/u, '') }
  const probe = async () => {
    const result = await runIsolatedProcess({ ...config, timeoutMs: 5_000, entrypoint: 'probe.mjs',
      files: { 'probe.mjs': 'if(process.version!=="v22.22.3")process.exit(1);console.log("host-ready")' },
      maxOutputBytes: 1_024,
    })
    return result.exitCode === 0 && !result.timedOut && !result.oomKilled
      && !result.outputTruncated && result.containerRemoved && result.stdout.trim() === 'host-ready'
  }
  if (!await probe()) throw new Error('local_host_startup_probe_failed')
  const entrypoint = process.argv[1]
  if (!entrypoint) throw new Error('local_host_entrypoint_missing')
  const host = await startLocalHost({ token, port: Number(values.port),
    identity: { imageId: config.imageId, bundleSha256: createHash('sha256').update(fs.readFileSync(entrypoint)).digest('hex') },
    createExecutor: () => createPodmanSandboxExecutor(config), probe,
  })
  process.stdout.write(`${JSON.stringify({ ok: true, contract: LOCAL_HOST_CONTRACT,
    origin: host.origin, availability: 'device-session' })}\n`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void host.close().catch(() => { process.stderr.write('local_host_shutdown_failed\n'); process.exitCode = 1 })
  })
}
void main().catch(() => { process.stderr.write('local_host_start_failed: verify private token file, arguments and Podman runtime\n'); process.exitCode = 1 })
