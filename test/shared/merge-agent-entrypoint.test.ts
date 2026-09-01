import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { MERGE_AGENT_AUTOMATION } from '../../scripts/merge-agent/main.ts'

const execFileAsync = promisify(execFile)

describe('merge-agent production entrypoint', () => {
  it('stops before candidate-controlled observation, mutation, or evidence writes', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-merge-agent-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-merge-agent-outside-'))
    const marker = path.join(outsideRoot, 'shadow-binary-ran.txt')
    try {
      const binaryDirectory = path.join(fixtureRoot, 'node_modules', '.bin')
      fs.mkdirSync(binaryDirectory, { recursive: true })
      const shadowSource = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`
      writeExecutable(path.join(binaryDirectory, 'gh'), shadowSource)
      writeExecutable(path.join(binaryDirectory, 'git'), shadowSource)
      fs.symlinkSync(outsideRoot, path.join(fixtureRoot, 'evidence-link'))

      const mainPath = path.resolve('scripts/merge-agent/main.ts')
      let output = ''
      let exitCode = 0
      try {
        const result = await execFileAsync(process.execPath, [mainPath], {
          cwd: fixtureRoot,
          env: {
            ...process.env,
            PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
            MERGE_AGENT_EVIDENCE_PATH: 'evidence-link/result.json',
            OPERATOR_BEARER_TOKEN: `fixture-${'x'.repeat(32)}`,
          },
        })
        output = result.stdout
      } catch (error) {
        const failure = error as Readonly<{ code?: number; stdout?: string }>
        exitCode = failure.code ?? 1
        output = failure.stdout ?? ''
      }

      expect(exitCode).toBe(2)
      expect(JSON.parse(output)).toEqual({ ok: false, code: MERGE_AGENT_AUTOMATION })
      expect(fs.existsSync(marker)).toBe(false)
      expect(fs.existsSync(path.join(outsideRoot, 'result.json'))).toBe(false)
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})

function writeExecutable(pathName: string, source: string): void {
  fs.writeFileSync(pathName, source, { mode: 0o700 })
}
