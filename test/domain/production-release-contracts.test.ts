import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PRODUCTION_ROUTE_PATTERN,
  validateProductionSandboxTopology,
  validateProductionTopology,
  validateWorkerVersion,
} from '../../scripts/production-release/contracts.ts'
import { buildHumanPresenceAnchorProof } from '../../scripts/production-release/human-presence-anchor.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CANDIDATE = 'a'.repeat(40)
const CANDIDATE_DIGEST = 'b'.repeat(64)
const ACOS_SOURCE_REVISION = 'c'.repeat(40)
const ACOS_CANDIDATE_DIGEST = 'd'.repeat(64)
const ANCHOR_PROOF = buildHumanPresenceAnchorProof(JSON.stringify({
  schema: 'agentic-graph-human-presence-trust-anchor/v1',
  issuer: 'test-human-presence',
  publicKeySpkiBase64: Buffer.from(generateKeyPairSync('ed25519').publicKey
    .export({ format: 'der', type: 'spki' })).toString('base64'),
}))

function config(name: 'core' | 'edge' | 'sandbox'): Record<string, unknown> {
  const source = fs.readFileSync(`${ROOT}/wrangler.${name}.jsonc`, 'utf8')
    .replace(/^\s*\/\/.*$/gmu, '')
  return JSON.parse(source) as Record<string, unknown>
}

test('Production topology fixes one exact route, six Durable Objects, and the exact core and edge secrets', () => {
  const proof = validateProductionTopology(config('core'), config('edge'))
  assert.equal(proof.route.pattern, PRODUCTION_ROUTE_PATTERN)
  assert.equal(proof.durableObjectBindings.length, 6)
  assert.deepEqual(proof.coreRequiredSecrets, [
    'DISCOVERY_PROVIDER_BEARER_TOKEN',
    'AGENTIC_OS_ADMISSION_AUTH_SECRET',
    'CHECKOUT_PROVIDER_AUTH_SECRET',
    'MARKETPLACE_PROVIDER_AUTH_SECRET',
  ])
  assert.deepEqual(proof.edgeRequiredSecrets, [
    'MCP_BEARER_TOKEN',
    'OPERATOR_BEARER_TOKEN',
    'STOREFRONT_SESSION_SECRET',
  ])
  assert.throws(() => buildHumanPresenceAnchorProof('external-trust-anchor-required'), /binding_json_invalid/u)
})

test('Core service bindings use the exact Graph-declared staging and production Worker identities', () => {
  const core = config('core') as any
  assert.deepEqual(core.env.staging.services, [
    { binding: 'ACOS_ADMISSION', service: 'agentic-canvas-os-staging' },
    { binding: 'COMMERCE_SANDBOX', service: 'agentic-commerce-sandbox-staging' },
    { binding: 'DOCS_MCP', service: 'agentic-mcp-staging' },
    { binding: 'CHECKOUT_PROVIDER', service: 'agentic-travel-commerce-staging' },
    { binding: 'MARKETPLACE_PROVIDER', service: 'agentic-marketplace-staging' },
  ])
  assert.deepEqual(core.env.production.services, [
    { binding: 'ACOS_ADMISSION', service: 'agentic-canvas-os' },
    { binding: 'COMMERCE_SANDBOX', service: 'agentic-commerce-sandbox-production' },
    { binding: 'DOCS_MCP', service: 'agentic-mcp' },
    { binding: 'CHECKOUT_PROVIDER', service: 'agentic-travel-commerce-production' },
    { binding: 'MARKETPLACE_PROVIDER', service: 'agentic-marketplace-production' },
  ])

  const staleLegacyIdentity = config('core') as any
  staleLegacyIdentity.env.production.services[2].service = 'agenticgraph-mcp'
  assert.throws(
    () => validateProductionTopology(staleLegacyIdentity, config('edge')),
    /core_services_invalid/u,
  )
})

test('Production sandbox is a private exact service with one bounded container-backed Durable Object', () => {
  const proof = validateProductionSandboxTopology(config('sandbox'))
  assert.equal(proof.sandboxWorker, 'agentic-commerce-sandbox-production')
  assert.deepEqual(proof.durableObjectBinding, { name: 'Sandbox', className: 'Sandbox' })
  assert.deepEqual(proof.container, {
    applicationName: 'agentic-commerce-sandbox-production-sandbox',
    className: 'Sandbox',
    instanceType: 'lite',
    maxInstances: 1,
  })

  const publicSandbox = config('sandbox') as any
  publicSandbox.env.production.workers_dev = true
  assert.throws(() => validateProductionSandboxTopology(publicSandbox), /sandbox_public_preview_enabled/u)
})

test('Production topology rejects route broadening, missing Durable Objects, and missing secrets', () => {
  const routeBroadened = config('edge') as any
  routeBroadened.env.production.routes[0].pattern = 'airvio.co/*'
  assert.throws(() => validateProductionTopology(config('core'), routeBroadened), /edge_route_pattern_invalid/u)

  const missingDurable = config('core') as any
  missingDurable.env.production.durable_objects.bindings.pop()
  assert.throws(() => validateProductionTopology(missingDurable, config('edge')), /core_durable_object_bindings_invalid/u)

  const missingSecret = config('edge') as any
  missingSecret.env.production.secrets.required.pop()
  assert.throws(() => validateProductionTopology(config('core'), missingSecret), /edge_secrets_invalid/u)

  const missingCoreSecret = config('core') as any
  missingCoreSecret.env.production.secrets.required.pop()
  assert.throws(() => validateProductionTopology(missingCoreSecret, config('edge')), /core_secrets_invalid/u)
})

test('Worker version validation binds all configured values and sanitizes every configured secret', () => {
  const edge = config('edge') as any
  const production = edge.env.production
  const bindings = [
    ...Object.entries(production.vars).map(([name, text]) => ({
      name,
      type: 'plain_text',
      text: name === 'RELEASE_CANDIDATE_SHA' ? CANDIDATE
        : name === 'RELEASE_CANDIDATE_DIGEST' ? CANDIDATE_DIGEST
        : name === 'HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON' ? ANCHOR_PROOF.bindingValue : text,
    })),
    ...production.services.map((service: Record<string, unknown>) => ({ type: 'service', ...service, name: service.binding })),
    { name: production.version_metadata.binding, type: 'version_metadata' },
    ...production.secrets.required.map((name: string) => ({ name, type: 'secret_text', text: `never-record-${name}` })),
  ]
  const version = {
    id: 'edge-version-1',
    annotations: { 'workers/tag': CANDIDATE },
    resources: {
      bindings,
      script: { handlers: ['fetch'] },
      script_runtime: {
        compatibility_date: edge.compatibility_date,
        compatibility_flags: edge.compatibility_flags,
      },
    },
  }
  const proof = validateWorkerVersion(edge, version, {
    kind: 'edge', candidateSha: CANDIDATE, candidateDigest: CANDIDATE_DIGEST, versionId: 'edge-version-1',
    humanPresenceTrustAnchorBinding: ANCHOR_PROOF.bindingValue,
  })
  assert.match(proof.bindingDigest, /^[0-9a-f]{64}$/u)
  assert.doesNotMatch(JSON.stringify(proof), /never-record/u)

  const withoutStorefrontSecret = structuredClone(version)
  withoutStorefrontSecret.resources.bindings = withoutStorefrontSecret.resources.bindings
    .filter(({ name }) => name !== 'STOREFRONT_SESSION_SECRET')
  assert.throws(() => validateWorkerVersion(edge, withoutStorefrontSecret, {
    kind: 'edge', candidateSha: CANDIDATE, candidateDigest: CANDIDATE_DIGEST, versionId: 'edge-version-1',
    humanPresenceTrustAnchorBinding: ANCHOR_PROOF.bindingValue,
  }), /worker_binding_type_mismatch/u)
})

test('Core Worker version requires the authenticated discovery-provider secret without recording it', () => {
  const core = config('core') as any
  const production = core.env.production
  const bindings = [
    ...Object.entries(production.vars).map(([name, text]) => ({
      name,
      type: 'plain_text',
      text: name === 'RELEASE_CANDIDATE_SHA' ? CANDIDATE
        : name === 'RELEASE_CANDIDATE_DIGEST' ? CANDIDATE_DIGEST
          : name === 'ACOS_RUNTIME_SOURCE_REVISION' ? ACOS_SOURCE_REVISION
            : name === 'ACOS_RUNTIME_CANDIDATE_DIGEST' ? ACOS_CANDIDATE_DIGEST : text,
    })),
    ...production.services.map((service: Record<string, unknown>) => ({
      type: 'service', ...service, name: service.binding,
    })),
    ...production.durable_objects.bindings.map((binding: Record<string, unknown>) => ({
      type: 'durable_object_namespace', ...binding,
    })),
    { name: production.version_metadata.binding, type: 'version_metadata' },
    ...production.secrets.required.map((name: string) => ({
      name,
      type: 'secret_text',
      text: `never-record-${name}`,
    })),
  ]
  const version = {
    id: 'core-version-1',
    annotations: { 'workers/tag': CANDIDATE },
    resources: {
      bindings,
      script: { handlers: ['fetch'] },
      script_runtime: {
        compatibility_date: core.compatibility_date,
        compatibility_flags: core.compatibility_flags,
      },
    },
  }
  const proof = validateWorkerVersion(core, version, {
    kind: 'core', candidateSha: CANDIDATE, candidateDigest: CANDIDATE_DIGEST, versionId: 'core-version-1',
    acosSourceRevision: ACOS_SOURCE_REVISION, acosCandidateDigest: ACOS_CANDIDATE_DIGEST,
  })
  assert.match(proof.bindingDigest, /^[0-9a-f]{64}$/u)
  assert.doesNotMatch(JSON.stringify(proof), /never-record/u)

  for (const missingSecret of [
    'DISCOVERY_PROVIDER_BEARER_TOKEN',
    'AGENTIC_OS_ADMISSION_AUTH_SECRET',
    'CHECKOUT_PROVIDER_AUTH_SECRET',
    'MARKETPLACE_PROVIDER_AUTH_SECRET',
  ]) {
    const withoutRequiredSecret = structuredClone(version)
    withoutRequiredSecret.resources.bindings = withoutRequiredSecret.resources.bindings
      .filter(({ name }) => name !== missingSecret)
    assert.throws(() => validateWorkerVersion(core, withoutRequiredSecret, {
      kind: 'core', candidateSha: CANDIDATE, candidateDigest: CANDIDATE_DIGEST, versionId: 'core-version-1',
      acosSourceRevision: ACOS_SOURCE_REVISION, acosCandidateDigest: ACOS_CANDIDATE_DIGEST,
    }), /worker_binding_type_mismatch/u)
  }
})
