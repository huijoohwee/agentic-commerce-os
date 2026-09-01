import { createPublicKey } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson, sha256 } from '../evidence-integrity.ts'

export const HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA = 'agentic-graph-human-presence-trust-anchor/v1'
export const PRODUCTION_HUMAN_PRESENCE_ANCHOR_SCHEMA = 'agentic-commerce-human-presence-anchor/v1'

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const MAXIMUM_JSON_BYTES = 8_192

type JsonObject = Record<string, unknown>

export type HumanPresenceTrustAnchor = Readonly<{
  schema: typeof HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA
  issuer: string
  publicKeySpkiBase64: string
}>

export type ProductionHumanPresenceAnchorProof = Readonly<{
  schema: typeof PRODUCTION_HUMAN_PRESENCE_ANCHOR_SCHEMA
  anchor: HumanPresenceTrustAnchor
  bindingValue: string
  bindingDigest: string
}>

export function validateHumanPresenceTrustAnchor(value: unknown): HumanPresenceTrustAnchor {
  const anchor = object(value, 'anchor_invalid')
  exactKeys(anchor, ['issuer', 'publicKeySpkiBase64', 'schema'], 'anchor_shape_invalid')
  exact(anchor.schema === HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA, 'anchor_schema_invalid')
  exact(typeof anchor.issuer === 'string' && IDENTIFIER_PATTERN.test(anchor.issuer), 'anchor_issuer_invalid')
  exact(typeof anchor.publicKeySpkiBase64 === 'string' && BASE64_PATTERN.test(anchor.publicKeySpkiBase64),
    'anchor_public_key_invalid')
  const keyBytes = Buffer.from(anchor.publicKeySpkiBase64, 'base64')
  exact(keyBytes.byteLength === 44 && keyBytes.toString('base64') === anchor.publicKeySpkiBase64,
    'anchor_public_key_invalid')
  try {
    const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' })
    exact(key.asymmetricKeyType === 'ed25519'
      && Buffer.from(key.export({ format: 'der', type: 'spki' })).equals(keyBytes), 'anchor_public_key_not_ed25519')
  } catch {
    throw new Error('production_human_presence_anchor:anchor_public_key_not_ed25519')
  }
  return Object.freeze({
    schema: HUMAN_PRESENCE_TRUST_ANCHOR_SCHEMA,
    issuer: anchor.issuer,
    publicKeySpkiBase64: anchor.publicKeySpkiBase64,
  })
}

export function buildHumanPresenceAnchorProof(bindingValue: string): ProductionHumanPresenceAnchorProof {
  exact(bindingValue === bindingValue.trim() && bindingValue.length > 0
    && Buffer.byteLength(bindingValue) <= MAXIMUM_JSON_BYTES, 'binding_value_invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(bindingValue) as unknown
  } catch {
    throw new Error('production_human_presence_anchor:binding_json_invalid')
  }
  const anchor = validateHumanPresenceTrustAnchor(parsed)
  const canonicalBinding = canonicalJson(anchor)
  return Object.freeze({
    schema: PRODUCTION_HUMAN_PRESENCE_ANCHOR_SCHEMA,
    anchor,
    bindingValue: canonicalBinding,
    bindingDigest: sha256(canonicalBinding),
  })
}

export function parseHumanPresenceAnchorProof(value: unknown): ProductionHumanPresenceAnchorProof {
  const proof = object(value, 'proof_invalid')
  exactKeys(proof, ['anchor', 'bindingDigest', 'bindingValue', 'schema'], 'proof_shape_invalid')
  exact(proof.schema === PRODUCTION_HUMAN_PRESENCE_ANCHOR_SCHEMA && typeof proof.bindingValue === 'string',
    'proof_contract_invalid')
  const rebuilt = buildHumanPresenceAnchorProof(proof.bindingValue)
  exact(canonicalJson(rebuilt.anchor) === canonicalJson(proof.anchor)
    && rebuilt.bindingDigest === proof.bindingDigest, 'proof_binding_mismatch')
  return rebuilt
}

function readJson(filePath: string): unknown {
  const descriptor = fs.openSync(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    exact(stat.isFile() && stat.size > 0 && stat.size <= MAXIMUM_JSON_BYTES, 'proof_file_invalid')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor))) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

function object(value: unknown, code: string): JsonObject {
  exact(value !== null && typeof value === 'object' && !Array.isArray(value), code)
  return value as JsonObject
}

function exactKeys(value: JsonObject, expected: readonly string[], code: string): void {
  exact(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()), code)
}

function exact(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_human_presence_anchor:${code}`)
}

async function main(): Promise<void> {
  const [command, argument, ...extra] = process.argv.slice(2)
  if (command === 'from-env' && argument && extra.length === 0) {
    const proof = buildHumanPresenceAnchorProof(process.env.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON ?? '')
    fs.writeFileSync(path.resolve(argument), `${canonicalJson(proof)}\n`, { encoding: 'utf8', flag: 'wx' })
  } else if (command === 'verify' && argument && extra.length === 0) {
    process.stdout.write(`${canonicalJson(parseHumanPresenceAnchorProof(readJson(argument)))}\n`)
  } else {
    throw new Error('production_human_presence_anchor:unsupported_command')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_human_presence_anchor:unknown_error'}\n`)
    process.exitCode = 1
  })
}
