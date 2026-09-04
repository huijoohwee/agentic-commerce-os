import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson, sha256 } from '../evidence-integrity.ts'
import { parseHumanPresenceAnchorProof } from './human-presence-anchor.ts'

export const PRODUCTION_WORKER_DEPLOYMENT_SCHEMA = 'agentic-commerce-worker-deployment/v3'
export const PRODUCTION_TOPOLOGY_SCHEMA = 'agentic-commerce-production-topology/v1'
export const PRODUCTION_ROUTE_PROOF_SCHEMA = 'agentic-commerce-production-route-proof/v1'
export const PRODUCTION_STORAGE_TRANSITION_SCHEMA = 'agentic-commerce-storage-transition/v1'
export const PRODUCTION_ROUTE_PATTERN = 'airvio.co/agentic-commerce-os*'
export const PRODUCTION_ROUTE_URL = 'https://airvio.co/agentic-commerce-os/' as const
export const PRODUCTION_ZONE_NAME = 'airvio.co'
export const PRODUCTION_CORE_WORKER = 'agentic-commerce-core-production'
export const PRODUCTION_EDGE_WORKER = 'agentic-commerce-edge-production'
export const PRODUCTION_SANDBOX_WORKER = 'agentic-commerce-sandbox-production'
export const PRODUCTION_SANDBOX_CONTAINER_APPLICATION =
  'agentic-commerce-sandbox-production-sandbox' as const
export const PRODUCTION_SANDBOX_TOPOLOGY_SCHEMA = 'agentic-commerce-production-sandbox-topology/v1'
export const HUMAN_PRESENCE_ANCHOR_PLACEHOLDER = 'external-trust-anchor-required'

export const PRODUCTION_DURABLE_OBJECT_BINDINGS = Object.freeze([
  Object.freeze({ name: 'AGENT_REGISTRY', className: 'AgentRegistry' }),
  Object.freeze({ name: 'AUTHORING_CLAIM', className: 'AuthoringClaim' }),
  Object.freeze({ name: 'CHECKOUT_SESSION', className: 'CheckoutSession' }),
  Object.freeze({ name: 'INTENT_ROUTE', className: 'IntentRoute' }),
  Object.freeze({ name: 'REVENUE_LEDGER', className: 'RevenueLedger' }),
  Object.freeze({ name: 'THEME_DEPLOYMENT', className: 'ThemeDeployment' }),
])

export const PRODUCTION_EDGE_SECRETS = Object.freeze([
  'MCP_BEARER_TOKEN',
  'OPERATOR_BEARER_TOKEN',
  'STOREFRONT_SESSION_SECRET',
])
export const PRODUCTION_CORE_SECRETS = Object.freeze([
  'DISCOVERY_PROVIDER_BEARER_TOKEN',
  'AGENTIC_OS_ADMISSION_AUTH_SECRET',
  'CHECKOUT_PROVIDER_AUTH_SECRET',
  'MARKETPLACE_PROVIDER_AUTH_SECRET',
])

const CORE_SERVICES = Object.freeze([
  Object.freeze({ binding: 'ACOS_ADMISSION', service: 'agentic-canvas-os' }),
  Object.freeze({ binding: 'CHECKOUT_PROVIDER', service: 'agentic-travel-commerce-production' }),
  Object.freeze({ binding: 'COMMERCE_SANDBOX', service: 'agentic-commerce-sandbox-production' }),
  Object.freeze({ binding: 'DOCS_MCP', service: 'agentic-mcp' }),
  Object.freeze({ binding: 'MARKETPLACE_PROVIDER', service: 'agentic-marketplace-production' }),
])
const EDGE_SERVICES = Object.freeze([
  Object.freeze({ binding: 'COMMERCE_CORE', service: PRODUCTION_CORE_WORKER }),
])
const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const MAXIMUM_JSON_BYTES = 1_048_576

type JsonObject = Record<string, unknown>

export type ProductionTopologyProof = Readonly<{
  schema: typeof PRODUCTION_TOPOLOGY_SCHEMA
  coreWorker: typeof PRODUCTION_CORE_WORKER
  edgeWorker: typeof PRODUCTION_EDGE_WORKER
  route: Readonly<{ pattern: typeof PRODUCTION_ROUTE_PATTERN; zoneName: typeof PRODUCTION_ZONE_NAME }>
  durableObjectBindings: typeof PRODUCTION_DURABLE_OBJECT_BINDINGS
  coreRequiredSecrets: typeof PRODUCTION_CORE_SECRETS
  edgeRequiredSecrets: typeof PRODUCTION_EDGE_SECRETS
}>

export type WorkerDeploymentProof = Readonly<{
  schema: typeof PRODUCTION_WORKER_DEPLOYMENT_SCHEMA
  worker: 'core' | 'edge' | 'sandbox'
  candidateSha: string
  candidateDigest: string
  versionId: string
  percentage: 100
  bindingDigest: string
  remoteScriptDigest: string
  remoteRuntimeDigest: string
  migrationConfigDigest: string
}>

export type ProductionSandboxTopologyProof = Readonly<{
  schema: typeof PRODUCTION_SANDBOX_TOPOLOGY_SCHEMA
  sandboxWorker: typeof PRODUCTION_SANDBOX_WORKER
  durableObjectBinding: Readonly<{ name: 'Sandbox'; className: 'Sandbox' }>
  container: Readonly<{
    applicationName: typeof PRODUCTION_SANDBOX_CONTAINER_APPLICATION
    className: 'Sandbox'
    instanceType: 'lite'
    maxInstances: 1
  }>
}>

export function validateProductionTopology(coreValue: unknown, edgeValue: unknown): ProductionTopologyProof {
  const core = object(coreValue, 'core_config_invalid')
  const edge = object(edgeValue, 'edge_config_invalid')
  const coreProduction = productionLane(core)
  const edgeProduction = productionLane(edge)

  exact(coreProduction.name === PRODUCTION_CORE_WORKER, 'core_worker_name_invalid')
  exact(edgeProduction.name === PRODUCTION_EDGE_WORKER, 'edge_worker_name_invalid')
  validatePrivateLane(coreProduction, 'core')
  validatePrivateLane(edgeProduction, 'edge')
  exact(asArray(coreProduction.routes).length === 0, 'core_route_must_be_private')

  const edgeRoutes = asArray(edgeProduction.routes)
  exact(edgeRoutes.length === 1, 'edge_route_count_invalid')
  const route = object(edgeRoutes[0], 'edge_route_invalid')
  exactKeys(route, ['pattern', 'zone_name'], 'edge_route_shape_invalid')
  exact(route.pattern === PRODUCTION_ROUTE_PATTERN, 'edge_route_pattern_invalid')
  exact(route.zone_name === PRODUCTION_ZONE_NAME, 'edge_route_zone_invalid')

  const durable = object(coreProduction.durable_objects, 'core_durable_objects_invalid')
  const durableBindings = asArray(durable.bindings).map((entry) => {
    const binding = object(entry, 'core_durable_object_binding_invalid')
    exactKeys(binding, ['class_name', 'name'], 'core_durable_object_binding_shape_invalid')
    return Object.freeze({ name: text(binding.name), className: text(binding.class_name) })
  }).sort(compareNamed)
  exact(canonicalJson(durableBindings) === canonicalJson(PRODUCTION_DURABLE_OBJECT_BINDINGS),
    'core_durable_object_bindings_invalid')

  exactServices(coreProduction, CORE_SERVICES, 'core_services_invalid')
  exactServices(edgeProduction, EDGE_SERVICES, 'edge_services_invalid')
  const coreSecrets = object(coreProduction.secrets, 'core_secrets_invalid')
  exactStringSet(asArray(coreSecrets.required).map(text), PRODUCTION_CORE_SECRETS, 'core_secrets_invalid')
  const edgeSecrets = object(edgeProduction.secrets, 'edge_secrets_invalid')
  exactStringSet(asArray(edgeSecrets.required).map(text), PRODUCTION_EDGE_SECRETS, 'edge_secrets_invalid')
  for (const config of [core, coreProduction, edge, edgeProduction]) validateNoUnmanagedStorage(config)

  const coreVars = object(coreProduction.vars, 'core_vars_invalid')
  const edgeVars = object(edgeProduction.vars, 'edge_vars_invalid')
  const corePin = text(coreVars.RELEASE_CANDIDATE_SHA)
  const edgePin = text(edgeVars.RELEASE_CANDIDATE_SHA)
  exact(!SHA1_PATTERN.test(corePin) && !SHA1_PATTERN.test(edgePin) && corePin !== edgePin,
    'production_candidate_sentinels_invalid')
  exact(edgeVars.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON === HUMAN_PRESENCE_ANCHOR_PLACEHOLDER,
    'production_human_presence_anchor_placeholder_invalid')

  return Object.freeze({
    schema: PRODUCTION_TOPOLOGY_SCHEMA,
    coreWorker: PRODUCTION_CORE_WORKER,
    edgeWorker: PRODUCTION_EDGE_WORKER,
    route: Object.freeze({ pattern: PRODUCTION_ROUTE_PATTERN, zoneName: PRODUCTION_ZONE_NAME }),
    durableObjectBindings: PRODUCTION_DURABLE_OBJECT_BINDINGS,
    coreRequiredSecrets: PRODUCTION_CORE_SECRETS,
    edgeRequiredSecrets: PRODUCTION_EDGE_SECRETS,
  })
}

export function validateProductionSandboxTopology(value: unknown): ProductionSandboxTopologyProof {
  const config = object(value, 'sandbox_config_invalid')
  const production = productionLane(config)
  exact(production.name === PRODUCTION_SANDBOX_WORKER, 'sandbox_worker_name_invalid')
  validatePrivateLane(production, 'sandbox')
  exact(asArray(production.routes).length === 0, 'sandbox_route_must_be_private')
  exact(asArray(production.services).length === 0, 'sandbox_service_binding_forbidden')
  exact(production.secrets === undefined, 'sandbox_secret_binding_forbidden')
  validateNoUnmanagedStorage(config)
  validateNoUnmanagedStorage(production)
  const namespaces = asArray(object(production.durable_objects, 'sandbox_durable_objects_invalid').bindings)
  exact(namespaces.length === 1, 'sandbox_durable_object_binding_invalid')
  const namespace = object(namespaces[0], 'sandbox_durable_object_binding_invalid')
  exactKeys(namespace, ['class_name', 'name'], 'sandbox_durable_object_binding_shape_invalid')
  exact(namespace.name === 'Sandbox' && namespace.class_name === 'Sandbox',
    'sandbox_durable_object_binding_invalid')
  const containers = asArray(production.containers)
  exact(containers.length === 1, 'sandbox_container_invalid')
  const container = object(containers[0], 'sandbox_container_invalid')
  exactKeys(container, ['class_name', 'image', 'instance_type', 'max_instances', 'name'],
    'sandbox_container_shape_invalid')
  exact(container.name === PRODUCTION_SANDBOX_CONTAINER_APPLICATION
    && container.class_name === 'Sandbox' && container.image === './config/sandbox.Dockerfile'
    && container.max_instances === 1 && container.instance_type === 'lite', 'sandbox_container_invalid')
  return Object.freeze({
    schema: PRODUCTION_SANDBOX_TOPOLOGY_SCHEMA,
    sandboxWorker: PRODUCTION_SANDBOX_WORKER,
    durableObjectBinding: Object.freeze({ name: 'Sandbox', className: 'Sandbox' }),
    container: Object.freeze({
      applicationName: PRODUCTION_SANDBOX_CONTAINER_APPLICATION,
      className: 'Sandbox',
      instanceType: 'lite',
      maxInstances: 1,
    }),
  })
}

export function validateWorkerVersion(
  configValue: unknown,
  versionValue: unknown,
  expected: Readonly<{
    kind: 'core' | 'edge' | 'sandbox'
    candidateSha: string
    candidateDigest: string
    versionId: string
    expectedBindingDigest?: string
    humanPresenceTrustAnchorBinding?: string
    acosSourceRevision?: string
    acosCandidateDigest?: string
    variableOverrides?: Readonly<Record<string, string>>
  }>,
): WorkerDeploymentProof {
  exact(SHA1_PATTERN.test(expected.candidateSha), 'candidate_sha_invalid')
  exact(SHA256_PATTERN.test(expected.candidateDigest), 'candidate_digest_invalid')
  exact(VERSION_ID_PATTERN.test(expected.versionId), 'version_id_invalid')
  if (expected.expectedBindingDigest !== undefined) {
    exact(SHA256_PATTERN.test(expected.expectedBindingDigest), 'expected_binding_digest_invalid')
  }
  exact(expected.kind === 'edge' ? typeof expected.humanPresenceTrustAnchorBinding === 'string'
    : expected.humanPresenceTrustAnchorBinding === undefined, 'human_presence_anchor_binding_invalid')
  exact(expected.kind === 'core'
    ? SHA1_PATTERN.test(expected.acosSourceRevision ?? '')
      && SHA256_PATTERN.test(expected.acosCandidateDigest ?? '')
    : expected.acosSourceRevision === undefined && expected.acosCandidateDigest === undefined,
  'acos_deployment_pin_invalid')
  const config = object(configValue, 'worker_config_invalid')
  const production = productionLane(config)
  const expectedWorker = expected.kind === 'core' ? PRODUCTION_CORE_WORKER
    : expected.kind === 'edge' ? PRODUCTION_EDGE_WORKER : PRODUCTION_SANDBOX_WORKER
  exact(production.name === expectedWorker,
    'worker_kind_mismatch')
  const version = object(versionValue, 'worker_version_invalid')
  exact(version.id === expected.versionId, 'worker_version_id_mismatch')
  const annotations = object(version.annotations, 'worker_annotations_invalid')
  exact(annotations['workers/tag'] === expected.candidateSha, 'worker_candidate_tag_mismatch')
  const resources = object(version.resources, 'worker_resources_invalid')
  const remoteScript = object(resources.script, 'worker_remote_script_invalid')
  const remoteRuntime = object(resources.script_runtime, 'worker_remote_runtime_invalid')
  exact(remoteRuntime.compatibility_date === config.compatibility_date,
    'worker_remote_compatibility_date_mismatch')
  exact(canonicalJson(asArray(remoteRuntime.compatibility_flags).map(text).sort())
    === canonicalJson(asArray(config.compatibility_flags).map(text).sort()),
  'worker_remote_compatibility_flags_mismatch')
  const bindings = asArray(resources.bindings).map((entry) => object(entry, 'worker_binding_invalid'))
  const byName = new Map<string, JsonObject>()
  for (const binding of bindings) {
    const name = text(binding.name)
    exact(!byName.has(name), 'worker_binding_duplicate')
    byName.set(name, binding)
  }
  validateConfiguredBindings(production, byName, expected)
  const safeBindings = bindings.map(sanitizeBinding).sort((left, right) => {
    const leftKey = `${text(left.name)}:${text(left.type)}`
    const rightKey = `${text(right.name)}:${text(right.type)}`
    return leftKey.localeCompare(rightKey)
  })
  const bindingDigest = sha256(canonicalJson(safeBindings))
  exact(expected.expectedBindingDigest === undefined || bindingDigest === expected.expectedBindingDigest,
    'worker_binding_digest_mismatch')
  return Object.freeze({
    schema: PRODUCTION_WORKER_DEPLOYMENT_SCHEMA,
    worker: expected.kind,
    candidateSha: expected.candidateSha,
    candidateDigest: expected.candidateDigest,
    versionId: expected.versionId,
    percentage: 100,
    bindingDigest,
    remoteScriptDigest: sha256(canonicalJson(remoteScript)),
    remoteRuntimeDigest: sha256(canonicalJson(remoteRuntime)),
    migrationConfigDigest: sha256(canonicalJson(config.migrations === undefined ? [] : asArray(config.migrations))),
  })
}

export function revalidateWorkerVersionProof(
  versionValue: unknown,
  expected: WorkerDeploymentProof,
): WorkerDeploymentProof {
  const version = object(versionValue, 'worker_version_invalid')
  exact(version.id === expected.versionId, 'worker_version_id_mismatch')
  const annotations = object(version.annotations, 'worker_annotations_invalid')
  exact(annotations['workers/tag'] === expected.candidateSha, 'worker_candidate_tag_mismatch')
  const resources = object(version.resources, 'worker_resources_invalid')
  const remoteScript = object(resources.script, 'worker_remote_script_invalid')
  const remoteRuntime = object(resources.script_runtime, 'worker_remote_runtime_invalid')
  const bindings = asArray(resources.bindings).map((entry) => object(entry, 'worker_binding_invalid'))
  const safeBindings = bindings.map(sanitizeBinding).sort((left, right) => {
    const leftKey = `${text(left.name)}:${text(left.type)}`
    const rightKey = `${text(right.name)}:${text(right.type)}`
    return leftKey.localeCompare(rightKey)
  })
  exact(sha256(canonicalJson(safeBindings)) === expected.bindingDigest,
    'worker_prior_binding_digest_mismatch')
  exact(sha256(canonicalJson(remoteScript)) === expected.remoteScriptDigest,
    'worker_prior_script_digest_mismatch')
  exact(sha256(canonicalJson(remoteRuntime)) === expected.remoteRuntimeDigest,
    'worker_prior_runtime_digest_mismatch')
  return expected
}

function validatePrivateLane(lane: JsonObject, kind: 'core' | 'edge' | 'sandbox'): void {
  exact(lane.workers_dev === false && lane.preview_urls === false, `${kind}_public_preview_enabled`)
  const variables = object(lane.vars, `${kind}_vars_invalid`)
  exact(variables.DEPLOY_LANE === 'Production', `${kind}_lane_invalid`)
  const metadata = object(lane.version_metadata, `${kind}_version_metadata_invalid`)
  exact(metadata.binding === 'CF_VERSION_METADATA', `${kind}_version_metadata_invalid`)
}

function validateNoUnmanagedStorage(config: JsonObject): void {
  for (const key of ['d1_databases', 'kv_namespaces', 'r2_buckets', 'queues']) {
    exact(config[key] === undefined, 'unmanaged_storage_binding_present')
  }
}

function exactServices(
  production: JsonObject,
  expected: readonly Readonly<{ binding: string; service: string }>[],
  code: string,
): void {
  const observed = asArray(production.services).map((entry) => {
    const service = object(entry, 'service_binding_invalid')
    exactKeys(service, ['binding', 'service'], 'service_binding_shape_invalid')
    return Object.freeze({ binding: text(service.binding), service: text(service.service) })
  }).sort((left, right) => left.binding.localeCompare(right.binding))
  exact(canonicalJson(observed) === canonicalJson(expected), code)
}

function validateConfiguredBindings(
  production: JsonObject,
  actual: ReadonlyMap<string, JsonObject>,
  expected: Readonly<{
    kind: 'core' | 'edge' | 'sandbox'
    candidateSha: string
    candidateDigest: string
    humanPresenceTrustAnchorBinding?: string
    acosSourceRevision?: string
    acosCandidateDigest?: string
    variableOverrides?: Readonly<Record<string, string>>
  }>,
): void {
  const expectedNames: string[] = []
  const variables = object(production.vars, 'worker_vars_invalid')
  for (const [name, configured] of Object.entries(variables)) {
    const binding = requiredBinding(actual, name, 'plain_text')
    const expectedText = name === 'RELEASE_CANDIDATE_SHA'
      ? expected.candidateSha
      : name === 'RELEASE_CANDIDATE_DIGEST'
        ? expected.candidateDigest
        : name === 'ACOS_RUNTIME_SOURCE_REVISION'
          ? text(expected.acosSourceRevision)
          : name === 'ACOS_RUNTIME_CANDIDATE_DIGEST'
            ? text(expected.acosCandidateDigest)
            : name === 'HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON'
              ? text(expected.humanPresenceTrustAnchorBinding)
              : name in (expected.variableOverrides ?? {})
                ? text(expected.variableOverrides?.[name])
                : text(configured)
    exact(binding.text === expectedText, 'worker_plain_text_binding_mismatch')
    expectedNames.push(name)
  }
  for (const configured of asArray(production.services)) {
    const service = object(configured, 'configured_service_invalid')
    const name = text(service.binding)
    const binding = requiredBinding(actual, name, 'service')
    exact(binding.service === service.service && binding.environment === service.environment,
      'worker_service_binding_mismatch')
    expectedNames.push(name)
  }
  const durable = production.durable_objects === undefined
    ? []
    : asArray(object(production.durable_objects, 'configured_durable_objects_invalid').bindings)
  for (const configured of durable) {
    const namespace = object(configured, 'configured_durable_object_invalid')
    const name = text(namespace.name)
    const binding = requiredBinding(actual, name, 'durable_object_namespace')
    exact(binding.class_name === namespace.class_name, 'worker_durable_object_binding_mismatch')
    expectedNames.push(name)
  }
  const metadataName = text(object(production.version_metadata, 'configured_version_metadata_invalid').binding)
  requiredBinding(actual, metadataName, 'version_metadata')
  expectedNames.push(metadataName)
  const secrets = expected.kind === 'edge' ? PRODUCTION_EDGE_SECRETS
    : expected.kind === 'core' ? PRODUCTION_CORE_SECRETS : []
  for (const name of secrets) {
    requiredBinding(actual, name, 'secret_text')
    expectedNames.push(name)
  }
  exactStringSet([...actual.keys()], expectedNames, 'worker_binding_inventory_mismatch')
}

function requiredBinding(bindings: ReadonlyMap<string, JsonObject>, name: string, type: string): JsonObject {
  const binding = bindings.get(name)
  exact(binding?.type === type, 'worker_binding_type_mismatch')
  return binding as JsonObject
}

function sanitizeBinding(binding: JsonObject): JsonObject {
  return binding.type === 'secret_text'
    ? Object.freeze({ name: binding.name, type: binding.type })
    : binding
}

function productionLane(config: JsonObject): JsonObject {
  return object(object(config.env, 'worker_environments_invalid').production, 'production_environment_missing')
}

function object(value: unknown, code: string): JsonObject {
  exact(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as JsonObject
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) return []
  exact(Array.isArray(value), 'array_required')
  return value
}

function text(value: unknown): string {
  exact(typeof value === 'string' && value.length > 0, 'nonempty_text_required')
  return value as string
}

function exactStringSet(actual: readonly string[], expected: readonly string[], code: string): void {
  exact(canonicalJson([...actual].sort()) === canonicalJson([...expected].sort()), code)
}

function exactKeys(value: JsonObject, expected: readonly string[], code: string): void {
  exact(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()), code)
}

function compareNamed(left: Readonly<{ name: string }>, right: Readonly<{ name: string }>): number {
  return left.name.localeCompare(right.name)
}

function exact(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_contract:${code}`)
}

function readBoundedJson(filePath: string): unknown {
  const resolved = path.resolve(filePath)
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    exact(before.isFile() && before.size > 0n && before.size <= BigInt(MAXIMUM_JSON_BYTES), 'json_file_size_invalid')
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    exact(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs, 'json_file_changed_during_read')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2)
  let output: unknown
  if (command === 'topology' && arguments_.length === 2) {
    output = validateProductionTopology(readBoundedJson(arguments_[0] as string), readBoundedJson(arguments_[1] as string))
  } else if (command === 'sandbox-topology' && arguments_.length === 1) {
    output = validateProductionSandboxTopology(readBoundedJson(arguments_[0] as string))
  } else if (command === 'version' && arguments_.length >= 5 && arguments_.length <= 7) {
    const [kind, configPath, versionPath, expectedVersionId, candidateSha, expectedDigest, anchorPath] = arguments_
    exact(kind === 'core' || kind === 'edge' || kind === 'sandbox', 'worker_kind_invalid')
    const anchorProof = anchorPath === undefined || anchorPath === '-'
      ? undefined
      : parseHumanPresenceAnchorProof(readBoundedJson(anchorPath))
    output = validateWorkerVersion(readBoundedJson(configPath as string), readBoundedJson(versionPath as string), {
      kind,
      candidateSha: candidateSha as string,
      candidateDigest: process.env.CANDIDATE_DIGEST ?? '',
      versionId: expectedVersionId as string,
      ...(expectedDigest === undefined || expectedDigest === '-' ? {} : { expectedBindingDigest: expectedDigest }),
      ...(anchorProof === undefined ? {} : { humanPresenceTrustAnchorBinding: anchorProof.bindingValue }),
      ...(kind === 'core' ? {
        acosSourceRevision: process.env.ACOS_RUNTIME_SOURCE_REVISION,
        acosCandidateDigest: process.env.ACOS_RUNTIME_CANDIDATE_DIGEST,
      } : {}),
    })
  } else {
    throw new Error('usage: contracts.ts topology <core-config> <edge-config> | sandbox-topology <sandbox-config> | version <sandbox|core|edge> <config> <version-json> <version-id> <candidate-sha> [binding-digest] [anchor-proof]')
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_contract:unknown_error'}\n`)
    process.exitCode = 1
  })
}
