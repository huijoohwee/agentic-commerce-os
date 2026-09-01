export const SANDBOX_SOURCE_PACKAGE_SCHEMA = 'agentic-commerce-sandbox-source-package/v1'
export const SANDBOX_PROOF_REQUEST_SCHEMA = 'agentic-commerce-sandbox-proof-request/v1'
export const SANDBOX_UNSIGNED_PROOF_SCHEMA = 'agentic-commerce-sandbox-unsigned-proof/v1'

export const SANDBOX_PROOF_PACKAGE_VERSION = '0.12.9'
export const SANDBOX_PROOF_IMAGE = `docker.io/cloudflare/sandbox:${SANDBOX_PROOF_PACKAGE_VERSION}`
export const SANDBOX_PROOF_COMMANDS = Object.freeze([
  Object.freeze({ taskId: '12.4' as const, command: 'npm run check:webmcp' }),
  Object.freeze({ taskId: '12.7' as const, command: 'npm run check:browser' }),
])
export const SANDBOX_PROOF_BOUNDS = Object.freeze({
  wallClockSeconds: 300,
  memoryMegabytes: 256,
  terminationGraceSeconds: 5,
})

export const MAXIMUM_SANDBOX_SOURCE_BYTES = 4 * 1024 * 1024
export const MAXIMUM_SANDBOX_PACKAGE_BYTES = 8 * 1024 * 1024
export const MAXIMUM_SANDBOX_ENTRY_BYTES = 2 * 1024 * 1024
export const MAXIMUM_SANDBOX_ENTRIES = 4_096

export type SandboxSourceFingerprint = Readonly<{
  schema: 'agentic-commerce-authored-source-fingerprint/v1'
  implementationBaseline: string
  headRevision: string
  authoredFileCount: number
  authoredTreeSha256: string
  fingerprintDigest: string
}>

export type SandboxSourceEntry = Readonly<{
  path: string
  kind: 'file' | 'missing'
  mode: '100644' | '100755' | 'missing'
  size: number
  sha256: string
  contentBase64: string
}>

export type SandboxSourcePackage = Readonly<{
  schema: typeof SANDBOX_SOURCE_PACKAGE_SCHEMA
  sourceFingerprint: SandboxSourceFingerprint
  entries: readonly SandboxSourceEntry[]
  totalFileBytes: number
  packageDigest: string
}>

export type SandboxProofRequest = Readonly<{
  schema: typeof SANDBOX_PROOF_REQUEST_SCHEMA
  nonce: string
  issuer: string
  issuerKeyId: string
  validityMs: number
  sourcePackage: SandboxSourcePackage
}>

export async function parseSandboxProofRequest(value: unknown): Promise<SandboxProofRequest | null> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schema', 'nonce', 'issuer', 'issuerKeyId', 'validityMs', 'sourcePackage',
  ]) || value.schema !== SANDBOX_PROOF_REQUEST_SCHEMA || !digest(value.nonce)
    || !namedIdentity(value.issuer) || !namedIdentity(value.issuerKeyId)
    || !safeInteger(value.validityMs, 1, 86_400_000)) return null
  const sourcePackage = await parseSandboxSourcePackage(value.sourcePackage)
  if (!sourcePackage) return null
  return Object.freeze({
    schema: SANDBOX_PROOF_REQUEST_SCHEMA,
    nonce: String(value.nonce),
    issuer: String(value.issuer),
    issuerKeyId: String(value.issuerKeyId),
    validityMs: Number(value.validityMs),
    sourcePackage,
  })
}

export async function parseSandboxSourcePackage(value: unknown): Promise<SandboxSourcePackage | null> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schema', 'sourceFingerprint', 'entries', 'totalFileBytes', 'packageDigest',
  ]) || value.schema !== SANDBOX_SOURCE_PACKAGE_SCHEMA || !digest(value.packageDigest)
    || !validSourceFingerprint(value.sourceFingerprint) || !Array.isArray(value.entries)
    || value.entries.length < 2 || value.entries.length > MAXIMUM_SANDBOX_ENTRIES
    || !safeInteger(value.totalFileBytes, 1, MAXIMUM_SANDBOX_SOURCE_BYTES)) return null

  const entries: SandboxSourceEntry[] = []
  let totalFileBytes = 0
  let priorPathBytes = new Uint8Array()
  for (const candidate of value.entries) {
    const parsed = await parseEntry(candidate)
    if (!parsed) return null
    const pathBytes = new TextEncoder().encode(parsed.path)
    if (entries.length > 0 && compareBytes(priorPathBytes, pathBytes) >= 0) return null
    priorPathBytes = pathBytes
    entries.push(parsed)
    totalFileBytes += parsed.size
    if (totalFileBytes > MAXIMUM_SANDBOX_SOURCE_BYTES) return null
  }
  if (totalFileBytes !== value.totalFileBytes
    || !entries.some(({ path, kind }) => path === 'package.json' && kind === 'file')
    || !entries.some(({ path, kind }) => path === 'package-lock.json' && kind === 'file')) return null

  const sourceFingerprint = value.sourceFingerprint as SandboxSourceFingerprint
  const fingerprintBody = Object.freeze({
    schema: sourceFingerprint.schema,
    implementationBaseline: sourceFingerprint.implementationBaseline,
    headRevision: sourceFingerprint.headRevision,
    authoredFileCount: sourceFingerprint.authoredFileCount,
    authoredTreeSha256: sourceFingerprint.authoredTreeSha256,
  })
  if (await sha256Hex(canonicalJson(fingerprintBody)) !== sourceFingerprint.fingerprintDigest) return null
  if (sourceFingerprint.authoredFileCount !== entries.length
    || await sourceTreeSha256(entries) !== sourceFingerprint.authoredTreeSha256) return null
  const body = Object.freeze({
    schema: SANDBOX_SOURCE_PACKAGE_SCHEMA,
    sourceFingerprint,
    entries: Object.freeze(entries),
    totalFileBytes,
  })
  if (await sha256Hex(canonicalJson(body)) !== value.packageDigest) return null
  return Object.freeze({ ...body, packageDigest: String(value.packageDigest) })
}

export async function validSandboxProofBearer(request: Request, configuredSecret: string | undefined): Promise<boolean> {
  if (!configuredSecret || configuredSecret.length < 43 || configuredSecret.length > 512
    || /\s/u.test(configuredSecret)) return false
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ') || header.length !== configuredSecret.length + 7) return false
  const supplied = header.slice(7)
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(configuredSecret)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied)),
  ])
  const expected = new Uint8Array(expectedDigest)
  const observed = new Uint8Array(suppliedDigest)
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ observed[index]!
  return difference === 0
}

export function validSandboxSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || value.includes('\0')
    || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment.length < 1 || segment === '.' || segment === '..')) return false
  try {
    if (new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) !== value) return false
  } catch {
    return false
  }
  return !forbiddenSourcePath(value, segments)
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('canonical_json_unsupported_value')
  return encoded
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const copied = new Uint8Array(bytes.byteLength)
  copied.set(bytes)
  const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', copied.buffer))
  return [...digestBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sourceTreeSha256(entries: readonly SandboxSourceEntry[]): Promise<string> {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    chunks.push(frame(new TextEncoder().encode(entry.path)))
    chunks.push(frame(new TextEncoder().encode(entry.mode)))
    chunks.push(frame(new TextEncoder().encode(entry.kind)))
    chunks.push(entry.kind === 'missing' ? frame(new Uint8Array()) : frame(decodeBase64(entry.contentBase64)))
  }
  return await sha256Hex(joinBytes(chunks))
}

function validSourceFingerprint(value: unknown): value is SandboxSourceFingerprint {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schema', 'implementationBaseline', 'headRevision', 'authoredFileCount', 'authoredTreeSha256', 'fingerprintDigest',
  ]) || value.schema !== 'agentic-commerce-authored-source-fingerprint/v1'
    || !/^[0-9a-f]{40}$/u.test(String(value.implementationBaseline))
    || !/^[0-9a-f]{40,64}$/u.test(String(value.headRevision))
    || !safeInteger(value.authoredFileCount, 2, MAXIMUM_SANDBOX_ENTRIES)
    || !digest(value.authoredTreeSha256) || !digest(value.fingerprintDigest)) return false
  return true
}

async function parseEntry(value: unknown): Promise<SandboxSourceEntry | null> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'path', 'kind', 'mode', 'size', 'sha256', 'contentBase64',
  ]) || !validSandboxSourcePath(value.path) || (value.kind !== 'file' && value.kind !== 'missing')
    || !safeInteger(value.size, 0, MAXIMUM_SANDBOX_ENTRY_BYTES) || !digest(value.sha256)
    || typeof value.contentBase64 !== 'string' || !canonicalBase64(value.contentBase64)) return null
  const kind = value.kind
  if ((kind === 'file' && value.mode !== '100644' && value.mode !== '100755')
    || (kind === 'missing' && value.mode !== 'missing')) return null
  const bytes = decodeBase64(value.contentBase64)
  if (bytes.byteLength !== value.size || (kind === 'missing' && bytes.byteLength !== 0)
    || await sha256Hex(bytes) !== value.sha256) return null
  return Object.freeze({
    path: String(value.path),
    kind,
    mode: value.mode as SandboxSourceEntry['mode'],
    size: Number(value.size),
    sha256: String(value.sha256),
    contentBase64: String(value.contentBase64),
  })
}

function forbiddenSourcePath(value: string, segments: readonly string[]): boolean {
  if (segments.includes('.git') || segments.includes('node_modules')
    || value === 'docs/evidence-verdicts' || value.startsWith('docs/evidence-verdicts/')) return true
  const basename = segments.at(-1)?.toLowerCase() ?? ''
  if (basename === '.env' || basename === '.dev.vars' || basename === '.npmrc'
    || basename === 'id_rsa' || basename === 'id_ed25519') return true
  return /\.(?:key|p12|pfx|pem)$/u.test(basename)
}

function canonicalBase64(value: string): boolean {
  if (value.length === 0) return true
  if (value.length > Math.ceil(MAXIMUM_SANDBOX_ENTRY_BYTES / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  try {
    const bytes = decodeBase64(value)
    return encodeBase64(bytes) === value
  } catch {
    return false
  }
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  const stride = 32_768
  for (let offset = 0; offset < value.length; offset += stride) {
    binary += String.fromCharCode(...value.subarray(offset, offset + stride))
  }
  return btoa(binary)
}

function frame(value: Uint8Array): Uint8Array {
  return joinBytes([new TextEncoder().encode(`${value.byteLength}:`), value, new TextEncoder().encode(';')])
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return left.length - right.length
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function safeInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function namedIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
