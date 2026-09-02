import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { canonicalJson, sha256 } from './evidence-integrity.ts'

export const AUTHORED_SOURCE_FINGERPRINT_SCHEMA = 'agentic-commerce-authored-source-fingerprint/v1'

export type AuthoredSourceFingerprint = Readonly<{
  schema: typeof AUTHORED_SOURCE_FINGERPRINT_SCHEMA
  implementationBaseline: string
  headRevision: string
  authoredFileCount: number
  authoredTreeSha256: string
  fingerprintDigest: string
}>

export type TrustedGitRuntime = Readonly<{
  executable: string
  executableSha256: string
}>

const EXCLUDED_DIRECTORY_PREFIXES = Object.freeze([
  '.cache/',
  '.git/',
  '.tmp/',
  '.turbo/',
  '.vite/',
  '.wrangler/',
  'build/',
  'coverage/',
  'dist/',
  'docs/evidence-verdicts/',
  'node_modules/',
  'playwright-report/',
  'temp/',
  'test-results/',
  'tmp/',
])

const MAXIMUM_AUTHORED_FILE_BYTES = 2 * 1024 * 1024
const MAXIMUM_AUTHORED_TREE_BYTES = 64 * 1024 * 1024

export function computeAuthoredSourceFingerprint(
  workspaceRoot: string,
  implementationBaseline: string,
  trustedGit: TrustedGitRuntime,
): AuthoredSourceFingerprint | null {
  const workspace = realDirectory(workspaceRoot)
  if (!workspace || !trustedGitRuntimeStillValid(workspace, trustedGit) || !isExactGitRoot(workspace, trustedGit)) return null
  if (!/^[0-9a-f]{40}$/u.test(implementationBaseline)
    || !gitSucceeds(workspace, trustedGit, ['merge-base', '--is-ancestor', implementationBaseline, 'HEAD'])) return null
  const headRevision = gitText(workspace, trustedGit, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!headRevision || !/^[0-9a-f]{40,64}$/u.test(headRevision)) return null
  const listed = gitBytes(workspace, trustedGit, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  if (!listed) return null
  const paths = splitNul(listed)
    .filter((relativePath) => relativePath.length > 0 && !excluded(relativePath))
    .sort(Buffer.compare)
  if (hasDuplicate(paths)) return null

  const authoredTreeSha256 = digestEntries(workspace, paths)
  if (!authoredTreeSha256) return null
  const body = Object.freeze({
    schema: AUTHORED_SOURCE_FINGERPRINT_SCHEMA,
    implementationBaseline,
    headRevision,
    authoredFileCount: paths.length,
    authoredTreeSha256,
  })
  return Object.freeze({ ...body, fingerprintDigest: sha256(canonicalJson(body)) })
}

export function sameAuthoredSource(
  left: AuthoredSourceFingerprint | null,
  right: AuthoredSourceFingerprint | null,
): boolean {
  return Boolean(left && right && canonicalJson(left) === canonicalJson(right))
}

export function authoredSourceIsCurrent(
  recorded: AuthoredSourceFingerprint | null,
  current: AuthoredSourceFingerprint | null,
  workspaceRoot: string,
  trustedGit: TrustedGitRuntime,
): boolean {
  if (!recorded || !current || recorded.implementationBaseline !== current.implementationBaseline
    || recorded.authoredFileCount !== current.authoredFileCount
    || recorded.authoredTreeSha256 !== current.authoredTreeSha256) return false
  if (recorded.headRevision === current.headRevision) return true
  const workspace = realDirectory(workspaceRoot)
  if (!workspace || !trustedGitRuntimeStillValid(workspace, trustedGit)
    || !gitSucceeds(workspace, trustedGit, ['merge-base', '--is-ancestor', recorded.headRevision, current.headRevision])) {
    return false
  }
  return evidenceOnlyCommitRange(workspace, trustedGit, recorded.headRevision, current.headRevision)
}

export function resolveTrustedGitRuntime(
  workspaceRoot: string,
  requestedExecutable: string | undefined,
  expectedSha256: string,
): TrustedGitRuntime | null {
  if (!requestedExecutable || !path.isAbsolute(requestedExecutable) || !/^[0-9a-f]{64}$/u.test(expectedSha256)) return null
  const workspace = realDirectory(workspaceRoot)
  if (!workspace) return null
  try {
    const executable = fs.realpathSync(requestedExecutable)
    const stat = fs.statSync(executable)
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || within(workspace, executable)
      || executable.replaceAll('\\', '/').split('/').includes('node_modules')) return null
    if (sha256(fs.readFileSync(executable)) !== expectedSha256) return null
    return Object.freeze({ executable, executableSha256: expectedSha256 })
  } catch {
    return null
  }
}

export function validAuthoredSourceFingerprint(value: unknown): value is AuthoredSourceFingerprint {
  if (!isRecord(value) || value.schema !== AUTHORED_SOURCE_FINGERPRINT_SCHEMA) return false
  if (!/^[0-9a-f]{40}$/u.test(String(value.implementationBaseline))) return false
  if (!/^[0-9a-f]{40,64}$/u.test(String(value.headRevision))) return false
  if (!Number.isSafeInteger(value.authoredFileCount) || Number(value.authoredFileCount) < 0) return false
  if (!digest(value.authoredTreeSha256) || !digest(value.fingerprintDigest)) return false
  const body = {
    schema: AUTHORED_SOURCE_FINGERPRINT_SCHEMA,
    implementationBaseline: String(value.implementationBaseline),
    headRevision: String(value.headRevision),
    authoredFileCount: Number(value.authoredFileCount),
    authoredTreeSha256: String(value.authoredTreeSha256),
  }
  return sha256(canonicalJson(body)) === value.fingerprintDigest
}

function digestEntries(workspaceRoot: string, relativePaths: readonly Buffer[]): string | null {
  const hash = crypto.createHash('sha256')
  const rootBytes = Buffer.from(`${workspaceRoot}${path.sep}`)
  let totalBytes = 0
  try {
    for (const relativePathBytes of relativePaths) {
      const absolutePath = Buffer.concat([rootBytes, relativePathBytes])
      let stat: fs.BigIntStats
      try {
        stat = fs.lstatSync(absolutePath, { bigint: true })
      } catch (error) {
        if (!isMissing(error)) throw error
        updateEntryFrames(hash, relativePathBytes, 'missing', 'missing')
        updateEmptyFrame(hash)
        continue
      }
      if (stat.isSymbolicLink()) {
        const content = fs.readlinkSync(absolutePath, { encoding: 'buffer' })
        const after = fs.lstatSync(absolutePath, { bigint: true })
        if (!sameStableFile(stat, after) || content.byteLength > MAXIMUM_AUTHORED_FILE_BYTES) return null
        totalBytes += content.byteLength
        if (totalBytes > MAXIMUM_AUTHORED_TREE_BYTES) return null
        updateEntryFrames(hash, relativePathBytes, '120000', 'symlink')
        hash.update(frame(content))
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAXIMUM_AUTHORED_FILE_BYTES)) return null
      totalBytes += Number(stat.size)
      if (totalBytes > MAXIMUM_AUTHORED_TREE_BYTES) return null
      updateEntryFrames(hash, relativePathBytes, (stat.mode & 0o111n) === 0n ? '100644' : '100755', 'file')
      if (!updateFileContentFrame(hash, absolutePath, stat)) return null
    }
  } catch {
    return null
  }
  return hash.digest('hex')
}

function updateEntryFrames(hash: crypto.Hash, relativePathBytes: Buffer, mode: string, kind: string): void {
  hash.update(frame(relativePathBytes))
  hash.update(frame(Buffer.from(mode)))
  hash.update(frame(Buffer.from(kind)))
}

function updateEmptyFrame(hash: crypto.Hash): void {
  hash.update(Buffer.from('0:;'))
}

function updateFileContentFrame(hash: crypto.Hash, absolutePath: Buffer, before: fs.BigIntStats): boolean {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!sameStableFile(before, opened)) return false
    hash.update(Buffer.from(`${before.size}:`))
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let totalBytes = 0
    while (totalBytes <= MAXIMUM_AUTHORED_FILE_BYTES) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAXIMUM_AUTHORED_FILE_BYTES) return false
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fs.fstatSync(descriptor, { bigint: true })
    if (!sameStableFile(opened, after) || BigInt(totalBytes) !== before.size) return false
    hash.update(Buffer.from(';'))
    return true
  } catch {
    return false
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
}

function frame(value: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${value.length}:`), value, Buffer.from(';')])
}

function excluded(relativePathBytes: Buffer): boolean {
  const relativePath = new TextDecoder().decode(relativePathBytes).replaceAll('\\', '/')
  return EXCLUDED_DIRECTORY_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))
}

function evidenceOnlyCommitRange(
  workspaceRoot: string,
  trustedGit: TrustedGitRuntime,
  recordedHead: string,
  currentHead: string,
): boolean {
  const revisions = gitText(workspaceRoot, trustedGit, ['rev-list', '--parents', `${recordedHead}..${currentHead}`])
  if (revisions === null) return false
  for (const line of revisions.split('\n').filter(Boolean)) {
    const [commit, ...parents] = line.trim().split(' ')
    if (!commit || parents.length === 0) return false
    for (const parent of parents) {
      const paths = gitBytes(workspaceRoot, trustedGit, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parent, commit])
      if (!paths || splitNul(paths).some((relativePath) => relativePath.length > 0 && !evidenceOutput(relativePath))) {
        return false
      }
    }
  }
  return true
}

function evidenceOutput(relativePathBytes: Buffer): boolean {
  const relativePath = new TextDecoder().decode(relativePathBytes).replaceAll('\\', '/')
  return relativePath === 'docs/evidence-verdicts' || relativePath.startsWith('docs/evidence-verdicts/')
}

function splitNul(value: Buffer): Buffer[] {
  const result: Buffer[] = []
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue
    result.push(value.subarray(start, index))
    start = index + 1
  }
  if (start < value.length) result.push(value.subarray(start))
  return result
}

function hasDuplicate(values: readonly Buffer[]): boolean {
  return values.some((value, index) => index > 0 && Buffer.compare(value, values[index - 1] ?? Buffer.alloc(0)) === 0)
}

function isExactGitRoot(workspaceRoot: string, trustedGit: TrustedGitRuntime): boolean {
  const root = gitText(workspaceRoot, trustedGit, ['rev-parse', '--show-toplevel'])
  if (!root) return false
  try {
    return fs.realpathSync(root) === workspaceRoot
  } catch {
    return false
  }
}

function gitText(workspaceRoot: string, trustedGit: TrustedGitRuntime, argumentsValue: readonly string[]): string | null {
  const result = spawnSync(trustedGit.executable, ['-C', workspaceRoot, ...argumentsValue], {
    encoding: 'utf8',
    env: minimalGitEnvironment() as unknown as NodeJS.ProcessEnv,
    maxBuffer: 16 * 1024 * 1024,
  })
  return result.status === 0 ? String(result.stdout).trim() : null
}

function gitBytes(workspaceRoot: string, trustedGit: TrustedGitRuntime, argumentsValue: readonly string[]): Buffer | null {
  const result = spawnSync(trustedGit.executable, ['-C', workspaceRoot, ...argumentsValue], {
    encoding: 'buffer',
    env: minimalGitEnvironment() as unknown as NodeJS.ProcessEnv,
    maxBuffer: 64 * 1024 * 1024,
  })
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null
}

function gitSucceeds(workspaceRoot: string, trustedGit: TrustedGitRuntime, argumentsValue: readonly string[]): boolean {
  return spawnSync(trustedGit.executable, ['-C', workspaceRoot, ...argumentsValue], {
    encoding: 'utf8',
    env: minimalGitEnvironment() as unknown as NodeJS.ProcessEnv,
    maxBuffer: 1024 * 1024,
  }).status === 0
}

function trustedGitRuntimeStillValid(workspaceRoot: string, trustedGit: TrustedGitRuntime): boolean {
  const resolved = resolveTrustedGitRuntime(workspaceRoot, trustedGit.executable, trustedGit.executableSha256)
  return Boolean(resolved && resolved.executable === trustedGit.executable)
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function minimalGitEnvironment(): Record<string, string> {
  return Object.freeze({
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: path.parse(process.cwd()).root,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  })
}

function realDirectory(requested: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(requested))
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
