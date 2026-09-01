import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { pathToFileURL } from 'node:url'

import { parseSandboxProvisionReceipt } from './sandbox-provision-receipt.ts'
import { buildSandboxSourcePackage } from './sandbox-source-package.ts'
import {
  canonicalJson,
  SANDBOX_PROOF_COMMANDS,
  SANDBOX_PROOF_IMAGE,
  SANDBOX_PROOF_PACKAGE_VERSION,
  SANDBOX_PROOF_REQUEST_SCHEMA,
  SANDBOX_UNSIGNED_PROOF_SCHEMA,
  sha256Hex,
} from '../src/sandbox/provision-contract.ts'

const MAXIMUM_RESPONSE_BYTES = 256 * 1024

export type SandboxLiveProofEnvironment = Readonly<Record<string, string | undefined>>

export async function runSandboxLiveProof(
  environment: SandboxLiveProofEnvironment = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ outputPath: string; receiptDigest: string; sourceFingerprintDigest: string }>> {
  const workspaceRoot = fs.realpathSync(path.resolve(environment.AG_SANDBOX_PROOF_WORKSPACE ?? process.cwd()))
  const endpoint = proofEndpoint(required(environment, 'AG_SANDBOX_PROOF_ENDPOINT'))
  const bearerToken = required(environment, 'AG_SANDBOX_PROOF_BEARER_TOKEN')
  if (bearerToken.length < 43 || bearerToken.length > 512 || /\s/u.test(bearerToken)) {
    throw new Error('sandbox_live_proof_bearer_invalid')
  }
  const validityMs = positiveInteger(environment.AG_SANDBOX_PROOF_VALIDITY_MS ?? '3600000', 86_400_000)
  const issuer = namedIdentity(required(environment, 'AG_SANDBOX_PROOF_ISSUER'))
  const issuerKeyId = namedIdentity(required(environment, 'AG_SANDBOX_PROOF_ISSUER_KEY_ID'))
  const sourcePackage = await buildSandboxSourcePackage({
    workspaceRoot,
    implementationBaseline: exactHex(required(environment, 'AG_SANDBOX_PROOF_IMPLEMENTATION_BASELINE'), 40),
    trustedGitExecutable: absoluteFile(required(environment, 'AG_SANDBOX_PROOF_TRUSTED_GIT')),
    trustedGitExecutableSha256: exactHex(required(environment, 'AG_SANDBOX_PROOF_TRUSTED_GIT_SHA256'), 64),
  })
  const requestBody = Object.freeze({
    schema: SANDBOX_PROOF_REQUEST_SCHEMA,
    nonce: Buffer.from(crypto.randomBytes(32)).toString('hex'),
    issuer,
    issuerKeyId,
    validityMs,
    sourcePackage,
  })
  const sourceBeforeRequest = sourcePackage.sourceFingerprint.fingerprintDigest
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: Object.freeze({
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    }),
    body: canonicalJson(requestBody),
  })
  const responseValue = await boundedJsonResponse(response)
  if (!response.ok) {
    const code = isRecord(responseValue) && typeof responseValue.code === 'string'
      ? responseValue.code
      : `http_${response.status}`
    throw new Error(`sandbox_live_proof_remote_failed:${code}`)
  }
  const unsigned = await validateUnsignedProofResponse(responseValue, {
    issuer,
    issuerKeyId,
    sourceFingerprintDigest: sourceBeforeRequest,
    nonce: requestBody.nonce,
    packageDigest: sourcePackage.packageDigest,
  })
  if (!unsigned) throw new Error('sandbox_live_proof_response_invalid')

  const sourceAfterRequest = await buildSandboxSourcePackage({
    workspaceRoot,
    implementationBaseline: exactHex(required(environment, 'AG_SANDBOX_PROOF_IMPLEMENTATION_BASELINE'), 40),
    trustedGitExecutable: absoluteFile(required(environment, 'AG_SANDBOX_PROOF_TRUSTED_GIT')),
    trustedGitExecutableSha256: exactHex(required(environment, 'AG_SANDBOX_PROOF_TRUSTED_GIT_SHA256'), 64),
  })
  if (sourceAfterRequest.sourceFingerprint.fingerprintDigest !== sourceBeforeRequest
    || sourceAfterRequest.packageDigest !== sourcePackage.packageDigest) {
    throw new Error('sandbox_live_proof_source_changed')
  }
  const outputPath = externalOutputPath(
    workspaceRoot,
    required(environment, 'AG_SANDBOX_UNSIGNED_RECEIPT_PATH'),
  )
  const output = Object.freeze({
    schema: SANDBOX_UNSIGNED_PROOF_SCHEMA,
    controller: Object.freeze({
      provider: 'cloudflare-workers',
      endpoint,
      requestDigest: await sha256Hex(canonicalJson(requestBody)),
    }),
    receiptBody: unsigned.receiptBody,
    receiptDigest: unsigned.receiptDigest,
    signingPayloadBase64: Buffer.from(canonicalJson(unsigned.receiptBody)).toString('base64'),
  })
  writeNewPrivateFile(outputPath, `${canonicalJson(output)}\n`)
  return Object.freeze({
    outputPath,
    receiptDigest: unsigned.receiptDigest,
    sourceFingerprintDigest: sourceBeforeRequest,
  })
}

async function validateUnsignedProofResponse(
  value: unknown,
  expected: Readonly<{
    issuer: string
    issuerKeyId: string
    sourceFingerprintDigest: string
    nonce: string
    packageDigest: string
  }>,
): Promise<Readonly<{ receiptBody: Readonly<Record<string, unknown>>; receiptDigest: string }> | null> {
  if (!isRecord(value) || value.ok !== true || value.schema !== SANDBOX_UNSIGNED_PROOF_SCHEMA
    || !isRecord(value.receiptBody) || !digest(value.receiptDigest)) return null
  if (await sha256Hex(canonicalJson(value.receiptBody)) !== value.receiptDigest) return null
  const provisional = parseSandboxProvisionReceipt({
    ...value.receiptBody,
    receiptDigest: value.receiptDigest,
    signatureAlgorithm: 'ed25519',
    signatureBase64: 'AAAA',
  })
  if (!provisional || provisional.issuer !== expected.issuer || provisional.issuerKeyId !== expected.issuerKeyId
    || provisional.sourceFingerprint.fingerprintDigest !== expected.sourceFingerprintDigest
    || provisional.sandboxPackageVersion !== SANDBOX_PROOF_PACKAGE_VERSION
    || provisional.sandboxImage !== SANDBOX_PROOF_IMAGE
    || provisional.lanes.some((lane, index) => (
      lane.taskId !== SANDBOX_PROOF_COMMANDS[index]?.taskId
      || lane.command !== SANDBOX_PROOF_COMMANDS[index]?.command
    ))) return null
  const expectedReceiptId = await sha256Hex(canonicalJson({
    nonce: expected.nonce,
    packageDigest: expected.packageDigest,
    instanceIdentity: provisional.instance.identity,
    lanes: provisional.lanes,
    terminationCompletedAtMs: provisional.termination.completedAtMs,
  }))
  if (provisional.receiptId !== expectedReceiptId) return null
  return Object.freeze({ receiptBody: value.receiptBody, receiptDigest: value.receiptDigest })
}

async function boundedJsonResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) {
    await response.body?.cancel('sandbox proof response too large')
    throw new Error('sandbox_live_proof_response_too_large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('sandbox_live_proof_response_absent')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel('sandbox proof response too large')
        throw new Error('sandbox_live_proof_response_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error('sandbox_live_proof_response_malformed')
  }
}

function proofEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/v1/provision-proof') throw new Error('sandbox_live_proof_endpoint_invalid')
  return url.href
}

function externalOutputPath(workspaceRoot: string, requested: string): string {
  if (!path.isAbsolute(requested) || requested.includes('\0')) throw new Error('sandbox_live_proof_output_invalid')
  const output = path.resolve(requested)
  const parent = fs.realpathSync(path.dirname(output))
  if (!fs.statSync(parent).isDirectory() || within(workspaceRoot, parent)) {
    throw new Error('sandbox_live_proof_output_must_be_external')
  }
  try {
    fs.lstatSync(output)
    throw new Error('sandbox_live_proof_output_exists')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  return output
}

function writeNewPrivateFile(requested: string, content: string): void {
  const descriptor = fs.openSync(requested, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
  try {
    const bytes = Buffer.from(content)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function absoluteFile(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('sandbox_live_proof_git_invalid')
  const real = fs.realpathSync(value)
  if (!fs.statSync(real).isFile()) throw new Error('sandbox_live_proof_git_invalid')
  return real
}

function positiveInteger(value: string, maximum: number): number {
  if (!/^\d+$/u.test(value)) throw new Error('sandbox_live_proof_validity_invalid')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error('sandbox_live_proof_validity_invalid')
  }
  return parsed
}

function exactHex(value: string, length: number): string {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)) throw new Error('sandbox_live_proof_hex_invalid')
  return value
}

function namedIdentity(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new Error('sandbox_live_proof_identity_invalid')
  return value
}

function required(environment: SandboxLiveProofEnvironment, name: string): string {
  const value = environment[name]
  if (!value) throw new Error(`sandbox_live_proof_environment_missing:${name}`)
  return value
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSandboxLiveProof().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  }).catch((error: unknown) => {
    const code = error instanceof Error ? error.message : 'sandbox_live_proof_failed'
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
    process.exitCode = 1
  })
}
