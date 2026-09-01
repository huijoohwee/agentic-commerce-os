import {
  runIsolated,
  type IsolatedExecutor,
  type SandboxPurpose,
  type SandboxRequest,
  type SandboxResult,
} from './isolation.js'

export type SandboxExecutorFactory = (
  executionInstanceId: string,
  purpose: SandboxPurpose,
) => IsolatedExecutor

/** Assigns each request a server-owned runtime identity before provisioning. */
export async function runServerIsolated(
  request: SandboxRequest,
  createExecutor: SandboxExecutorFactory,
  createExecutionInstanceId: () => string = defaultExecutionInstanceId,
): Promise<SandboxResult> {
  const executionInstanceId = createExecutionInstanceId()
  const runtimeRequest = Object.freeze({ ...request, instanceId: executionInstanceId })
  return runIsolated(runtimeRequest, {
    executor: createExecutor(executionInstanceId, request.purpose),
  })
}

function defaultExecutionInstanceId(): string {
  return `run-${crypto.randomUUID().replaceAll('-', '')}`
}
