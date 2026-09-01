import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PRODUCTION_ROUTE_PATTERN,
  validateProductionTopology,
  validateWorkerVersion,
} from '../../scripts/production-release/contracts.ts'
import { buildHumanPresenceAnchorProof } from '../../scripts/production-release/human-presence-anchor.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CANDIDATE = 'a'.repeat(40)
const ANCHOR_PROOF = buildHumanPresenceAnchorProof(JSON.stringify({
  schema: 'agentic-graph-human-presence-trust-anchor/v1',
  issuer: 'test-human-presence',
  publicKeySpkiBase64: Buffer.from(generateKeyPairSync('ed25519').publicKey
    .export({ format: 'der', type: 'spki' })).toString('base64'),
}))

function config(name: 'core' | 'edge'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(`${ROOT}/wrangler.${name}.jsonc`, 'utf8')) as Record<string, unknown>
}

test('Production topology fixes one exact route, six Durable Objects, and three edge secrets', () => {
  const proof = validateProductionTopology(config('core'), config('edge'))
  assert.equal(proof.route.pattern, PRODUCTION_ROUTE_PATTERN)
  assert.equal(proof.durableObjectBindings.length, 6)
  assert.deepEqual(proof.edgeRequiredSecrets, [
    'MCP_BEARER_TOKEN',
    'OPERATOR_BEARER_TOKEN',
    'STOREFRONT_SESSION_SECRET',
  ])
  assert.throws(() => buildHumanPresenceAnchorProof('external-trust-anchor-required'), /binding_json_invalid/u)
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
})

test('Worker version validation binds all configured values and sanitizes all three secrets', () => {
  const edge = config('edge') as any
  const production = edge.env.production
  const bindings = [
    ...Object.entries(production.vars).map(([name, text]) => ({
      name,
      type: 'plain_text',
      text: name === 'RELEASE_CANDIDATE_SHA' ? CANDIDATE
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
    kind: 'edge', candidateSha: CANDIDATE, versionId: 'edge-version-1',
    humanPresenceTrustAnchorBinding: ANCHOR_PROOF.bindingValue,
  })
  assert.match(proof.bindingDigest, /^[0-9a-f]{64}$/u)
  assert.doesNotMatch(JSON.stringify(proof), /never-record/u)

  const withoutStorefrontSecret = structuredClone(version)
  withoutStorefrontSecret.resources.bindings = withoutStorefrontSecret.resources.bindings
    .filter(({ name }) => name !== 'STOREFRONT_SESSION_SECRET')
  assert.throws(() => validateWorkerVersion(edge, withoutStorefrontSecret, {
    kind: 'edge', candidateSha: CANDIDATE, versionId: 'edge-version-1',
    humanPresenceTrustAnchorBinding: ANCHOR_PROOF.bindingValue,
  }), /worker_binding_type_mismatch/u)
})
