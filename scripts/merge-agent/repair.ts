export const MAXIMUM_REPAIR_ATTEMPTS = 2

export type RepairAttempt = Readonly<{
  check: string
  observedOutput: string
  approach: string
  attempt: number
  outcome: 'pass' | 'fail'
}>

export type RepairResult = Readonly<{
  attempts: readonly RepairAttempt[]
  passed: boolean
  code: 'repair_approach_exhausted' | null
  diagnosedRootCause: string | null
  escalated: boolean
}>

export async function repairCheck(
  check: string,
  initialOutput: string,
  approaches: readonly string[],
  applyRepair: (approach: string, attempt: number) => Promise<void>,
  rerunCheck: () => Promise<Readonly<{ passed: boolean; output: string }>>,
): Promise<RepairResult> {
  const attempts: RepairAttempt[] = []
  let observedOutput = boundedOutput(initialOutput)
  for (let index = 0; index < Math.min(approaches.length, MAXIMUM_REPAIR_ATTEMPTS); index += 1) {
    const approach = approaches[index] ?? ''
    await applyRepair(approach, index + 1)
    const rerun = await rerunCheck()
    attempts.push(Object.freeze({
      check,
      observedOutput,
      approach,
      attempt: index + 1,
      outcome: rerun.passed ? 'pass' : 'fail',
    }))
    if (rerun.passed) return result(attempts, true, null, null, false)
    observedOutput = boundedOutput(rerun.output)
  }
  const repeatedApproach = attempts.length === MAXIMUM_REPAIR_ATTEMPTS
    && attempts[0]?.approach === attempts[1]?.approach
  return result(
    attempts,
    false,
    attempts.length > 0 ? 'repair_approach_exhausted' : null,
    attempts.length > 0
      ? repeatedApproach
        ? `The repeated approach did not clear ${check}.`
        : `The bounded repair approaches did not clear ${check}.`
      : null,
    true,
  )
}

function result(
  attempts: readonly RepairAttempt[],
  passed: boolean,
  code: RepairResult['code'],
  diagnosedRootCause: string | null,
  escalated: boolean,
): RepairResult {
  return Object.freeze({ attempts: Object.freeze([...attempts]), passed, code, diagnosedRootCause, escalated })
}

function boundedOutput(output: string): string {
  return output.slice(0, 4_096)
}
