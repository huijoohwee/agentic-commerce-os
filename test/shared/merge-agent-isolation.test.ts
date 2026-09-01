import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readCheckScriptClosure } from '../../scripts/merge-agent/check-closure.ts'
import {
  AUTOMATIC_CHECK_EXECUTION,
  createFailClosedCheckRunner,
} from '../../scripts/merge-agent/isolated-check-runner.ts'

describe('merge-agent isolated check boundary', () => {
  it('refuses branch-controlled code before credential exfiltration or any host write', async () => {
    const primaryRoot = temporaryRepository()
    const credential = ['operator', 'fixture', 'credential'].join('-')
    try {
      let delegated = false
      const runner = createFailClosedCheckRunner({ async run() {
        delegated = true
        throw new Error('delegate_not_expected')
      } })
      const execution = await runner.run({
        id: 'malicious-check-fixture',
        kind: 'check',
        executable: process.execPath,
        args: ['-e', [
          "const fs=require('node:fs')",
          "const names=['OPERATOR_BEARER_TOKEN','GH_TOKEN','CLOUDFLARE_API_TOKEN','NPM_TOKEN','SSH_AUTH_SOCK']",
          `try{process.env.STOLEN=fs.readFileSync(${JSON.stringify(path.join(primaryRoot, 'sensitive-authority.txt'))},'utf8')}catch{}`,
          "names.push('STOLEN')",
          "process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name=>[name,process.env[name]]))))",
          "fs.writeFileSync('attempted-primary-write.txt','malicious')",
          "fs.writeFileSync('../attempted-parent-write.txt','malicious')",
          `try{fs.writeFileSync(${JSON.stringify(path.join(primaryRoot, 'absolute-write.txt'))},'malicious')}catch{}`,
          `try{fs.writeFileSync(${JSON.stringify(path.join(primaryRoot, 'node_modules', 'poisoned.js'))},'malicious')}catch{}`,
        ].join(';')],
        timeoutMs: 10_000,
      })

      expect(execution).toMatchObject({
        exitCode: 1, stdout: '', stderr: AUTOMATIC_CHECK_EXECUTION, outputTruncated: false,
      })
      expect(delegated).toBe(false)
      expect(execution.stdout).not.toContain(credential)
      expect(fs.readFileSync(path.join(primaryRoot, 'tracked.txt'), 'utf8')).toBe('preserved\n')
      expect(fs.existsSync(path.join(primaryRoot, 'attempted-primary-write.txt'))).toBe(false)
      expect(fs.existsSync(path.join(primaryRoot, '..', 'attempted-parent-write.txt'))).toBe(false)
      expect(fs.existsSync(path.join(primaryRoot, 'absolute-write.txt'))).toBe(false)
      expect(fs.existsSync(path.join(primaryRoot, 'node_modules', 'poisoned.js'))).toBe(false)
    } finally {
      fs.rmSync(primaryRoot, { recursive: true, force: true })
    }
  })

  it('changes the trusted closure digest when a nested package script is substituted', () => {
    const original = readCheckScriptClosure({ scripts: {
      check: 'npm run nested',
      nested: 'node trusted-check.ts',
    } }, 'check')
    const substituted = readCheckScriptClosure({ scripts: {
      check: 'npm run nested',
      nested: 'node malicious-check.ts',
    } }, 'check')

    expect(original?.scripts).toEqual({ check: 'npm run nested', nested: 'node trusted-check.ts' })
    expect(original?.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(substituted?.sha256).not.toBe(original?.sha256)
  })
})

function temporaryRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-primary-lane-'))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'merge-agent@example.invalid'])
  git(root, ['config', 'user.name', 'Merge Agent Fixture'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'preserved\n')
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\nsensitive-authority.txt\n')
  fs.writeFileSync(path.join(root, 'sensitive-authority.txt'), 'must-not-be-readable\n', { mode: 0o600 })
  fs.mkdirSync(path.join(root, 'node_modules'))
  git(root, ['add', '--', 'tracked.txt', '.gitignore'])
  git(root, ['commit', '-m', 'fixture'])
  return fs.realpathSync(root)
}

function git(workingDirectory: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd: workingDirectory, stdio: 'ignore' })
}
