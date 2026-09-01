import fs from 'node:fs'
import path from 'node:path'

export type GovernedCheckInvocation = Readonly<{
  runtime: 'npm'
  argumentsValue: readonly string[]
}>

export type GovernedCommandContext = Readonly<{
  agenticCanvasOsRoot: string | null
}>

const SCRIPT_NAME = /^[a-z0-9][a-z0-9:_-]{0,127}$/u
const ARGUMENT = /^--?[a-zA-Z0-9][a-zA-Z0-9._:/=@,+-]{0,511}$/u

export function parseGovernedCheckCommand(
  command: string,
  context: GovernedCommandContext = Object.freeze({ agenticCanvasOsRoot: null }),
): GovernedCheckInvocation | null {
  if (command === 'npm --prefix "$AGENTIC_CANVAS_OS_ROOT" run worktree:lifecycle:check') {
    const trustedRoot = validatedRepositoryRoot(context.agenticCanvasOsRoot)
    return trustedRoot ? Object.freeze({
      runtime: 'npm',
      argumentsValue: Object.freeze(['--prefix', trustedRoot, 'run', 'worktree:lifecycle:check']),
    }) : null
  }
  const tokens = command.split(' ')
  if (tokens.some((token) => token.length === 0)) return null
  const [executable, run, scriptName, separator, ...argumentsValue] = tokens
  if (executable !== 'npm' || run !== 'run' || !scriptName || !SCRIPT_NAME.test(scriptName)) return null
  if (separator === undefined) return Object.freeze({ runtime: 'npm', argumentsValue: Object.freeze(['run', scriptName]) })
  if (separator !== '--' || argumentsValue.length === 0 || !argumentsValue.every((value) => ARGUMENT.test(value))) return null
  return Object.freeze({ runtime: 'npm', argumentsValue: Object.freeze(['run', scriptName, '--', ...argumentsValue]) })
}

function validatedRepositoryRoot(requested: string | null): string | null {
  if (!requested || !path.isAbsolute(requested)) return null
  try {
    const resolved = fs.realpathSync(requested)
    const packageValue = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')) as unknown
    if (!isRecord(packageValue) || !isRecord(packageValue.scripts)
      || typeof packageValue.scripts['worktree:lifecycle:check'] !== 'string') return null
    return resolved
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
