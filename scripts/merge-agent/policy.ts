import type { MergeAction } from './types.ts'
import type { CommandInvocation } from './runner.ts'
import { validPath } from './observation.ts'

export type CommandPattern = Readonly<{
  executable: string
  argsPrefix?: readonly string[]
  args?: readonly string[]
}>

export type MergeCommandPolicy = Readonly<{
  observationCommands: readonly CommandPattern[]
  mutationCommands: readonly CommandPattern[]
  allowedActions: readonly MergeAction['action'][]
  requiredCheckCommands: readonly RequiredCheckCommand[]
}>

export type RequiredCheckCommand = Readonly<{
  identity: string
  script: string
  args: readonly string[]
  closureSha256: string
}>

const FORBIDDEN_COMMAND_PATTERNS = Object.freeze([
  /(?:^|\s)git\s+push\b[^\n]*--force(?:-with-lease)?\b/u,
  /(?:^|\s)git\s+reset\s+--hard\b/u,
  /(?:^|\s)git\s+(?:rebase|filter-branch|replace)\b/u,
  /(?:^|\s)(?:wrangler|npx\s+wrangler)\s+deploy\b/u,
  /(?:^|\s)npm\s+run\s+deploy(?::|\b)/u,
  /(?:^|\s)gh\s+pr\s+(?:merge|close|edit|ready|reopen|review)\b/u,
  /(?:^|\s)gh\s+api\b[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b/iu,
])

export function readMergeCommandPolicy(value: unknown): MergeCommandPolicy | null {
  if (!isRecord(value)
    || !Array.isArray(value.observationCommands)
    || !Array.isArray(value.mutationCommands)
    || !Array.isArray(value.allowedActions)
    || !Array.isArray(value.requiredCheckCommands)) return null
  const observationCommands = value.observationCommands.map(readPattern)
  const mutationCommands = value.mutationCommands.map(readPattern)
  const allowedActions = value.allowedActions.filter(isMergeAction)
  const requiredCheckCommands = value.requiredCheckCommands.map(readRequiredCheckCommand)
  if (observationCommands.some((entry) => entry === null)
    || mutationCommands.some((entry) => entry === null)
    || allowedActions.length !== value.allowedActions.length
    || requiredCheckCommands.some((entry) => entry === null)
    || new Set(requiredCheckCommands.map((entry) => entry?.identity)).size !== requiredCheckCommands.length) return null
  return Object.freeze({
    observationCommands: Object.freeze(observationCommands as CommandPattern[]),
    mutationCommands: Object.freeze(mutationCommands as CommandPattern[]),
    allowedActions: Object.freeze(allowedActions),
    requiredCheckCommands: Object.freeze(requiredCheckCommands as RequiredCheckCommand[]),
  })
}

export function commandAllowed(invocation: CommandInvocation, policy: MergeCommandPolicy): boolean {
  if (invocationForbidden(invocation) || forbiddenCommands([formatCommand(invocation)]).length > 0) return false
  if (invocation.kind === 'check') return checkCommandAllowed(invocation, policy)
  const patterns = invocation.kind === 'observation' ? policy.observationCommands : policy.mutationCommands
  const matched = patterns.some((pattern) => matches(invocation, pattern))
  return matched && (invocation.executable !== 'git' || invocation.args[0] !== 'add'
    || invocation.args.length === 3 && invocation.args[1] === '--' && validPath(invocation.args[2] ?? ''))
}

export function actionAllowed(action: MergeAction['action'], policy: MergeCommandPolicy): boolean {
  return policy.allowedActions.includes(action)
}

export function boundCheckCommand(
  identity: string,
  policy: MergeCommandPolicy,
): RequiredCheckCommand | null {
  return policy.requiredCheckCommands.find((binding) => binding.identity === identity) ?? null
}

export function checkPlanMatches(
  identity: string,
  script: string,
  args: readonly string[],
  policy: MergeCommandPolicy,
): boolean {
  const binding = boundCheckCommand(identity, policy)
  return binding !== null && binding.script === script && same(binding.args, args)
}

export function boundCheckInvocation(
  identity: string,
  id: string,
  policy: MergeCommandPolicy,
): CommandInvocation | null {
  const binding = boundCheckCommand(identity, policy)
  if (!binding) return null
  return Object.freeze({
    id,
    kind: 'check',
    executable: 'npm',
    args: Object.freeze(['run', binding.script, ...binding.args]),
    timeoutMs: 300_000,
  })
}

export function forbiddenCommands(commands: readonly string[]): readonly string[] {
  return Object.freeze(commands.filter((command) => (
    FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
  )))
}

export function formatCommand(invocation: Pick<CommandInvocation, 'executable' | 'args'>): string {
  return [invocation.executable, ...invocation.args].map((part) => (
    /^[A-Za-z0-9_./:=@+-]+$/u.test(part) ? part : JSON.stringify(part)
  )).join(' ')
}

function invocationForbidden(invocation: CommandInvocation): boolean {
  const [first = '', second = ''] = invocation.args
  if (invocation.executable === 'git') {
    if (first === 'push' && invocation.args.some((argument) => (
      argument === '-f' || argument === '--force' || argument.startsWith('--force-with-lease')
    ))) return true
    if (first === 'reset' && invocation.args.includes('--hard')) return true
    if (['rebase', 'filter-branch', 'replace'].includes(first)) return true
  }
  if (invocation.executable === 'gh') {
    if (first === 'pr' && ['merge', 'close', 'edit', 'ready', 'reopen', 'review'].includes(second)) return true
    if (first === 'api' && !readOnlyGitHubApi(invocation.args.slice(1))) return true
  }
  if (invocation.executable === 'wrangler' && first === 'deploy') return true
  if (invocation.executable === 'npx' && first === 'wrangler' && second === 'deploy') return true
  return invocation.executable === 'npm' && first === 'run' && /^deploy(?::|$)/u.test(second)
}

function readOnlyGitHubApi(args: readonly string[]): boolean {
  let method: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (argument === '--method' || argument === '-X') method = args[index + 1] ?? ''
    if (argument.startsWith('--method=')) method = argument.slice('--method='.length)
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(argument)
      || argument.startsWith('--field=')
      || argument.startsWith('--raw-field=')
      || argument.startsWith('--input=')) return false
  }
  return method?.toUpperCase() === 'GET'
}

function checkCommandAllowed(invocation: CommandInvocation, policy: MergeCommandPolicy): boolean {
  if (invocation.executable !== 'npm' || invocation.args[0] !== 'run') return false
  const script = invocation.args[1] ?? ''
  const args = invocation.args.slice(2)
  return policy.requiredCheckCommands.some((binding) => binding.script === script && same(binding.args, args))
}

function matches(invocation: CommandInvocation, pattern: CommandPattern): boolean {
  if (invocation.executable !== pattern.executable) return false
  if (pattern.args) return same(invocation.args, pattern.args)
  return pattern.argsPrefix ? startsWith(invocation.args, pattern.argsPrefix) : false
}

function readPattern(value: unknown): CommandPattern | null {
  if (!isRecord(value) || !isBoundedString(value.executable)) return null
  const args = Array.isArray(value.args) && value.args.every(isBoundedString) ? value.args : null
  const argsPrefix = Array.isArray(value.argsPrefix) && value.argsPrefix.every(isBoundedString)
    ? value.argsPrefix
    : null
  if ((args === null) === (argsPrefix === null)) return null
  return Object.freeze({
    executable: value.executable,
    ...(args ? { args: Object.freeze([...args]) } : { argsPrefix: Object.freeze([...(argsPrefix ?? [])]) }),
  })
}

function readRequiredCheckCommand(value: unknown): RequiredCheckCommand | null {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || !isBoundedString(value.identity)
    || !isBoundedString(value.script)
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value.script)
    || typeof value.closureSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.closureSha256)
    || !Array.isArray(value.args)
    || !value.args.every(isBoundedString)) return null
  return Object.freeze({
    identity: value.identity,
    script: value.script,
    args: Object.freeze([...value.args]),
    closureSha256: value.closureSha256,
  })
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function startsWith(value: readonly string[], prefix: readonly string[]): boolean {
  return value.length >= prefix.length && prefix.every((entry, index) => value[index] === entry)
}

function isMergeAction(value: unknown): value is MergeAction['action'] {
  return value === 'comment-change' || value === 'check-repair' || value === 'conflict-resolution'
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 256
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
