import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { forbiddenCommands } from '../../scripts/merge-agent/index.ts'
import { orchestrateMergeAgent } from '../../scripts/merge-agent/orchestrator.ts'
import { patchPaths } from '../../scripts/merge-agent/patch.ts'
import { readMergeCommandPolicy } from '../../scripts/merge-agent/policy.ts'
import type { CommandExecution, CommandInvocation } from '../../scripts/merge-agent/runner.ts'
import type { MergeBounds } from '../../scripts/merge-agent/types.ts'
import boundsJson from '../../config/merge-agent-bounds.json' with { type: 'json' }

const POLICY = readMergeCommandPolicy(boundsJson.commandPolicy)
if (!POLICY) throw new Error('merge-agent property policy is invalid')

describe('Feature: agentic-graph-commerce-platform, Property 24: Bounded merge mutation', () => {
  it('keeps every changed path in one live lane and inside recorded bounds', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 2_000 }), { maxLength: 15 }),
      fc.boolean(),
      fc.boolean(),
      async (tokenCosts, staleFence, outsideWriteSet) => {
        const nowMs = 10_000
        const fenceRevision = 'd'.repeat(40)
        const bounds: MergeBounds = {
          tokenCeiling: 8_000,
          iterationCeiling: 10,
          wallClockMinutes: 30,
          circuitBreaker: 'stale authority or bound reached',
        }
        const comments = tokenCosts.map((_, index) => ({
          id: index + 1,
          path: outsideWriteSet && index === 0 ? 'outside/file.ts' : `scripts/owned/file-${index}.ts`,
          body: `repair ${index}`,
        }))
        const invocations: CommandInvocation[] = []
        const runner = Object.freeze({
          invocations,
          async run(invocation: CommandInvocation): Promise<CommandExecution> {
            invocations.push(invocation)
            if (invocation.id === 'github-pull-state') return execution(JSON.stringify({
              number: 1,
              url: 'https://github.com/example/project/pull/1',
              headRefOid: 'f'.repeat(40),
              reviewDecision: comments.length ? 'CHANGES_REQUESTED' : 'APPROVED',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              statusCheckRollup: [],
            }))
            if (invocation.id === 'github-review-comments') return execution(JSON.stringify([comments]))
            if (invocation.id === 'local-conflicts') return execution('')
            if (invocation.id === 'local-top-level') return execution('/fixture/worktree')
            if (invocation.id === 'local-branch') return execution('fixture-branch')
            if (invocation.id === 'local-head') return execution('f'.repeat(40))
            if (invocation.id.startsWith('patch-numstat-')) {
              return execution((patchPaths(invocation.stdin ?? '') ?? []).map((path) => `1\t1\t${path}\0`).join(''))
            }
            if (invocation.id.startsWith('patch-check-')) return execution('')
            return execution('applied')
          },
        })
        const result = await orchestrateMergeAgent(bounds, {
          lane: 'fixture-branch',
          semanticScope: 'fixture-scope',
          claimId: 'fixture-claim',
          leaseEpoch: 1,
          leaseExpiresAtMs: nowMs + 1_000,
          fenceRevision,
          observedFenceRevision: staleFence ? 'e'.repeat(40) : fenceRevision,
          declaredWriteSet: ['scripts/owned/'],
        }, POLICY, {
          actingIdentity: 'fixture-agent',
          target: { repository: 'example/project', pullRequest: 1 },
          plan: {
            checks: {},
            conflicts: {},
            reviewComments: Object.fromEntries(comments.map(({ id, path }, index) => [String(id), {
              withinRequirements: true,
              requiresOperatorDecision: false,
              repair: {
                approach: `repair-${id}`,
                patch: patch(path),
                tokens: tokenCosts[index] ?? 1,
              },
            }])),
          },
        }, {
          runner,
          nowMs: () => nowMs,
          async readAuthority() {
            return {
              semanticScope: 'fixture-scope',
              claimId: 'fixture-claim',
              actorId: 'fixture-agent',
              worktree: '/fixture/worktree',
              branch: 'fixture-branch',
              leaseEpoch: 1,
              leaseExpiresAtMs: nowMs + 1_000,
              fenceRevision: staleFence ? 'e'.repeat(40) : fenceRevision,
              declaredWriteSet: ['scripts/owned/'],
            }
          },
          async admitMutation() { return Object.freeze({ ok: true as const }) },
        })
        const mutations = invocations.filter(({ kind }) => kind === 'mutation')
        expect(mutations.length).toBeLessThanOrEqual(10)
        expect(result.changedPaths.every(path => path.startsWith('scripts/owned/'))).toBe(true)
        expect(result.admissionChecks.every(({ admitted, request }) => (
          admitted && request.requiredWriteTarget.startsWith('scripts/owned/')
        ))).toBe(true)
        expect(forbiddenCommands(result.issuedCommands)).toEqual([])
        expect(result.actions.every(({ lane }, index) => lane === 'fixture-branch' && index + 1 === result.actions[index]?.sequence)).toBe(true)
        if (staleFence) expect(result).toMatchObject({ endedBecause: 'circuit-breaker', actions: [] })
        if (!staleFence && outsideWriteSet && comments.length > 0) {
          expect(result).toMatchObject({ endedBecause: 'out-of-write-set', actions: [] })
          expect(mutations).toEqual([])
        }
      },
    ), { numRuns: 300, seed: 20_260_836 })
  })
})

function execution(stdout: string): CommandExecution {
  return Object.freeze({ exitCode: 0, stdout, stderr: '', durationMs: 1, outputTruncated: false })
}

function patch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`
}
