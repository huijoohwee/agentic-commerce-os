import { canonicalJson, sha256Hex } from './digest.ts'

export const ACOS_ADMISSION_AUTH_SCHEMA = 'commerce-agentic-os-admission-auth/v1'
export const ACOS_ADMISSION_AUTH_HEADERS = Object.freeze({
  schema: 'x-agentic-os-admission-auth-schema',
  signature: 'x-agentic-os-admission-auth-signature',
})
export const ACOS_ADMISSION_PERMIT_HEADER_NAMES = Object.freeze([
  'x-authoring-mutation-contract',
  'x-authoring-mutation-id',
  'x-authoring-operation-id',
  'x-authoring-request-digest',
  'x-authoring-mutation-sequence',
  'x-authoring-semantic-scope',
  'x-authoring-claim-id',
  'x-authoring-lease-epoch',
  'x-authoring-lease-expires-at-ms',
  'x-authoring-fence-revision',
  'x-authoring-write-target',
  'x-authoring-reserved-at-ms',
])

const SECRET_PATTERN = /^[\x21-\x7e]{32,256}$/u
const PLACEHOLDER_PATTERN = /(?:replace|placeholder|required|example|changeme|todo)/iu
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u
const MAXIMUM_BODY_BYTES = 65_536

export async function authenticateAcosAdmissionRequest(
  request: Request,
  bodyText: string,
  contract: string,
  secret: string,
): Promise<Request | null> {
  const signature = await sign(request, bodyText, contract, secret)
  if (!signature) return null
  const headers = new Headers(request.headers)
  headers.set(ACOS_ADMISSION_AUTH_HEADERS.schema, ACOS_ADMISSION_AUTH_SCHEMA)
  headers.set(ACOS_ADMISSION_AUTH_HEADERS.signature, signature)
  return new Request(request, { headers })
}

export async function verifyAcosAdmissionRequestAuthentication(
  request: Request,
  contract: string,
  secret: string,
): Promise<boolean> {
  const signature = request.headers.get(ACOS_ADMISSION_AUTH_HEADERS.signature) ?? ''
  if (request.headers.get(ACOS_ADMISSION_AUTH_HEADERS.schema) !== ACOS_ADMISSION_AUTH_SCHEMA
    || !SIGNATURE_PATTERN.test(signature)
    || !validAcosAdmissionAuthSecret(secret)) return false
  try {
    const bodyText = await readBoundedBody(request.clone().body)
    if (bodyText === null) return false
    const key = await hmacKey(secret, ['verify'])
    return crypto.subtle.verify(
      'HMAC', key, hexBytes(signature),
      new TextEncoder().encode(await signaturePayload(request, bodyText, contract)),
    )
  } catch {
    return false
  }
}

async function sign(
  request: Request,
  bodyText: string,
  contract: string,
  secret: string,
): Promise<string | null> {
  if (!validAcosAdmissionAuthSecret(secret) || byteLength(bodyText) > MAXIMUM_BODY_BYTES) return null
  try {
    const key = await hmacKey(secret, ['sign'])
    const signature = await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(await signaturePayload(request, bodyText, contract)),
    )
    return [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

async function signaturePayload(request: Request, bodyText: string, contract: string): Promise<string> {
  return canonicalJson({
    schema: ACOS_ADMISSION_AUTH_SCHEMA,
    contract,
    method: request.method,
    url: request.url,
    bodyDigest: await sha256Hex(bodyText),
    permitHeaders: Object.fromEntries(ACOS_ADMISSION_PERMIT_HEADER_NAMES.map((name) => (
      [name, request.headers.get(name)]
    ))),
  })
}

export function validAcosAdmissionAuthSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET_PATTERN.test(value) && !PLACEHOLDER_PATTERN.test(value)
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAXIMUM_BODY_BYTES) {
        await reader.cancel('ACOS admission authentication body exceeded bound')
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
  return new TextDecoder().decode(joined)
}

function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages,
  )
}

function hexBytes(value: string): ArrayBuffer {
  return Uint8Array.from(
    value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16),
  ).buffer as ArrayBuffer
}
