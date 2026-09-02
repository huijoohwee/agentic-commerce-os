import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_ARTIFACT_SCHEMA } from '../evidence-check-artifact.ts'
import { parseGovernedCheckCommand } from '../evidence-command-policy.ts'
import {
  EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA,
  EVIDENCE_DISPATCH_RECEIPT_SCHEMA,
  EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA,
} from '../evidence-dispatch-receipt.ts'
import {
  EVIDENCE_FINDING_CODES,
  EVIDENCE_REQUEST_SCHEMA,
  EVIDENCE_VERDICT_SCHEMA,
} from '../evidence-contracts.ts'
import {
  EVIDENCE_RUNTIME_INPUTS,
  ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA,
} from '../evidence-runtime-context.ts'
import { readTaskBoundsSnapshot, readVerificationBaseline } from '../evidence-verdict-runner.ts'

const REQUIRED_EXTERNAL_FAILURES = Object.freeze([
  'dispatch_trust_anchor_unavailable',
  'dispatch_trust_anchor_mismatch',
  'evidence_sink_untrusted',
  'source_fingerprint_unavailable',
])

export type EvidenceContractResult = Readonly<{
  ok: boolean
  check: 'evidence-contract'
  assertionCount: number
  failures: readonly string[]
}>

export function evaluateEvidenceContract(workspaceRoot = process.cwd()): EvidenceContractResult {
  const workspace = realDirectory(workspaceRoot)
  const context = workspace ? Object.freeze({ workspaceRoot: workspace }) : null
  const baseline = context ? readVerificationBaseline(context) : null
  const snapshot = context ? readTaskBoundsSnapshot(context) : null
  const scripts = workspace ? readPackageScripts(workspace) : null
  const namedChecks = snapshot?.namedCheckGroups.map(({ namedCheck }) => namedCheck) ?? []
  const runtimeFlags = Object.values(EVIDENCE_RUNTIME_INPUTS).map(({ flag }) => flag)
  const runtimeEnvironment = Object.values(EVIDENCE_RUNTIME_INPUTS).map(({ environment }) => environment)
  const assertions = [
    assertion(Boolean(workspace), 'workspace root is a readable real directory'),
    assertion(Boolean(baseline), 'verification baseline satisfies the evidence schema'),
    assertion(baseline?.aggregateCheck === 'npm run check:implementation', 'aggregate evidence consumes the non-evidence implementation gate'),
    assertion(Boolean(snapshot && snapshot.taskCount > 0 && snapshot.taskCount === snapshot.boundsCount), 'task snapshot is complete and non-empty'),
    assertion(Boolean(scripts), 'package scripts are readable'),
    assertion(scripts?.['check:evidence'] === 'node scripts/checks/evidence.ts', 'aggregate evidence entrypoint cannot inject candidate runtime authority'),
    assertion(Boolean(scripts && !scriptReaches(scripts, 'check:implementation', 'check:evidence')), 'implementation gate is not circular through aggregate evidence'),
    assertion(Boolean(scripts && !scriptReaches(scripts, 'check:named', 'check:evidence')), 'named implementation gate is not circular through aggregate evidence'),
    assertion(namedChecks.every((command) => command !== 'npm run check' && command !== 'npm run check:evidence'), 'task checks never name an aggregate evidence gate'),
    assertion(namedChecks.every(governedNamedCheck), 'task checks use governed argv without shell evaluation'),
    assertion(new Set(runtimeFlags).size === runtimeFlags.length && runtimeFlags.every((flag) => flag.startsWith('--') && flag.endsWith('=')), 'runtime authority CLI bindings are unique value flags'),
    assertion(new Set(runtimeEnvironment).size === runtimeEnvironment.length
      && runtimeEnvironment.every((name) => name.startsWith('AGENTIC_COMMERCE_EVIDENCE_')), 'runtime authority environment bindings are unambiguous and product-scoped'),
    assertion(REQUIRED_EXTERNAL_FAILURES.every((code) => EVIDENCE_FINDING_CODES.has(code as never)), 'evidence schema represents every external-authority failure'),
    assertion(EVIDENCE_REQUEST_SCHEMA.endsWith('/v2') && EVIDENCE_VERDICT_SCHEMA.endsWith('/v2')
      && CHECK_ARTIFACT_SCHEMA.endsWith('/v2'), 'request, verdict, and check-artifact schemas are versioned'),
    assertion(EVIDENCE_DISPATCH_RECEIPT_SCHEMA.endsWith('/v1')
      && EVIDENCE_DISPATCH_TRUST_ANCHOR_SCHEMA.endsWith('/v1')
      && EVIDENCE_ARTIFACT_SINK_AUTHORITY_SCHEMA.endsWith('/v1')
      && ISOLATED_CHECK_EXECUTOR_MODULE_SCHEMA.endsWith('/v1'), 'external dispatch, sink, and executor contracts are versioned'),
    assertion(parseGovernedCheckCommand('npm run test:unit') !== null
      && parseGovernedCheckCommand('npm run test:unit && npm run check:evidence') === null, 'governed command parsing rejects shell composition'),
  ]
  const failures = assertions.filter(({ condition }) => !condition).map(({ detail }) => detail)
  return Object.freeze({
    ok: failures.length === 0,
    check: 'evidence-contract',
    assertionCount: assertions.length,
    failures: Object.freeze(failures),
  })
}

type Assertion = Readonly<{ condition: boolean; detail: string }>

function assertion(condition: boolean, detail: string): Assertion {
  return Object.freeze({ condition, detail })
}

function governedNamedCheck(command: string): boolean {
  return parseGovernedCheckCommand(command) !== null
    || command === 'npm --prefix "$AGENTIC_CANVAS_OS_ROOT" run worktree:lifecycle:check'
}

function scriptReaches(scripts: Readonly<Record<string, string>>, start: string, target: string): boolean {
  const pending = [start]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)
    for (const dependency of npmRunDependencies(scripts[current] ?? '')) {
      if (dependency === target) return true
      pending.push(dependency)
    }
  }
  return false
}

function npmRunDependencies(command: string): readonly string[] {
  return Object.freeze([...command.matchAll(/(?:^|[;&|]\s*)npm run ([a-z0-9:_-]+)/gu)].map((match) => match[1] ?? ''))
}

function readPackageScripts(workspaceRoot: string): Readonly<Record<string, string>> | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as unknown
    if (!isRecord(value) || !isRecord(value.scripts)) return null
    const entries = Object.entries(value.scripts)
    return entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')
      ? Object.freeze(Object.fromEntries(entries))
      : null
  } catch {
    return null
  }
}

function realDirectory(requested: string): string | null {
  try {
    const resolved = fs.realpathSync(path.resolve(requested))
    return fs.statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function main(): void {
  const result = evaluateEvidenceContract()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
