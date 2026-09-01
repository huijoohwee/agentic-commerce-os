import { getSandbox, Sandbox as CloudflareSandbox } from '@cloudflare/sandbox'

import { isHttpFailure, jsonResponse, readJsonObject } from '../shared/http.js'
import {
  SANDBOX_CONTAINER_MEMORY_MEGABYTES,
  classifyExecutionLimit,
  parseSandboxRequest,
  type IsolatedExecutor,
  type SandboxPurpose,
} from './isolation.js'
import { SANDBOX_HARNESS_SOURCE, readHarnessOutput } from './theme-build.js'
import {
  handlePreviewRequest,
  readPreviewIdentity,
  type PreviewIdentity,
  type PreviewRepository,
} from './preview.js'
import {
  handleSandboxProofRequest,
  isSandboxProofRequest,
  type SandboxProofOptions,
  type SandboxProofRuntime,
  type SandboxProofWorkerEnv,
} from './provision.js'
import { runServerIsolated } from './server-run.js'

export { readHarnessOutput } from './theme-build.js'

export { parseSandboxRequest, runIsolated } from './isolation.js'
export type {
  AttemptedCall,
  InstanceRecord,
  IsolatedExecutor,
  RunIsolatedOptions,
  SandboxLimits,
  SandboxPurpose,
  SandboxRequest,
  SandboxResult,
} from './isolation.js'

type SandboxWorkerEnv = Readonly<{
  Sandbox: DurableObjectNamespace<Sandbox>
  SANDBOX_PROOF_BEARER_TOKEN?: string
  SANDBOX_PUBLIC_PROOF_ONLY?: string
}>
type SandboxFetchOptions = Readonly<{
  createExecutionInstanceId?: () => string
  createSandbox?: (
    namespace: DurableObjectNamespace<Sandbox>,
    instanceId: string,
    purpose: SandboxPurpose,
  ) => CloudflareSandbox
  proof?: SandboxProofOptions
}>
const PREVIEW_STORAGE_KEY = 'agentic-graph-preview'

export class Sandbox extends CloudflareSandbox {
  async savePreviewIdentity(value: unknown): Promise<void> {
    const identity = readPreviewIdentity(value)
    if (!identity) throw new Error('preview_identity_invalid')
    await this.ctx.storage.put(PREVIEW_STORAGE_KEY, identity)
  }

  async readPreviewIdentity(): Promise<PreviewIdentity | null> {
    return readPreviewIdentity(await this.ctx.storage.get(PREVIEW_STORAGE_KEY))
  }

  async deletePreviewIdentity(): Promise<void> {
    await this.ctx.storage.delete(PREVIEW_STORAGE_KEY)
  }
}

export default {
  async fetch(request: Request, env: SandboxWorkerEnv): Promise<Response> {
    return handleSandboxFetch(request, env)
  },
} satisfies ExportedHandler<SandboxWorkerEnv>

export async function handleSandboxFetch(
  request: Request,
  env: SandboxWorkerEnv,
  options: SandboxFetchOptions = {},
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/livez') {
    return jsonResponse({
      ok: true,
      contract: 'agentic-graph-sandbox/v1',
      readinessRung: 'dev-proven',
      deliveryBoundary: 'closed',
    })
  }
  if (isSandboxProofRequest(request)) {
    return await handleSandboxProofRequest(request, env as unknown as SandboxProofWorkerEnv, {
      ...options.proof,
      createSandbox: options.proof?.createSandbox ?? createCloudflareProvisionSandbox,
    })
  }
  if (env.SANDBOX_PUBLIC_PROOF_ONLY === 'true') {
    return jsonResponse({ ok: false, code: 'not_found' }, 404)
  }
  const previewResponse = await handlePreviewRequest(request, previewRepository(env))
  if (previewResponse) return previewResponse
  if (request.method !== 'POST' || url.pathname !== '/v1/run') {
    return jsonResponse({ ok: false, code: 'not_found' }, 404)
  }
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return jsonResponse(body, 400)
  const parsed = parseSandboxRequest(body)
  if (!parsed) return jsonResponse({ ok: false, code: 'sandbox_request_invalid' }, 400)
  const result = await runServerIsolated(
    parsed,
    (executionInstanceId, purpose) => cloudflareExecutor(
      (options.createSandbox ?? createCloudflareSandbox)(env.Sandbox, executionInstanceId, purpose),
      purpose,
    ),
    options.createExecutionInstanceId,
  )
  return jsonResponse(
    result,
    result.ok ? 200 : result.code === 'sandbox_call_not_allowlisted'
      ? 409
      : result.code === 'sandbox_build_failed' ? 422 : 503,
  )
}

function createCloudflareSandbox(
  namespace: DurableObjectNamespace<Sandbox>,
  instanceId: string,
  purpose: SandboxPurpose,
): CloudflareSandbox {
  return getSandbox(namespace, instanceId, {
    normalizeId: true,
    sleepAfter: '10m',
    labels: { purpose },
  })
}

function createCloudflareProvisionSandbox(
  namespace: DurableObjectNamespace,
  instanceId: string,
): SandboxProofRuntime {
  return getSandbox(namespace as unknown as DurableObjectNamespace<Sandbox>, instanceId, {
    normalizeId: true,
    sleepAfter: '1m',
    keepAlive: false,
    labels: { purpose: 'provision-proof' },
  }) as unknown as SandboxProofRuntime
}

function cloudflareExecutor(sandbox: CloudflareSandbox, purpose: SandboxPurpose): IsolatedExecutor {
  return Object.freeze({
    async execute(input, timeoutMs) {
      const startedAt = Date.now()
      const executionId = crypto.randomUUID().replaceAll('-', '')
      const inputPath = `/tmp/agentic-graph-${executionId}-input.json`
      const harnessPath = `/tmp/agentic-graph-${executionId}-harness.mjs`
      const artifactPath = `/tmp/agentic-graph-${executionId}-artifact.json`
      const executableTargetPath = `/tmp/agentic-graph-${executionId}-target.mjs`
      const executableRunnerPath = `/tmp/agentic-graph-${executionId}-runner.mjs`
      await Promise.all([
        sandbox.writeFile(inputPath, JSON.stringify(input)),
        sandbox.writeFile(harnessPath, SANDBOX_HARNESS_SOURCE),
      ])
      try {
        const result = await sandbox.exec(`node ${harnessPath}`, {
          timeout: timeoutMs,
          env: {
            AG_SANDBOX_INPUT_PATH: inputPath,
            AG_SANDBOX_ARTIFACT_PATH: artifactPath,
            AG_SANDBOX_PURPOSE: purpose,
            AG_SANDBOX_MEMORY_LIMIT_MB: String(SANDBOX_CONTAINER_MEMORY_MEGABYTES),
            AG_SANDBOX_TIMEOUT_MS: String(timeoutMs),
            AG_EXECUTABLE_TARGET_PATH: executableTargetPath,
            AG_EXECUTABLE_RUNNER_PATH: executableRunnerPath,
          },
        })
        const observed = readHarnessOutput(result.stdout)
        return Object.freeze({
          ok: result.success && observed?.ok === true,
          exceededLimit: classifyExecutionLimit(result.stderr, result.duration, timeoutMs),
          attemptedCalls: observed?.attemptedCalls ?? Object.freeze([]),
          buildResult: observed?.buildResult ?? null,
          surfaceResult: observed?.surfaceResult ?? null,
          failureReason: observed?.failureReason ?? null,
        })
      } catch (error) {
        const text = error instanceof Error ? `${error.name}:${error.message}` : 'unknown'
        return Object.freeze({
          ok: false,
          exceededLimit: classifyExecutionLimit(text, Date.now() - startedAt, timeoutMs),
          attemptedCalls: Object.freeze([]),
          buildResult: null,
          surfaceResult: null,
          failureReason: null,
        })
      }
    },
    async terminate() {
      await sandbox.destroy()
    },
  })
}

function previewRepository(env: SandboxWorkerEnv): PreviewRepository {
  const stub = (previewId: string) => env.Sandbox.getByName(`preview-${previewId}`)
  return Object.freeze({
    async save(identity: PreviewIdentity) {
      await stub(identity.previewId).savePreviewIdentity(identity)
    },
    async read(previewId: string) {
      return await stub(previewId).readPreviewIdentity()
    },
    async delete(previewId: string) {
      await stub(previewId).deletePreviewIdentity()
    },
  })
}
