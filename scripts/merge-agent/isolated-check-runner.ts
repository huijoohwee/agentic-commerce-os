import type { CommandExecution, CommandRunner } from './runner.ts'

export const AUTOMATIC_CHECK_EXECUTION = 'disabled-no-portable-default-deny-sandbox' as const

export function createFailClosedCheckRunner(delegate: CommandRunner): CommandRunner {
  return Object.freeze({
    run(invocation): Promise<CommandExecution> {
      return invocation.kind === 'check'
        ? Promise.resolve(Object.freeze({
          exitCode: 1,
          stdout: '',
          stderr: AUTOMATIC_CHECK_EXECUTION,
          durationMs: 0,
          outputTruncated: false,
        }))
        : delegate.run(invocation)
    },
  })
}
