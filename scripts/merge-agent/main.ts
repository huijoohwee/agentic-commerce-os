import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MERGE_AGENT_AUTOMATION = 'disabled-no-trusted-execution-boundary' as const

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

/**
 * The pure orchestrator remains injectable for bounded tests. The production
 * entrypoint cannot safely observe or execute candidate-controlled commands on
 * the operator host until an external default-deny runner is available.
 */
export async function runProductionMergeAgent(
  _environment: RuntimeEnvironment,
  _rootDirectory: string,
): Promise<never> {
  throw new Error(MERGE_AGENT_AUTOMATION)
}

async function main(): Promise<void> {
  try {
    await runProductionMergeAgent(process.env, process.cwd())
  } catch (error) {
    const code = error instanceof Error && error.message === MERGE_AGENT_AUTOMATION
      ? MERGE_AGENT_AUTOMATION
      : 'merge_agent_runtime_failed'
    process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
