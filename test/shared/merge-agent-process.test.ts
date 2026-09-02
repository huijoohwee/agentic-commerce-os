import { describe, expect, it } from 'vitest'
import { resolveConflicts } from '../../scripts/merge-agent/conflict.ts'
import { sanitizeEvidenceText } from '../../scripts/merge-agent/evidence.ts'
import {
  orchestrateMergeAgent,
  type LaneAuthorityObservation,
  type MergeOrchestrationLaneBinding,
} from '../../scripts/merge-agent/orchestrator.ts'
import { patchPaths } from '../../scripts/merge-agent/patch.ts'
import { commandAllowed, readMergeCommandPolicy } from '../../scripts/merge-agent/policy.ts'
import { repairCheck } from '../../scripts/merge-agent/repair.ts'
import { handleReviewComment } from '../../scripts/merge-agent/review.ts'
import { createLocalCommandRunner, type CommandExecution, type CommandInvocation } from '../../scripts/merge-agent/runner.ts'
import type { MergeBounds } from '../../scripts/merge-agent/types.ts'
import boundsJson from '../../config/merge-agent-bounds.json' with { type: 'json' }

const BOUNDS = boundsJson as MergeBounds
const POLICY = readMergeCommandPolicy(boundsJson.commandPolicy)
const FIXTURE_BRANCH = 'fixture-branch'
const FIXTURE_WORKTREE = '/fixture/worktree'
if (!POLICY) throw new Error('merge-agent fixture policy is invalid')

describe('merge-agent process branches', () => {
  it.each([
    [{ withinRequirements: false, withinWriteSet: true, requiresOperatorDecision: false }, 'scope-gap'],
    [{ withinRequirements: true, withinWriteSet: false, requiresOperatorDecision: false }, 'out-of-write-set'],
    [{ withinRequirements: true, withinWriteSet: true, requiresOperatorDecision: true }, 'requires-operator-decision'],
  ] as const)('records the review refusal branch', (flags, reason) => {
    const outcome = handleReviewComment({
      id: 'comment',
      path: 'src/file.ts',
      requestedBehavior: 'requested behavior',
      ...flags,
    }, new Set())
    expect(outcome).toMatchObject({ change: null, reason })
  })

  it('permits at most one change for one comment', () => {
    const comment = {
      id: 'comment',
      path: 'src/file.ts',
      requestedBehavior: 'requested behavior',
      withinRequirements: true,
      withinWriteSet: true,
      requiresOperatorDecision: false,
    }
    expect(handleReviewComment(comment, new Set()).change).not.toBeNull()
    expect(handleReviewComment(comment, new Set(['comment']))).toMatchObject({ change: null, reason: 'scope-gap' })
  })

  it('stops an identical repair approach at two attempts', async () => {
    const result = await repairCheck(
      'required-check',
      'failed',
      ['same approach', 'same approach', 'forbidden third approach'],
      async () => undefined,
      async () => ({ passed: false, output: 'still failing' }),
    )
    expect(result).toMatchObject({ code: 'repair_approach_exhausted', escalated: true })
    expect(result.attempts).toHaveLength(2)
  })

  it('preserves conflicts outside the declared write set', () => {
    const result = resolveConflicts([
      { path: 'docs/outside.md', originalBytes: 'before', resolvedBytes: 'after' },
    ], ['src/'])
    expect(result).toMatchObject({ resolutions: [], unresolved: [{ reason: 'out-of-write-set' }] })
  })

  it('observes GitHub state and emits truthful evidence for bounded local repairs', async () => {
    const runner = fixtureRunner({
      comments: [{ id: 101, path: 'scripts/owned/review.ts', body: 'Address the review.' }],
      checks: [{ name: 'Integration Gate', conclusion: 'FAILURE' }],
      conflicts: ['scripts/owned/conflict.ts'],
      mergeable: 'CONFLICTING',
      checkOutcomes: [false, false, true],
    })
    const result = await orchestrateMergeAgent(BOUNDS, liveLane(), POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {
          'scripts/owned/conflict.ts': repair('resolve-conflict', 'scripts/owned/conflict.ts', 100),
        },
        reviewComments: {
          '101': {
            withinRequirements: true,
            requiresOperatorDecision: false,
            repair: repair('address-review', 'scripts/owned/review.ts', 100),
          },
        },
        checks: {
          'Integration Gate': {
            script: 'check:integration',
            approaches: [
              repair('first-repair', 'scripts/owned/check.ts', 100),
              repair('different-repair', 'scripts/owned/check.ts', 100),
            ],
          },
        },
      },
    }, dependencies(runner))

    expect(result).toMatchObject({
      schema: 'agentic-commerce-merge-agent-evidence/v1',
      endedBecause: 'completed',
      verdict: {
        status: 'local-repairs-complete',
        reason: null,
        githubMutationPerformed: false,
        canonicalMutationPerformed: false,
        deploymentPerformed: false,
        releaseControllerRequired: true,
      },
    })
    expect(result.actions.map(({ sequence, action, checkOutcome }) => ({ sequence, action, checkOutcome }))).toEqual([
      { sequence: 1, action: 'conflict-resolution', checkOutcome: 'not-run' },
      { sequence: 2, action: 'conflict-resolution', checkOutcome: 'not-run' },
      { sequence: 3, action: 'comment-change', checkOutcome: 'not-run' },
      { sequence: 4, action: 'check-repair', checkOutcome: 'fail' },
      { sequence: 5, action: 'check-repair', checkOutcome: 'pass' },
    ])
    expect(result.authorityChecks).toHaveLength(10)
    expect(result.changedPaths).toEqual([
      'scripts/owned/check.ts',
      'scripts/owned/conflict.ts',
      'scripts/owned/review.ts',
    ])
    expect(result.commandEvidence.slice(0, 3).map(({ id }) => id)).toEqual([
      'github-pull-state', 'github-review-comments', 'local-conflicts',
    ])
    const firstMutationSequence = result.commandEvidence.find(({ kind }) => kind === 'mutation')?.sequence ?? 0
    expect(result.checkFailureEvidence[0]).toMatchObject({
      checkIdentity: 'Integration Gate', phase: 'preflight', commandSequence: 7, localOutcome: 'fail',
    })
    expect(result.checkFailureEvidence[0]?.commandSequence).toBeLessThan(firstMutationSequence)
    expect(result.checkFailureEvidence[0]?.outputDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.checkFailureEvidence[0]?.diagnosedRootCause).toBe('failed')
    expect(result.commandEvidence.filter(({ kind }) => kind === 'mutation').map(({ executable, args }) => (
      `${executable} ${args.join(' ')}`
    ))).toEqual([
      'git apply --whitespace=nowarn -',
      'git add -- scripts/owned/conflict.ts',
      'git apply --whitespace=nowarn -',
      'git apply --whitespace=nowarn -',
      'git apply --whitespace=nowarn -',
    ])
    expect(result.artifactDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(runner.invocations.filter(({ executable }) => executable === 'gh').every(({ args }) => (
      args[0] === 'pr' && args[1] === 'view'
      || args[0] === 'api' && args.includes('GET')
    ))).toBe(true)
  })

  it('rechecks authority before every mutation and stops on a changed fence', async () => {
    const runner = fixtureRunner({
      comments: [
        { id: 1, path: 'scripts/owned/one.ts', body: 'First.' },
        { id: 2, path: 'scripts/owned/two.ts', body: 'Second.' },
      ],
    })
    let authorityReads = 0
    const result = await orchestrateMergeAgent(BOUNDS, liveLane(), POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {},
        checks: {},
        reviewComments: {
          '1': reviewPlan('scripts/owned/one.ts'),
          '2': reviewPlan('scripts/owned/two.ts'),
        },
      },
    }, {
      runner,
      nowMs: () => 1_000,
      async readAuthority() {
        authorityReads += 1
        return authorityReads <= 2 ? authority() : { ...authority(), fenceRevision: 'b'.repeat(40) }
      },
      async admitMutation() { return Object.freeze({ ok: true as const }) },
    })

    expect(result).toMatchObject({ endedBecause: 'circuit-breaker', verdict: { status: 'blocked' } })
    expect(result.actions).toHaveLength(1)
    expect(result.changedPaths).toEqual(['scripts/owned/one.ts'])
    expect(runner.invocations.filter(({ kind }) => kind === 'mutation')).toHaveLength(1)
  })

  it.each([
    ['checkout', { localTopLevel: '/wrong/worktree' }, {}],
    ['branch', { localBranch: 'wrong-branch' }, {}],
    ['head', { localHead: 'd'.repeat(40) }, {}],
    ['actor', {}, { actorId: 'wrong-actor' }],
  ] as const)('refuses a valid claim replayed from the wrong %s before patch preflight', async (
    _kind,
    runnerOptions,
    authorityOverride,
  ) => {
    const runner = fixtureRunner({
      comments: [{ id: 101, path: 'scripts/owned/review.ts', body: 'Address the review.' }],
      ...runnerOptions,
    })
    const result = await orchestrateMergeAgent(BOUNDS, liveLane(), POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {}, checks: {}, reviewComments: { '101': reviewPlan('scripts/owned/review.ts') },
      },
    }, {
      ...dependencies(runner),
      async readAuthority() { return authority(authorityOverride) },
    })

    expect(result).toMatchObject({ endedBecause: 'circuit-breaker', actions: [] })
    expect(runner.invocations.some(({ id }) => id.startsWith('patch-'))).toBe(false)
    expect(runner.invocations.some(({ kind }) => kind === 'mutation')).toBe(false)
  })

  it('refuses unsafe check commands and out-of-write-set patches before mutation', async () => {
    const runner = fixtureRunner({
      checks: [{ name: 'unsafe-check', conclusion: 'FAILURE' }],
    })
    const result = await orchestrateMergeAgent(BOUNDS, liveLane(), POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {},
        reviewComments: {},
        checks: {
          'unsafe-check': {
            script: 'deploy:production:edge',
            approaches: [repair('unsafe', 'outside/file.ts', 100)],
          },
        },
      },
    }, dependencies(runner))

    expect(result).toMatchObject({ endedBecause: 'scope-gap', verdict: { status: 'blocked' } })
    expect(result.actions).toEqual([])
    expect(runner.invocations.filter(({ kind }) => kind === 'mutation')).toEqual([])
  })

  it('rejects a passing plan command that differs from the failing check binding', async () => {
    const runner = fixtureRunner({
      checks: [{ name: 'Integration Gate', conclusion: 'FAILURE' }],
      checkOutcomes: [true],
    })
    const result = await orchestrateMergeAgent(BOUNDS, liveLane(), POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {},
        reviewComments: {},
        checks: {
          'Integration Gate': {
            script: 'typecheck',
            approaches: [repair('misdirected-repair', 'scripts/owned/check.ts', 100)],
          },
        },
      },
    }, dependencies(runner))

    expect(result).toMatchObject({ endedBecause: 'circuit-breaker', verdict: { status: 'blocked' } })
    expect(result.checkFailureEvidence).toEqual([])
    expect(runner.invocations.filter(({ kind }) => kind === 'check')).toEqual([])
    expect(runner.invocations.filter(({ kind }) => kind === 'mutation')).toEqual([])
  })

  it('refuses a Git-effective path that differs from the declared patch headers before mutation', async () => {
    const runner = fixtureRunner({
      comments: [{ id: 101, path: 'scripts/owned/review.ts', body: 'Address the review.' }],
      effectivePatchPaths: ['outside/spoofed.ts'],
    })
    const result = await orchestrateMergeAgent(BOUNDS, liveLane(), POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {},
        checks: {},
        reviewComments: { '101': reviewPlan('scripts/owned/review.ts') },
      },
    }, dependencies(runner))

    expect(result).toMatchObject({ endedBecause: 'circuit-breaker', verdict: { status: 'blocked' } })
    expect(result.actions).toEqual([])
    expect(result.authorityChecks).toHaveLength(1)
    expect(runner.invocations.filter(({ kind }) => kind === 'mutation')).toEqual([])
    expect(runner.invocations.filter(({ id }) => id.startsWith('patch-')).map(({ args }) => args)).toEqual([
      ['apply', '--numstat', '-z', '-'],
      ['apply', '--check', '--whitespace=nowarn', '-'],
    ])
  })

  it('refuses an expanded caller write set that differs from the authoritative claim', async () => {
    const runner = fixtureRunner({
      comments: [{ id: 101, path: 'outside/expanded.ts', body: 'Address the review.' }],
    })
    const lane = Object.freeze({
      ...liveLane(),
      declaredWriteSet: Object.freeze(['scripts/owned/', 'outside/']),
    })
    const result = await orchestrateMergeAgent(BOUNDS, lane, POLICY, {
      actingIdentity: 'merge-agent-fixture',
      target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
      plan: {
        conflicts: {},
        checks: {},
        reviewComments: { '101': reviewPlan('outside/expanded.ts') },
      },
    }, {
      ...dependencies(runner),
      async readAuthority() { return authority() },
    })

    expect(result).toMatchObject({ endedBecause: 'circuit-breaker', verdict: { status: 'blocked' } })
    expect(result.actions).toEqual([])
    expect(result.authorityChecks).toHaveLength(1)
    expect(result.admissionChecks).toEqual([])
    expect(runner.invocations.filter(({ kind }) => kind === 'mutation')).toEqual([])
  })

  it('rejects implicit GitHub API writes despite the observation prefix', () => {
    expect(commandAllowed({
      id: 'implicit-post',
      kind: 'observation',
      executable: 'gh',
      args: ['api', 'repos/example/project/issues/1', '-f', 'state=closed'],
      timeoutMs: 1_000,
    }, POLICY)).toBe(false)
  })

  it('runs local argv commands without a shell', async () => {
    const result = await createLocalCommandRunner(process.cwd()).run({
      id: 'local-runner-example',
      kind: 'check',
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("runner-ok")'],
      timeoutMs: 5_000,
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'runner-ok', outputTruncated: false })
  })

  it('redacts credentials from bounded check evidence text', () => {
    const credential = ['fixture', 'credential', 'value'].join('-')
    const sanitized = sanitizeEvidenceText(`authorization: Bearer ${credential}\n"auth_token":"${credential}"`)
    expect(sanitized).not.toContain(credential)
    expect(sanitized.match(/\[REDACTED\]/gu)).toHaveLength(2)
  })
})

type FixtureOptions = Readonly<{
  comments?: readonly Readonly<{ id: number; path: string; body: string }>[]
  checks?: readonly Readonly<{ name: string; conclusion: string }>[]
  conflicts?: readonly string[]
  mergeable?: string
  checkOutcomes?: readonly boolean[]
  effectivePatchPaths?: readonly string[]
  localTopLevel?: string
  localBranch?: string
  localHead?: string
}>

function fixtureRunner(options: FixtureOptions = {}) {
  const invocations: CommandInvocation[] = []
  const stagedConflicts = new Set<string>()
  let checkIndex = 0
  const runner = Object.freeze({
    invocations,
    async run(invocation: CommandInvocation): Promise<CommandExecution> {
      invocations.push(invocation)
      if (invocation.id === 'github-pull-state') return execution(JSON.stringify({
        number: 42,
        url: 'https://github.com/example/agentic-commerce-os/pull/42',
        headRefOid: 'c'.repeat(40),
        reviewDecision: options.comments?.length ? 'CHANGES_REQUESTED' : 'APPROVED',
        mergeable: options.mergeable ?? 'MERGEABLE',
        mergeStateStatus: options.mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN',
        statusCheckRollup: options.checks ?? [],
      }))
      if (invocation.id === 'github-review-comments') return execution(JSON.stringify([options.comments ?? []]))
      if (invocation.id === 'local-conflicts' || invocation.id.startsWith('post-stage-conflicts-')) {
        return execution((options.conflicts ?? []).filter((entry) => !stagedConflicts.has(entry)).join('\n'))
      }
      if (invocation.id === 'local-top-level') return execution(options.localTopLevel ?? FIXTURE_WORKTREE)
      if (invocation.id === 'local-branch') return execution(options.localBranch ?? FIXTURE_BRANCH)
      if (invocation.id === 'local-head') return execution(options.localHead ?? 'c'.repeat(40))
      if (invocation.id.startsWith('patch-numstat-')) {
        const paths = options.effectivePatchPaths ?? patchPaths(invocation.stdin ?? '') ?? []
        return execution(paths.map((path) => `1\t1\t${path}\0`).join(''))
      }
      if (invocation.id.startsWith('patch-check-')) return execution('')
      if (invocation.kind === 'check') {
        const passed = options.checkOutcomes?.[checkIndex] ?? true
        checkIndex += 1
        return execution(passed ? 'passed' : 'failed', passed ? 0 : 1)
      }
      if (invocation.executable === 'git' && invocation.args[0] === 'add') {
        stagedConflicts.add(invocation.args[2] ?? '')
      }
      return execution('applied')
    },
  })
  return runner
}

function execution(stdout: string, exitCode = 0): CommandExecution {
  return Object.freeze({ exitCode, stdout, stderr: '', durationMs: 1, outputTruncated: false })
}

function liveLane(): MergeOrchestrationLaneBinding {
  return Object.freeze({
    lane: FIXTURE_BRANCH,
    semanticScope: 'fixture-scope',
    claimId: 'fixture-claim',
    leaseEpoch: 3,
    leaseExpiresAtMs: 10_000,
    fenceRevision: 'a'.repeat(40),
    observedFenceRevision: 'a'.repeat(40),
    declaredWriteSet: Object.freeze(['scripts/owned/']),
  })
}

function authority(overrides: Partial<LaneAuthorityObservation> = {}): LaneAuthorityObservation {
  return Object.freeze({
    semanticScope: 'fixture-scope',
    claimId: 'fixture-claim',
    actorId: 'merge-agent-fixture',
    worktree: FIXTURE_WORKTREE,
    branch: FIXTURE_BRANCH,
    leaseEpoch: 3,
    leaseExpiresAtMs: 10_000,
    fenceRevision: 'a'.repeat(40),
    declaredWriteSet: Object.freeze(['scripts/owned/']),
    ...overrides,
  })
}

function dependencies(runner: ReturnType<typeof fixtureRunner>) {
  return Object.freeze({
    runner,
    nowMs: () => 1_000,
    async readAuthority() { return authority() },
    async admitMutation() { return Object.freeze({ ok: true as const }) },
  })
}

function reviewPlan(path: string) {
  return Object.freeze({
    withinRequirements: true,
    requiresOperatorDecision: false,
    repair: repair(`repair-${path}`, path, 100),
  })
}

function repair(approach: string, path: string, tokens: number) {
  return Object.freeze({ approach, patch: patch(path), tokens })
}

function patch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`
}
