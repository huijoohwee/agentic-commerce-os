import { expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const esbuild: typeof import('esbuild') = wranglerRequire('esbuild')

// Imported by the shared suite so the private production entrypoint runs in workerd.
it('runs the built production relay with private outbound authentication in workerd', async () => {
  const build = await esbuild.build({ entryPoints: [fileURLToPath(new URL('../../src/sandbox/device-executor.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', write: false, minify: true })
  const bundleSha256 = 'a'.repeat(64), imageId = 'b'.repeat(64), token = 'c'.repeat(64)
  const candidate = 'd'.repeat(40)
  let requests = 0, changed = false
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: build.outputFiles[0]!.text,
    compatibilityDate: '2026-08-22', bindings: {
      EXECUTION_HOST_URL: 'https://executor.example.net', EXECUTION_HOST_BUNDLE_SHA256: bundleSha256,
      EXECUTION_HOST_IMAGE_ID: imageId, EXECUTION_HOST_BEARER_TOKEN: token, DEPLOY_LANE: 'Production',
      RELEASE_CANDIDATE_SHA: candidate, RELEASE_CANDIDATE_DIGEST: 'e'.repeat(64),
      CF_VERSION_METADATA: { id: 'sandbox-version', tag: candidate, timestamp: '2026-09-09T00:00:00Z' },
    }, outboundService: async request => {
      requests++
      expect(request.url).toBe('https://executor.example.net/readyz')
      expect(request.headers.get('authorization')).toBe('Bearer ' + token)
      expect(request.headers.get('x-commerce-host-bundle-sha256')).toBe(bundleSha256)
      expect(request.headers.get('x-commerce-host-image-id')).toBe(imageId)
      return Response.json({ ok: true, contract: 'commerce.local-execution-host/v2', availability: 'device-session',
        bundleSha256: changed ? 'f'.repeat(64) : bundleSha256, imageId }, { headers: { 'cache-control': 'no-store' } })
    } }))
  try {
    const ready = await mf.dispatchFetch('https://sandbox.internal/readyz')
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({ hostProbe: { bundleSha256, imageId } })
    changed = true
    expect((await mf.dispatchFetch('https://sandbox.internal/readyz')).status).toBe(503)
    expect(requests).toBe(2)
    expect((await mf.dispatchFetch('https://sandbox.internal/readyz', {
      headers: { origin: 'https://airvio.co' } })).status).toBe(403)
    expect(requests).toBe(2)
  } finally { await mf.dispose() }
}, 30_000)
