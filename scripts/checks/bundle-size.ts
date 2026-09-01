import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAXIMUM_RUNTIME_CHUNK_BYTES = 500_000

type Chunk = Readonly<{ path: string; sizeBytes: number }>

export function validateEmittedChunks(root: string): readonly Chunk[] {
  const chunks = collectJavaScript(root)
  if (chunks.length === 0) throw new Error('production_bundle:no_javascript_chunk')
  const oversized = chunks.find(({ sizeBytes }) => sizeBytes >= MAXIMUM_RUNTIME_CHUNK_BYTES)
  if (oversized) {
    throw new Error(`production_bundle:chunk_too_large:${path.basename(oversized.path)}:${oversized.sizeBytes}`)
  }
  return Object.freeze(chunks)
}

function collectJavaScript(root: string): Chunk[] {
  const chunks: Chunk[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        chunks.push(Object.freeze({ path: target, sizeBytes: fs.statSync(target).size }))
      }
    }
  }
  return chunks.sort((left, right) => left.path.localeCompare(right.path))
}

function buildProductionBundle(config: string, output: string): readonly Chunk[] {
  fs.mkdirSync(output, { recursive: true })
  const result = spawnSync(process.execPath, [
    './node_modules/wrangler/bin/wrangler.js', 'deploy',
    '-c', config, '--env', 'production', '--dry-run', '--minify', '--outdir', output,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 4_000_000,
    timeout: 120_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`production_bundle:wrangler_failed:${config}`)
  return validateEmittedChunks(output)
}

function main(): void {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-production-bundle-'))
  try {
    const chunks = [
      ...buildProductionBundle('wrangler.core.jsonc', path.join(temporaryRoot, 'core')),
      ...buildProductionBundle('wrangler.edge.jsonc', path.join(temporaryRoot, 'edge')),
    ]
    process.stdout.write(`${JSON.stringify({
      ok: true,
      check: 'bundle-size',
      maximumChunkBytes: MAXIMUM_RUNTIME_CHUNK_BYTES,
      chunks: chunks.map(({ path: chunkPath, sizeBytes }) => ({ name: path.basename(chunkPath), sizeBytes })),
    })}\n`)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_bundle:unknown_error'}\n`)
    process.exitCode = 1
  }
}
