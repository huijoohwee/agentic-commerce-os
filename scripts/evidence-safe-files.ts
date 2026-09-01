import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './evidence-integrity.ts'

const ARTIFACT_DIRECTORY = 'docs/evidence-verdicts'

export type BoundedEvidenceFile = Readonly<{
  name: string
  path: string
  bytes: Buffer
}>

export function readExactWorkspaceFile(
  workspaceRoot: string,
  requested: string,
  expected: string,
  maximumBytes: number,
): Buffer | null {
  if (requested.replaceAll('\\', '/') !== expected || path.isAbsolute(requested) || requested.includes('\0')) return null
  const workspace = realDirectory(workspaceRoot)
  if (!workspace) return null
  const resolved = path.resolve(workspace, requested)
  if (!within(workspace, resolved) || !safePathAncestry(workspace, resolved, false)) return null
  return readStableFile(resolved, maximumBytes)
}

export function validEvidenceArtifactDirectory(requested: string): boolean {
  return requested.replaceAll('\\', '/') === ARTIFACT_DIRECTORY
    && !path.isAbsolute(requested) && !requested.includes('\0')
}

export function resolveEvidenceArtifactRoot(
  workspaceRoot: string,
  requested: string,
  externalArtifactRoot?: string,
): string | null {
  if (!validEvidenceArtifactDirectory(requested) || !externalArtifactRoot
    || !path.isAbsolute(externalArtifactRoot) || externalArtifactRoot.includes('\0')) return null
  const workspace = realDirectory(workspaceRoot)
  if (!workspace) return null
  const lexicalRoot = path.resolve(externalArtifactRoot)
  if (overlaps(workspace, lexicalRoot)) return null
  try {
    const before = fs.lstatSync(lexicalRoot, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) return null
    const artifactRoot = fs.realpathSync(lexicalRoot)
    const after = fs.lstatSync(lexicalRoot, { bigint: true })
    if (!sameStableEntry(before, after) || overlaps(workspace, artifactRoot)) return null
    return artifactRoot
  } catch {
    return null
  }
}

export function resolveEvidenceReadableSurface(
  workspaceRoot: string,
  artifactRoot: string,
  requested: string,
): string | null {
  const relative = logicalArtifactRelativePath(requested)
  if (relative === null || relative.length === 0) return null
  const expectedRoot = resolveEvidenceArtifactRoot(workspaceRoot, ARTIFACT_DIRECTORY, artifactRoot)
  if (!expectedRoot || path.resolve(artifactRoot) !== expectedRoot) return null
  const resolved = path.resolve(expectedRoot, relative)
  if (!within(expectedRoot, resolved) || !safePathAncestry(expectedRoot, resolved, false)) return null
  try {
    const stat = fs.lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return within(fs.realpathSync(expectedRoot), fs.realpathSync(resolved)) ? resolved : null
  } catch {
    return resolved
  }
}

export function readEvidenceFile(
  workspaceRoot: string,
  artifactRoot: string,
  requested: string,
  maximumBytes: number,
): BoundedEvidenceFile | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return null
  const resolved = resolveEvidenceReadableSurface(workspaceRoot, artifactRoot, requested)
  if (!resolved) return null
  const bytes = readStableFile(resolved, maximumBytes)
  return bytes ? Object.freeze({ name: path.basename(resolved), path: resolved, bytes }) : null
}

function readStableFile(resolved: string, maximumBytes: number): Buffer | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return null
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes)) return null
    const bytes = readBounded(descriptor, maximumBytes)
    const after = fs.fstatSync(descriptor, { bigint: true })
    if (!bytes
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== before.size) {
      return null
    }
    return bytes
  } catch {
    return null
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function readBounded(descriptor: number, maximumBytes: number): Buffer | null {
  const chunks: Buffer[] = []
  let totalBytes = 0
  while (totalBytes <= maximumBytes) {
    const remaining = maximumBytes + 1 - totalBytes
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    totalBytes += bytesRead
  }
  return totalBytes > maximumBytes ? null : Buffer.concat(chunks, totalBytes)
}

export function listEvidenceJsonFiles(
  workspaceRoot: string,
  artifactRoot: string,
  subdirectory: string,
  limits: Readonly<{ maximumEntries: number; maximumFileBytes: number; maximumTotalBytes: number }>,
): readonly BoundedEvidenceFile[] | null {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(subdirectory)
    || !Number.isSafeInteger(limits.maximumEntries) || limits.maximumEntries < 1
    || !Number.isSafeInteger(limits.maximumTotalBytes) || limits.maximumTotalBytes < 1) return null
  const expectedRoot = resolveEvidenceArtifactRoot(workspaceRoot, ARTIFACT_DIRECTORY, artifactRoot)
  if (!expectedRoot || path.resolve(artifactRoot) !== expectedRoot) return null
  const directory = path.join(expectedRoot, subdirectory)
  if (!fs.existsSync(directory)) return Object.freeze([])
  if (!safePathAncestry(expectedRoot, directory, true) || !safeDirectory(expectedRoot, directory, true)) return null
  let handle: fs.Dir
  try {
    handle = fs.opendirSync(directory)
  } catch {
    return null
  }
  const files: BoundedEvidenceFile[] = []
  let entryCount = 0
  let totalBytes = 0
  try {
    while (true) {
      const entry = handle.readSync()
      if (!entry) break
      entryCount += 1
      if (entryCount > limits.maximumEntries) return null
      if (!entry.name.endsWith('.json')) continue
      const relative = path.posix.join(ARTIFACT_DIRECTORY, subdirectory, entry.name)
      const file = readEvidenceFile(workspaceRoot, expectedRoot, relative, limits.maximumFileBytes)
      if (!file) return null
      totalBytes += file.bytes.byteLength
      if (totalBytes > limits.maximumTotalBytes) return null
      files.push(file)
    }
  } finally {
    handle.closeSync()
  }
  return Object.freeze(files.sort((left, right) => left.name.localeCompare(right.name)))
}

export function writeEvidenceJsonAtomically(
  workspaceRoot: string,
  artifactRoot: string,
  filePath: string,
  value: unknown,
): Buffer {
  const expectedRoot = resolveEvidenceArtifactRoot(workspaceRoot, ARTIFACT_DIRECTORY, artifactRoot)
  if (!expectedRoot || path.resolve(artifactRoot) !== expectedRoot || !within(expectedRoot, filePath)) {
    throw new Error('evidence_artifact_path_invalid')
  }
  ensureDirectory(expectedRoot)
  const parent = path.dirname(filePath)
  if (!safePathAncestry(expectedRoot, parent, true)) throw new Error('evidence_artifact_path_invalid')
  ensureDirectory(parent)
  if (!safePathAncestry(expectedRoot, filePath, false) || !safeWriteTarget(filePath)) {
    throw new Error('evidence_artifact_path_invalid')
  }

  const nonce = Buffer.from(randomBytes(16)).toString('hex')
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${nonce}.tmp`)
  const bytes = Buffer.from(`${canonicalJson(value)}\n`)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporaryPath, flags, 0o600)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    if (!safePathAncestry(expectedRoot, parent, true) || !safeWriteTarget(filePath)) {
      throw new Error('evidence_artifact_path_invalid')
    }
    fs.renameSync(temporaryPath, filePath)
    const written = fs.lstatSync(filePath)
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1
      || !within(fs.realpathSync(expectedRoot), fs.realpathSync(filePath))) {
      throw new Error('evidence_artifact_path_invalid')
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return bytes
}

function safeDirectory(workspaceRoot: string, requested: string, required: boolean): boolean {
  try {
    const stat = fs.lstatSync(requested)
    return stat.isDirectory() && !stat.isSymbolicLink() && within(workspaceRoot, fs.realpathSync(requested))
  } catch (error) {
    return !required && isMissing(error)
  }
}

function safePathAncestry(root: string, requested: string, finalMustBeDirectory: boolean): boolean {
  if (!within(root, requested)) return false
  const segments = path.relative(root, requested).split(path.sep).filter(Boolean)
  let cursor = root
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment)
    try {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) return false
      const final = index === segments.length - 1
      if ((!final || finalMustBeDirectory) && !stat.isDirectory()) return false
    } catch (error) {
      if (!isMissing(error)) return false
      return true
    }
  }
  return true
}

function ensureDirectory(requested: string): void {
  try {
    fs.mkdirSync(requested, { mode: 0o700 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  const stat = fs.lstatSync(requested)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('evidence_artifact_path_invalid')
}

function safeWriteTarget(requested: string): boolean {
  try {
    const stat = fs.lstatSync(requested)
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
  } catch (error) {
    return isMissing(error)
  }
}

function realDirectory(requested: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(requested))
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left)
}

function logicalArtifactRelativePath(requested: string): string | null {
  if (path.isAbsolute(requested) || requested.includes('\0')) return null
  const normalized = requested.replaceAll('\\', '/')
  if (normalized === ARTIFACT_DIRECTORY) return ''
  if (!normalized.startsWith(`${ARTIFACT_DIRECTORY}/`)) return null
  const segments = normalized.slice(ARTIFACT_DIRECTORY.length + 1).split('/')
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join(path.sep)
}

function sameStableEntry(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
