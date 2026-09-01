import { sha256Hex } from '../shared/digest.js'
import { isRecord } from '../shared/http.js'

export const EXECUTABLE_TARGET_CONTRACT = 'agentic-graph-sandbox-executable/v1'
export const EXECUTABLE_TARGET_PATH = '/tmp/agentic-graph-registration-target.mjs'
export const EXECUTABLE_RUNNER_PATH = '/tmp/agentic-graph-registration-runner.mjs'
export const MAXIMUM_EXECUTABLE_TARGET_BYTES = 262_144

export const EXECUTABLE_RUNNER_SOURCE = String.raw`
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const exit = process.exit.bind(process);
const request = JSON.parse(readFileSync(0, 'utf8'));
let loaded;
try {
  loaded = await import(pathToFileURL(request.targetPath).href + '?digest=' + request.sourceDigest);
} catch {
  exit(4);
}
if (typeof loaded?.executeTool !== 'function') exit(4);
if (request.mode === 'probe') exit(0);
let result;
try {
  result = await loaded.executeTool(request.toolId, request.input);
} catch {
  exit(2);
}
try {
  const encoded = JSON.stringify(result === undefined ? null : result);
  if (Buffer.byteLength(encoded, 'utf8') > 65536) exit(3);
} catch {
  exit(3);
}
exit(0);
`

export type ExecutableTarget = Readonly<{
  contract: typeof EXECUTABLE_TARGET_CONTRACT
  kind: 'javascript-module'
  source: string
  sourceDigest: string
}>

export function readExecutableTarget(payload: unknown): ExecutableTarget | null {
  if (!isRecord(payload) || !isRecord(payload.executableTarget)) return null
  const target = payload.executableTarget
  if (Object.keys(target).sort().join(',') !== 'contract,kind,source,sourceDigest'
    || target.contract !== EXECUTABLE_TARGET_CONTRACT
    || target.kind !== 'javascript-module'
    || typeof target.source !== 'string'
    || target.source.length < 1
    || new TextEncoder().encode(target.source).byteLength > MAXIMUM_EXECUTABLE_TARGET_BYTES
    || typeof target.sourceDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(target.sourceDigest)) return null
  return Object.freeze({
    contract: EXECUTABLE_TARGET_CONTRACT,
    kind: 'javascript-module',
    source: target.source,
    sourceDigest: target.sourceDigest,
  })
}

export async function executableTargetDigestMatches(target: ExecutableTarget): Promise<boolean> {
  return await sha256Hex(target.source) === target.sourceDigest
}
