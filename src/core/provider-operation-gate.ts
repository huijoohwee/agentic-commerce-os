import { canonicalJson, sha256Hex } from '../shared/digest.ts'
import { isRecord, readJsonResponse } from '../shared/http.ts'
import {
  authenticateCommerceProviderRequest,
  authenticateCommerceProviderControlRequest,
  verifyCommerceProviderRequestAuthentication,
} from '../shared/commerce-provider-auth.ts'
import {
  CHECKOUT_PROVIDER_CONTRACT,
  DISCOVERY_PROVIDER_CONTRACT,
  MARKETPLACE_PROVIDER_CONTRACT,
} from './provider-contract.ts'
import {
  CHECKOUT_EVIDENCE_CHECKS,
  DISCOVERY_EVIDENCE_CHECKS,
  MARKETPLACE_EVIDENCE_CHECKS,
  readUpstreamEvidencePin,
  verifyUpstreamRuntimeEvidence,
  type UpstreamEvidencePin,
} from './upstream-evidence.ts'
import { AUTHORING_MUTATION_HEADER_NAMES } from './authoring-mutation-headers.ts'

const EVIDENCE_TIMEOUT_MS = 5_000
const MAXIMUM_EVIDENCE_BYTES = 65_536
const MAXIMUM_OPERATION_BODY_BYTES = 65_536
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

const HEADERS = Object.freeze({
  sourceRevision: 'x-commerce-evidence-source-revision',
  receiptDigest: 'x-commerce-evidence-receipt-digest',
  storageCompatibilityRevision: 'x-commerce-evidence-storage-revision',
  providerVersionId: 'x-commerce-evidence-provider-version',
  requiredCheckSetDigest: 'x-commerce-evidence-required-check-set-digest',
  requestDigest: 'x-commerce-provider-request-digest',
  bindingDigest: 'x-commerce-provider-binding-digest',
})

export type OperationalEvidencePermit = Readonly<{
  pin: UpstreamEvidencePin
  requiredCheckSetDigest: string
}>

export type OperationalEvidenceBinding = OperationalEvidencePermit & Readonly<{
  requestDigest: string
  bindingDigest: string
}>

export type BoundOperationalEvidenceRequest = Readonly<{
  request: Request
  binding: OperationalEvidenceBinding
}>

export type OperationalEvidenceResult =
  | Readonly<{ ok: true; permit: OperationalEvidencePermit }>
  | Readonly<{ ok: false; code: 'provider_evidence_unavailable' | 'provider_evidence_mismatch' }>

export type OperationalRequestResult =
  | Readonly<{ ok: true; request: Request; binding: OperationalEvidenceBinding }>
  | Readonly<{
      ok: false
      code: 'provider_evidence_unavailable' | 'provider_evidence_mismatch'
        | 'provider_request_unbindable' | 'provider_authentication_unavailable'
    }>

export function checkoutOperationalEvidence(env: CoreEnv): Promise<OperationalEvidenceResult> {
  return verifyOperationalEvidence(
    env.CHECKOUT_PROVIDER,
    'checkout-provider.internal',
    CHECKOUT_PROVIDER_CONTRACT,
    env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON,
    CHECKOUT_EVIDENCE_CHECKS,
    env.CHECKOUT_PROVIDER_AUTH_SECRET,
  )
}

export function discoveryOperationalEvidence(env: CoreEnv): Promise<OperationalEvidenceResult> {
  return verifyOperationalEvidence(
    env.DOCS_MCP,
    'discovery-provider.internal',
    DISCOVERY_PROVIDER_CONTRACT,
    env.DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON,
    DISCOVERY_EVIDENCE_CHECKS,
  )
}

export function prepareCheckoutProviderOperation(env: CoreEnv, request: Request): Promise<OperationalRequestResult> {
  return prepareProviderOperation(
    env.CHECKOUT_PROVIDER,
    'checkout-provider.internal',
    CHECKOUT_PROVIDER_CONTRACT,
    env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON,
    CHECKOUT_EVIDENCE_CHECKS,
    env.CHECKOUT_PROVIDER_AUTH_SECRET,
    request,
  )
}

export function prepareMarketplaceProviderOperation(env: CoreEnv, request: Request): Promise<OperationalRequestResult> {
  return prepareProviderOperation(
    env.MARKETPLACE_PROVIDER,
    'marketplace-provider.internal',
    MARKETPLACE_PROVIDER_CONTRACT,
    env.MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON,
    MARKETPLACE_EVIDENCE_CHECKS,
    env.MARKETPLACE_PROVIDER_AUTH_SECRET,
    request,
  )
}

export async function verifyOperationalEvidence(
  provider: Fetcher,
  hostname: string,
  expectedContract: string,
  pinJson: string,
  requiredChecks: readonly string[],
  authenticationSecret?: string,
): Promise<OperationalEvidenceResult> {
  const pin = readUpstreamEvidencePin(pinJson)
  const normalizedChecks = normalizeRequiredChecks(requiredChecks)
  if (!pin || !normalizedChecks) return Object.freeze({ ok: false, code: 'provider_evidence_mismatch' })
  try {
    const unsigned = new Request(`https://${hostname}/v1/runtime-evidence`, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-commerce-contract': expectedContract },
      signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS),
    })
    const evidenceRequest = authenticationSecret === undefined
      ? unsigned
      : await authenticateCommerceProviderControlRequest(unsigned, expectedContract, authenticationSecret)
    if (!evidenceRequest) return Object.freeze({ ok: false, code: 'provider_evidence_unavailable' })
    const response = await provider.fetch(evidenceRequest)
    const payload = await readJsonResponse(response, MAXIMUM_EVIDENCE_BYTES)
    const verification = await verifyUpstreamRuntimeEvidence(payload, expectedContract, pin, normalizedChecks)
    if (!response.ok || !isRecord(verification) || verification.ok !== true) {
      return Object.freeze({ ok: false, code: 'provider_evidence_mismatch' })
    }
    return Object.freeze({
      ok: true,
      permit: Object.freeze({
        pin,
        requiredCheckSetDigest: await sha256Hex(canonicalJson(normalizedChecks)),
      }),
    })
  } catch {
    return Object.freeze({ ok: false, code: 'provider_evidence_unavailable' })
  }
}

export async function bindOperationalProviderRequest(
  permit: OperationalEvidencePermit,
  request: Request,
): Promise<OperationalRequestResult> {
  const bounded = await readBoundedOperationRequest(request)
  if (!bounded) return Object.freeze({ ok: false, code: 'provider_request_unbindable' })
  const requestDigest = await digestProviderRequest(bounded)
  const bindingDigest = await digestBinding(permit.pin, permit.requiredCheckSetDigest, requestDigest)
  const binding = Object.freeze({ ...permit, requestDigest, bindingDigest })
  const headers = new Headers(bounded.headers)
  for (const [name, value] of bindingHeaderEntries(binding)) headers.set(name, value)
  return Object.freeze({ ok: true, request: replayBoundedOperationRequest(bounded, headers), binding })
}

export async function bindAuthenticatedProviderRequest(
  permit: OperationalEvidencePermit,
  request: Request,
  expectedContract: string,
  secret: string,
): Promise<OperationalRequestResult> {
  const operation = await bindOperationalProviderRequest(permit, request)
  if (!operation.ok) return operation
  const authenticated = await authenticateCommerceProviderRequest(
    operation.request,
    {
      contract: expectedContract,
      requestDigest: operation.binding.requestDigest,
      bindingDigest: operation.binding.bindingDigest,
    },
    secret,
  )
  return authenticated
    ? Object.freeze({ ...operation, request: authenticated })
    : Object.freeze({ ok: false, code: 'provider_authentication_unavailable' })
}

export async function readOperationalEvidenceBinding(
  request: Request,
  expectedPin: UpstreamEvidencePin,
  requiredChecks: readonly string[],
): Promise<BoundOperationalEvidenceRequest | null> {
  const normalizedChecks = normalizeRequiredChecks(requiredChecks)
  if (!normalizedChecks) return null
  const requiredCheckSetDigest = await sha256Hex(canonicalJson(normalizedChecks))
  const bounded = await readBoundedOperationRequest(request)
  if (!bounded) return null
  const requestDigest = await digestProviderRequest(bounded)
  const bindingDigest = await digestBinding(expectedPin, requiredCheckSetDigest, requestDigest)
  const binding = Object.freeze({ pin: expectedPin, requiredCheckSetDigest, requestDigest, bindingDigest })
  return bindingHeaderEntries(binding).every(([name, value]) => bounded.headers.get(name) === value)
    ? Object.freeze({ request: replayBoundedOperationRequest(bounded), binding })
    : null
}

export async function readAuthenticatedOperationalEvidenceBinding(
  request: Request,
  expectedContract: string,
  expectedPin: UpstreamEvidencePin,
  requiredChecks: readonly string[],
  secret: string,
): Promise<BoundOperationalEvidenceRequest | null> {
  const operation = await readOperationalEvidenceBinding(request, expectedPin, requiredChecks)
  if (!operation) return null
  const authenticated = await verifyCommerceProviderRequestAuthentication(
    operation.request,
    {
      contract: expectedContract,
      requestDigest: operation.binding.requestDigest,
      bindingDigest: operation.binding.bindingDigest,
    },
    secret,
  )
  return authenticated ? operation : null
}

export function operationalEvidenceResponseHeaders(binding: OperationalEvidenceBinding): HeadersInit {
  return Object.fromEntries(bindingHeaderEntries(binding))
}

export function responseMatchesOperationalEvidence(
  response: Response,
  binding: OperationalEvidenceBinding,
): boolean {
  return bindingHeaderEntries(binding).every(([name, value]) => response.headers.get(name) === value)
}

async function prepareProviderOperation(
  provider: Fetcher,
  hostname: string,
  expectedContract: string,
  pinJson: string,
  requiredChecks: readonly string[],
  secret: string,
  request: Request,
): Promise<OperationalRequestResult> {
  const evidence = await verifyOperationalEvidence(
    provider, hostname, expectedContract, pinJson, requiredChecks, secret,
  )
  if (!evidence.ok) return evidence
  return bindAuthenticatedProviderRequest(evidence.permit, request, expectedContract, secret)
}

type BoundedOperationRequest = Readonly<{
  url: string
  method: string
  headers: Headers
  signal: AbortSignal
  redirect: RequestRedirect
  hadBody: boolean
  bodyBytes: Uint8Array
  bodyText: string
}>

async function readBoundedOperationRequest(request: Request): Promise<BoundedOperationRequest | null> {
  try {
    const declaredLength = request.headers.get('content-length')
    if (declaredLength !== null
      && (!/^\d+$/u.test(declaredLength)
        || !Number.isSafeInteger(Number(declaredLength))
        || Number(declaredLength) > MAXIMUM_OPERATION_BODY_BYTES)) {
      await request.body?.cancel('provider request body exceeded bound')
      return null
    }
    const bodyBytes = await readBoundedOperationBody(request.body)
    if (!bodyBytes) return null
    return Object.freeze({
      url: request.url,
      method: request.method,
      headers: new Headers(request.headers),
      signal: request.signal,
      redirect: request.redirect,
      hadBody: request.body !== null,
      bodyBytes,
      bodyText: new TextDecoder().decode(bodyBytes),
    })
  } catch {
    return null
  }
}

async function readBoundedOperationBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAXIMUM_OPERATION_BODY_BYTES) {
        await reader.cancel('provider request body exceeded bound')
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function replayBoundedOperationRequest(
  bounded: BoundedOperationRequest,
  headers: Headers = bounded.headers,
): Request {
  return new Request(bounded.url, {
    method: bounded.method,
    headers,
    redirect: bounded.redirect,
    signal: bounded.signal,
    ...(bounded.hadBody ? { body: bounded.bodyBytes.buffer as ArrayBuffer } : {}),
  })
}

async function digestProviderRequest(request: BoundedOperationRequest): Promise<string> {
  return sha256Hex(canonicalJson({
      method: request.method.toUpperCase(),
      url: request.url,
      semanticHeaders: Object.fromEntries([
        'accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id',
        'x-commerce-contract', 'x-operator-id',
        ...AUTHORING_MUTATION_HEADER_NAMES,
      ].map((name) => [name, request.headers.get(name)])),
      bodyDigest: await sha256Hex(request.bodyText),
    }))
}

function normalizeRequiredChecks(value: readonly string[]): readonly string[] | null {
  if (value.length === 0 || value.length > 128) return null
  const normalized = [...new Set(value)].sort(compareText)
  return normalized.length === value.length
    && normalized.every((name) => /^[a-z][a-z0-9_]{0,127}$/u.test(name))
    ? Object.freeze(normalized)
    : null
}

function bindingHeaderEntries(binding: OperationalEvidenceBinding): readonly (readonly [string, string])[] {
  return Object.freeze([
    [HEADERS.sourceRevision, binding.pin.sourceRevision] as const,
    [HEADERS.receiptDigest, binding.pin.receiptDigest] as const,
    [HEADERS.storageCompatibilityRevision, binding.pin.storageCompatibilityRevision] as const,
    [HEADERS.providerVersionId, binding.pin.providerVersionId] as const,
    [HEADERS.requiredCheckSetDigest, binding.requiredCheckSetDigest] as const,
    [HEADERS.requestDigest, binding.requestDigest] as const,
    [HEADERS.bindingDigest, binding.bindingDigest] as const,
  ])
}

function digestBinding(pin: UpstreamEvidencePin, requiredCheckSetDigest: string, requestDigest: string): Promise<string> {
  if (!SHA256_PATTERN.test(requiredCheckSetDigest) || !SHA256_PATTERN.test(requestDigest)) {
    throw new Error('operational_evidence_digest_invalid')
  }
  return sha256Hex(canonicalJson({ ...pin, requiredCheckSetDigest, requestDigest }))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
