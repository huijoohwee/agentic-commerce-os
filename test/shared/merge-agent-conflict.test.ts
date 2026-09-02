import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import boundsJson from '../../config/merge-agent-bounds.json' with { type: 'json' }
import { commandEnvironment } from '../../scripts/merge-agent/environment.ts'
import { orchestrateMergeAgent } from '../../scripts/merge-agent/orchestrator.ts'
import { readMergeCommandPolicy } from '../../scripts/merge-agent/policy.ts'
import { createLocalCommandRunner, type CommandExecution, type CommandInvocation } from '../../scripts/merge-agent/runner.ts'
import type { MergeBounds } from '../../scripts/merge-agent/types.ts'

const POLICY = readMergeCommandPolicy(boundsJson.commandPolicy)
if (!POLICY) throw new Error('merge-agent fixture policy is invalid')

describe('merge-agent conflict index boundary', () => {
  it('stages only the admitted resolution and proves the path left the unmerged index', async () => {
    const repository = conflictingRepository()
    const headRevision = git(repository, ['rev-parse', 'HEAD']).trim()
    const conflictPath = 'conflict.txt'
    const admissions: string[] = []
    try {
      const local = createLocalCommandRunner(repository, {
        environment: commandEnvironment(process.env, 'mutation'),
      })
      const runner = Object.freeze({
        run(invocation: CommandInvocation): Promise<CommandExecution> {
          return invocation.executable === 'gh'
            ? Promise.resolve(githubExecution(invocation, headRevision))
            : local.run(invocation)
        },
      })
      const result = await orchestrateMergeAgent(boundsJson as MergeBounds, {
        lane: 'main',
        semanticScope: 'conflict-fixture',
        claimId: 'claim-fixture',
        leaseEpoch: 4,
        leaseExpiresAtMs: 20_000,
        fenceRevision: 'a'.repeat(40),
        observedFenceRevision: 'a'.repeat(40),
        declaredWriteSet: [conflictPath],
      }, POLICY, {
        actingIdentity: 'merge-agent-fixture',
        target: { repository: 'example/project', pullRequest: 42 },
        plan: {
          checks: {},
          reviewComments: {},
          conflicts: {
            [conflictPath]: {
              approach: 'choose-bounded-resolution',
              patch: replacementPatch(conflictPath, fs.readFileSync(path.join(repository, conflictPath), 'utf8')),
              tokens: 100,
            },
          },
        },
      }, {
        runner,
        nowMs: () => 1_000,
        async readAuthority() {
          return {
            semanticScope: 'conflict-fixture',
            claimId: 'claim-fixture',
            actorId: 'merge-agent-fixture',
            worktree: repository,
            branch: 'main',
            leaseEpoch: 4,
            leaseExpiresAtMs: 20_000,
            fenceRevision: 'a'.repeat(40),
            declaredWriteSet: [conflictPath],
          }
        },
        async admitMutation({ requiredWriteTarget }) {
          admissions.push(requiredWriteTarget)
          return Object.freeze({ ok: true as const })
        },
      })

      expect(result).toMatchObject({ endedBecause: 'completed', verdict: { status: 'local-repairs-complete' } })
      expect(admissions).toEqual([conflictPath, conflictPath])
      expect(git(repository, ['diff', '--name-only', '--diff-filter=U', '--'])).toBe('')
      expect(git(repository, ['diff', '--cached', '--name-only', '--']).trim()).toBe(conflictPath)
      const stage = result.commandEvidence.find(({ args }) => args.join(' ') === `add -- ${conflictPath}`)
      const recheck = result.commandEvidence.find(({ id }) => id.startsWith('post-stage-conflicts-'))
      expect(stage?.sequence).toBeLessThan(recheck?.sequence ?? 0)
    } finally {
      fs.rmSync(repository, { recursive: true, force: true })
    }
  })
})

function conflictingRepository(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-conflict-')))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'merge-agent@example.invalid'])
  git(root, ['config', 'user.name', 'Merge Agent Fixture'])
  fs.writeFileSync(path.join(root, 'conflict.txt'), 'base\n')
  git(root, ['add', '--', 'conflict.txt'])
  git(root, ['commit', '-m', 'base'])
  git(root, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(root, 'conflict.txt'), 'feature\n')
  git(root, ['commit', '-am', 'feature'])
  git(root, ['checkout', 'main'])
  fs.writeFileSync(path.join(root, 'conflict.txt'), 'main\n')
  git(root, ['commit', '-am', 'main'])
  try {
    git(root, ['merge', 'feature'])
  } catch {
    // The deliberately conflicted index is the production behavior under test.
  }
  return root
}

function githubExecution(invocation: CommandInvocation, headRevision: string): CommandExecution {
  const stdout = invocation.id === 'github-pull-state'
    ? JSON.stringify({
      number: 42,
      url: 'https://github.com/example/project/pull/42',
      headRefOid: headRevision,
      reviewDecision: 'APPROVED',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: [],
    })
    : JSON.stringify([[]])
  return Object.freeze({ exitCode: 0, stdout, stderr: '', durationMs: 1, outputTruncated: false })
}

function replacementPatch(relativePath: string, before: string): string {
  const lines = before.replace(/\n$/u, '').split('\n')
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -1,${lines.length} +1 @@`,
    ...lines.map((line) => `-${line}`),
    '+resolved',
    '',
  ].join('\n')
}

function git(workingDirectory: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: workingDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
