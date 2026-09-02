import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MAXIMUM_RUNTIME_CHUNK_BYTES,
  validateEmittedChunks,
} from '../../scripts/checks/bundle-size.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('production bundle chunk ceiling', () => {
  it('accepts JavaScript chunks below the ceiling and ignores source maps', () => {
    const root = temporaryDirectory()
    fs.writeFileSync(path.join(root, 'index.js'), Buffer.alloc(MAXIMUM_RUNTIME_CHUNK_BYTES - 1))
    fs.writeFileSync(path.join(root, 'index.js.map'), Buffer.alloc(MAXIMUM_RUNTIME_CHUNK_BYTES + 1))
    expect(validateEmittedChunks(root)).toMatchObject([{ sizeBytes: MAXIMUM_RUNTIME_CHUNK_BYTES - 1 }])
  })

  it('rejects an oversized chunk and an empty output', () => {
    const oversized = temporaryDirectory()
    fs.writeFileSync(path.join(oversized, 'index.js'), Buffer.alloc(MAXIMUM_RUNTIME_CHUNK_BYTES))
    expect(() => validateEmittedChunks(oversized)).toThrow('production_bundle:chunk_too_large:index.js:500000')
    expect(() => validateEmittedChunks(temporaryDirectory())).toThrow('production_bundle:no_javascript_chunk')
  })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-commerce-bundle-test-'))
  temporaryDirectories.push(directory)
  return directory
}
