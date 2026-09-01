import { readCheckScriptClosure } from '../merge-agent/check-closure.ts'
import { createCoreAuthorityDependencies } from '../merge-agent/core-authority.ts'
import { forbiddenCommands } from '../merge-agent/index.ts'
import {
  orchestrateMergeAgent,
  type MergeOrchestrationLaneBinding,
} from '../merge-agent/orchestrator.ts'
import { patchPaths } from '../merge-agent/patch.ts'
import { readMergeCommandPolicy, type MergeCommandPolicy } from '../merge-agent/policy.ts'
import type { CommandExecution, CommandInvocation } from '../merge-agent/runner.ts'
import type { MergeBounds } from '../merge-agent/types.ts'
import { readJson, report, type Assertion } from './common.ts'

type BoundsConfig = MergeBounds & Readonly<{
  laneBinding: Readonly<{ source: string; requiredFields: readonly string[] }>
  authority: Readonly<Record<string, unknown>>
  executionPolicy: Readonly<{ automaticMutation: string; automaticCheckExecution: string }>
  commandPolicy: unknown
}>

const FIXTURE_BEARER = 'fixture-operator-bearer-token-never-persisted'
const NOW_MS = 1_000
const FIXTURE_BRANCH = 'named-check-branch'
const FIXTURE_WORKTREE = '/named-check/worktree'
const bounds = readJson<BoundsConfig>('config/merge-agent-bounds.json')
const packageDocument = readJson<{ scripts?: Readonly<Record<string, string>> }>('package.json')
const policy = readMergeCommandPolicy(bounds.commandPolicy)
if (!policy) throw new Error('merge_agent_command_policy_invalid')

const successful = await scenario('success', policy)
const spoofed = await scenario('spoof', policy)
const expanded = await scenario('expanded-authority', policy)
const aba = await scenario('aba', policy)
const exactCheck = await checkScenario('check:integration', policy)
const mismatchedCheck = await checkScenario('typecheck', policy)
const integrationBinding = policy.requiredCheckCommands.find(({ identity }) => identity === 'Integration Gate')
const integrationClosure = readCheckScriptClosure(packageDocument, integrationBinding?.script ?? '')

const assertions: Assertion[] = [
  { condition: bounds.iterationCeiling <= 10 && bounds.wallClockMinutes <= 30, detail: 'recorded numeric bounds' },
  {
    condition: bounds.laneBinding.source === 'runtime-input' && bounds.laneBinding.requiredFields.length === 4,
    detail: 'ephemeral lane authority required at invocation',
  },
  { condition: Object.values(bounds.authority).every((value) => value !== true), detail: 'zero elevated authority' },
  {
    condition: bounds.executionPolicy.automaticMutation === 'disabled'
      && bounds.executionPolicy.automaticCheckExecution === 'disabled',
    detail: 'production entrypoint fails closed without a portable default-deny execution sandbox',
  },
  {
    condition: integrationBinding?.script === 'check:integration'
      && integrationBinding.args.length === 0
      && policy.requiredCheckCommands.length === 1
      && integrationClosure?.sha256 === integrationBinding.closureSha256,
    detail: 'GitHub check identity maps to one exact checked-in package script',
  },
  {
    condition: packageDocument.scripts?.['merge-agent:run'] === 'node scripts/merge-agent/main.ts',
    detail: 'production Node entrypoint is executable from the package script',
  },
  {
    condition: successful.result.endedBecause === 'completed'
      && successful.mutations.length === 1
      && successful.result.admissionChecks.length === 1,
    detail: 'orchestrator executes one admitted local repair',
  },
  {
    condition: successful.core.requests.length === 3
      && successful.core.requests.every(({ body }) => (
        body.leaseEpoch === 1 && body.requiredWriteTarget === 'scripts/owned.ts'
      )),
    detail: 'Core admission contract carries epoch and exact target',
  },
  {
    condition: successful.core.requests.every(({ authorized }) => authorized)
      && !JSON.stringify(successful.result).includes(FIXTURE_BEARER),
    detail: 'bearer is used in memory but absent from evidence output',
  },
  {
    condition: spoofed.result.endedBecause === 'circuit-breaker'
      && spoofed.mutations.length === 0
      && spoofed.core.requests.length === 1
      && spoofed.runner.invocations.some(({ args }) => args.join(' ') === 'apply --check --whitespace=nowarn -'),
    detail: 'Git-effective path spoof refuses before apply',
  },
  {
    condition: expanded.result.endedBecause === 'circuit-breaker'
      && expanded.mutations.length === 0
      && expanded.result.authorityChecks.length === 1
      && expanded.result.admissionChecks.length === 0,
    detail: 'expanded caller write set refuses before apply',
  },
  {
    condition: aba.result.endedBecause === 'circuit-breaker'
      && aba.mutations.length === 0
      && aba.core.requests.length === 3
      && aba.result.admissionChecks.some(({ admitted, code }) => !admitted && code === 'fence_stale'),
    detail: 'ABA epoch drift refuses before apply',
  },
  {
    condition: exactCheck.result.endedBecause === 'completed'
      && exactCheck.result.checkFailureEvidence[0]?.phase === 'preflight'
      && exactCheck.result.checkFailureEvidence[0].commandSequence
        < (exactCheck.result.commandEvidence.find(({ kind }) => kind === 'mutation')?.sequence ?? 0),
    detail: 'exact bound failure output and root cause precede first mutation',
  },
  {
    condition: mismatchedCheck.result.endedBecause === 'circuit-breaker'
      && mismatchedCheck.runner.invocations.every(({ kind }) => kind !== 'check' && kind !== 'mutation'),
    detail: 'passing substitute script is rejected before check or mutation',
  },
  {
    condition: [successful, spoofed, expanded, aba].every(({ result }) => (
      forbiddenCommands(result.issuedCommands).length === 0
      && result.verdict.githubMutationPerformed === false
      && result.verdict.canonicalMutationPerformed === false
      && result.verdict.deploymentPerformed === false
    )),
    detail: 'all orchestrator branches retain zero remote or release authority',
  },
]

report('merge-agent', assertions)

type Scenario = 'success' | 'spoof' | 'expanded-authority' | 'aba'

async function checkScenario(script: string, commandPolicy: MergeCommandPolicy) {
  const lane = liveLane(['scripts/owned.ts'])
  const runner = checkFixtureRunner()
  const core = coreFixture('success', lane)
  const result = await orchestrateMergeAgent(bounds, lane, commandPolicy, {
    actingIdentity: 'named-check-merge-agent',
    target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
    plan: {
      conflicts: {},
      reviewComments: {},
      checks: {
        'Integration Gate': {
          script,
          approaches: [{ approach: 'repair-check', patch: patch('scripts/owned.ts'), tokens: 100 }],
        },
      },
    },
  }, createCoreAuthorityDependencies({
    runner,
    lane,
    coreAdmissionUrl: 'https://edge.test/v1/operator/claims/admit',
    operatorBearerToken: FIXTURE_BEARER,
    releaseCandidateSha: 'b'.repeat(40),
    fetchAuthority: core.fetchAuthority,
    nowMs: () => NOW_MS,
  }))
  return Object.freeze({ result, runner })
}

async function scenario(mode: Scenario, commandPolicy: MergeCommandPolicy) {
  const declaredWriteSet = mode === 'expanded-authority'
    ? ['scripts/owned.ts', 'outside/expanded.ts']
    : ['scripts/owned.ts']
  const targetPath = mode === 'expanded-authority' ? 'outside/expanded.ts' : 'scripts/owned.ts'
  const lane = liveLane(declaredWriteSet)
  const runner = fixtureRunner(targetPath, mode === 'spoof' ? ['outside/spoofed.ts'] : undefined)
  const core = coreFixture(mode, lane)
  const dependencies = createCoreAuthorityDependencies({
    runner,
    lane,
    coreAdmissionUrl: 'https://edge.test/v1/operator/claims/admit',
    operatorBearerToken: FIXTURE_BEARER,
    releaseCandidateSha: 'b'.repeat(40),
    fetchAuthority: core.fetchAuthority,
    nowMs: () => NOW_MS,
  })
  const result = await orchestrateMergeAgent(bounds, lane, commandPolicy, {
    actingIdentity: 'named-check-merge-agent',
    target: { repository: 'example/agentic-commerce-os', pullRequest: 42 },
    plan: {
      conflicts: {},
      checks: {},
      reviewComments: {
        '101': {
          withinRequirements: true,
          requiresOperatorDecision: false,
          repair: { approach: `repair-${mode}`, patch: patch(targetPath), tokens: 100 },
        },
      },
    },
  }, dependencies)
  return Object.freeze({
    result,
    runner,
    core,
    mutations: runner.invocations.filter(({ kind }) => kind === 'mutation'),
  })
}

function coreFixture(mode: Scenario, lane: MergeOrchestrationLaneBinding) {
  const requests: Array<Readonly<{ authorized: boolean; body: Record<string, unknown> }>> = []
  return Object.freeze({
    requests,
    async fetchAuthority(request: Request): Promise<Response> {
      const body = await request.json<Record<string, unknown>>()
      requests.push(Object.freeze({
        authorized: request.headers.get('authorization') === `Bearer ${FIXTURE_BEARER}`,
        body,
      }))
      if (mode === 'aba' && requests.length === 3) {
        return Response.json({
          ok: false,
          code: 'fence_stale',
          holdingClaimId: lane.claimId,
          holdingLeaseEpoch: lane.leaseEpoch + 1,
          holdingFenceRevision: lane.fenceRevision,
        }, { status: 409 })
      }
      return Response.json({
        ok: true,
        semanticScope: lane.semanticScope,
        claimId: lane.claimId,
        actorId: 'named-check-merge-agent',
        worktree: FIXTURE_WORKTREE,
        branch: FIXTURE_BRANCH,
        leaseEpoch: lane.leaseEpoch,
        leaseExpiresAtMs: lane.leaseExpiresAtMs,
        fenceRevision: lane.fenceRevision,
        declaredWriteSet: mode === 'expanded-authority' ? ['scripts/owned.ts'] : lane.declaredWriteSet,
      })
    },
  })
}

function fixtureRunner(reviewPath: string, effectivePatchPaths?: readonly string[]) {
  const invocations: CommandInvocation[] = []
  return Object.freeze({
    invocations,
    async run(invocation: CommandInvocation): Promise<CommandExecution> {
      invocations.push(invocation)
      if (invocation.id === 'github-pull-state') return execution(JSON.stringify({
        number: 42,
        url: 'https://github.com/example/agentic-commerce-os/pull/42',
        headRefOid: 'c'.repeat(40),
        reviewDecision: 'CHANGES_REQUESTED',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
      }))
      if (invocation.id === 'github-review-comments') {
        return execution(JSON.stringify([[{ id: 101, path: reviewPath, body: 'Address the bounded review.' }]]))
      }
      if (invocation.id === 'local-conflicts' || invocation.id.startsWith('patch-check-')) return execution('')
      if (invocation.id === 'local-top-level') return execution(FIXTURE_WORKTREE)
      if (invocation.id === 'local-branch') return execution(FIXTURE_BRANCH)
      if (invocation.id === 'local-head') return execution('c'.repeat(40))
      if (invocation.id.startsWith('patch-numstat-')) {
        const paths = effectivePatchPaths ?? patchPaths(invocation.stdin ?? '') ?? []
        return execution(paths.map((path) => `1\t1\t${path}\0`).join(''))
      }
      return execution('applied')
    },
  })
}

function checkFixtureRunner() {
  const invocations: CommandInvocation[] = []
  let checkRuns = 0
  return Object.freeze({
    invocations,
    async run(invocation: CommandInvocation): Promise<CommandExecution> {
      invocations.push(invocation)
      if (invocation.id === 'github-pull-state') return execution(JSON.stringify({
        number: 42,
        url: 'https://github.com/example/agentic-commerce-os/pull/42',
        headRefOid: 'c'.repeat(40),
        reviewDecision: 'APPROVED',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'Integration Gate', conclusion: 'FAILURE' }],
      }))
      if (invocation.id === 'github-review-comments') return execution('[]')
      if (invocation.id === 'local-conflicts' || invocation.id.startsWith('patch-check-')) return execution('')
      if (invocation.id === 'local-top-level') return execution(FIXTURE_WORKTREE)
      if (invocation.id === 'local-branch') return execution(FIXTURE_BRANCH)
      if (invocation.id === 'local-head') return execution('c'.repeat(40))
      if (invocation.id.startsWith('patch-numstat-')) return execution('1\t1\tscripts/owned.ts\0')
      if (invocation.kind === 'check') {
        checkRuns += 1
        return execution(checkRuns === 1 ? 'root cause fixture' : 'passed', checkRuns === 1 ? 1 : 0)
      }
      return execution('applied')
    },
  })
}

function liveLane(declaredWriteSet: readonly string[]): MergeOrchestrationLaneBinding {
  return Object.freeze({
    lane: FIXTURE_BRANCH,
    semanticScope: 'named-check-scope',
    claimId: 'named-check-claim',
    leaseEpoch: 1,
    leaseExpiresAtMs: NOW_MS + 10_000,
    fenceRevision: 'a'.repeat(40),
    observedFenceRevision: 'a'.repeat(40),
    declaredWriteSet: Object.freeze([...declaredWriteSet]),
  })
}

function patch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`
}

function execution(stdout: string, exitCode = 0): CommandExecution {
  return Object.freeze({ exitCode, stdout, stderr: '', durationMs: 1, outputTruncated: false })
}
