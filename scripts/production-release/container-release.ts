import { canonicalJson } from '../evidence-integrity.ts'
import { PRODUCTION_SANDBOX_CONTAINER_APPLICATION } from './contracts.ts'

export const SANDBOX_CONTAINER_APPLICATION = PRODUCTION_SANDBOX_CONTAINER_APPLICATION
export const SANDBOX_CONTAINER_PROOF_SCHEMA =
  'agentic-commerce-sandbox-container-deployment/v1' as const

export type SandboxContainerProof = Readonly<{
  schema: typeof SANDBOX_CONTAINER_PROOF_SCHEMA
  rollout: 'immediate-complete'
  buildInputDigest: string
  applicationId: string
  applicationName: typeof SANDBOX_CONTAINER_APPLICATION
  imageReference: string
  imageDigest: string
  applicationVersion: number
  state: 'active' | 'ready'
  instances: number
  updatedAt: string
}>

export function validateSandboxContainerDeployment(
  value: unknown,
  buildInputDigest: string,
): SandboxContainerProof {
  requireContainer(/^[0-9a-f]{64}$/u.test(buildInputDigest), 'container_build_input_digest_invalid')
  requireContainer(Array.isArray(value), 'container_inventory_invalid')
  const matches = value.filter((entry) => record(entry)?.name === SANDBOX_CONTAINER_APPLICATION)
  requireContainer(matches.length === 1, 'container_application_cardinality_invalid')
  const application = record(matches[0])
  requireContainer(application !== null, 'container_application_invalid')
  exactKeys(application, ['created_at', 'id', 'image', 'instances', 'name', 'state', 'updated_at', 'version'])
  requireContainer(typeof application.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(application.id)
    && application.name === SANDBOX_CONTAINER_APPLICATION
    && (application.state === 'active' || application.state === 'ready')
    && Number.isSafeInteger(application.instances) && Number(application.instances) >= 0
    && Number(application.instances) <= 1
    && Number.isSafeInteger(application.version) && Number(application.version) >= 1
    && typeof application.image === 'string'
    && typeof application.updated_at === 'string' && Number.isFinite(Date.parse(application.updated_at)),
  'container_application_state_invalid')
  const digest = /@(sha256:[0-9a-f]{64})$/u.exec(application.image)?.[1]
  requireContainer(typeof digest === 'string', 'container_image_digest_missing')
  return Object.freeze({
    schema: SANDBOX_CONTAINER_PROOF_SCHEMA,
    rollout: 'immediate-complete',
    buildInputDigest,
    applicationId: application.id,
    applicationName: SANDBOX_CONTAINER_APPLICATION,
    imageReference: application.image,
    imageDigest: digest,
    applicationVersion: application.version,
    state: application.state,
    instances: application.instances,
    updatedAt: application.updated_at,
  } as SandboxContainerProof)
}

export function sandboxContainerApplicationAbsent(value: unknown): boolean {
  if (!Array.isArray(value)) throw new Error('production_container_release:container_inventory_invalid')
  return value.every((entry) => record(entry)?.name !== SANDBOX_CONTAINER_APPLICATION)
}

export function sameContainerDeployment(
  observed: SandboxContainerProof,
  expected: SandboxContainerProof,
): boolean {
  return canonicalJson({
    buildInputDigest: observed.buildInputDigest,
    applicationId: observed.applicationId,
    applicationName: observed.applicationName,
    imageDigest: observed.imageDigest,
    applicationVersion: observed.applicationVersion,
  }) === canonicalJson({
    buildInputDigest: expected.buildInputDigest,
    applicationId: expected.applicationId,
    applicationName: expected.applicationName,
    imageDigest: expected.imageDigest,
    applicationVersion: expected.applicationVersion,
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  requireContainer(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    'container_application_shape_invalid')
}

function requireContainer(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_container_release:${code}`)
}
