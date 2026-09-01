import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'

import {
  computeAuthoredSourceFingerprint,
  resolveTrustedGitRuntime,
  sameAuthoredSource,
} from './evidence-source-fingerprint.ts'
import {
  canonicalJson,
  MAXIMUM_SANDBOX_ENTRY_BYTES,
  MAXIMUM_SANDBOX_SOURCE_BYTES,
  parseSandboxSourcePackage,
  SANDBOX_SOURCE_PACKAGE_SCHEMA,
  sha256Hex,
  validSandboxSourcePath,
  type SandboxSourceEntry,
  type SandboxSourcePackage,
} from '../src/sandbox/provision-contract.ts'

const EXCLUDED_PREFIXES = Object.freeze([
  '.cache/', '.git/', '.tmp/', '.turbo/', '.vite/', '.wrangler/', 'build/', 'coverage/', 'dist/',
  'docs/evidence-verdicts/', 'node_modules/', 'playwright-report/', 'temp/', 'test-results/', 'tmp/',
])

export type SandboxSourcePackageOptions = Readonly<{
  workspaceRoot: string
  implementationBaseline: string
  trustedGitExecutable: string
  trustedGitExecutableSha256: string
}>

export async function buildSandboxSourcePackage(
  options: SandboxSourcePackageOptions,
): Promise<SandboxSourcePackage> {
  const workspaceRoot = realDirectory(options.workspaceRoot)
  if (!workspaceRoot) throw new Error('sandbox_source_workspace_invalid')
  const trustedGit = resolveTrustedGitRuntime(
    workspaceRoot,
    options.trustedGitExecutable,
    options.trustedGitExecutableSha256,
  )
  if (!trustedGit) throw new Error('sandbox_source_trusted_git_invalid')
  const fingerprintAtStart = computeAuthoredSourceFingerprint(
    workspaceRoot,
    options.implementationBaseline,
    trustedGit,
  )
  if (!fingerprintAtStart) throw new Error('sandbox_source_fingerprint_unavailable')

  const listed = spawnSync(trustedGit.executable, [
    '-C', workspaceRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], {
    encoding: 'buffer',
    env: minimalGitEnvironment() as unknown as NodeJS.ProcessEnv,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) throw new Error('sandbox_source_list_failed')
  const paths = splitNul(listed.stdout)
    .filter((value) => value.length > 0 && !excluded(value))
    .sort(Buffer.compare)
  if (paths.length < 2 || paths.some((value, index) => index > 0 && Buffer.compare(value, paths[index - 1]!) === 0)) {
    throw new Error('sandbox_source_path_set_invalid')
  }

  const entries: SandboxSourceEntry[] = []
  let totalFileBytes = 0
  for (const relativePathBytes of paths) {
    const relativePath = decodePath(relativePathBytes)
    if (!validSandboxSourcePath(relativePath)) throw new Error(`sandbox_source_path_forbidden:${relativePath}`)
    const absolutePath = path.join(workspaceRoot, relativePath)
    let before: fs.BigIntStats
    try {
      before = fs.lstatSync(absolutePath, { bigint: true })
    } catch (error) {
      if (!isMissing(error)) throw error
      entries.push(await missingEntry(relativePath))
      continue
    }
    if (before.isSymbolicLink()) throw new Error(`sandbox_source_symlink_forbidden:${relativePath}`)
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAXIMUM_SANDBOX_ENTRY_BYTES)) {
      throw new Error(`sandbox_source_file_invalid:${relativePath}`)
    }
    const real = fs.realpathSync(absolutePath)
    if (!within(workspaceRoot, real) || real !== absolutePath) {
      throw new Error(`sandbox_source_ancestry_invalid:${relativePath}`)
    }
    const content = readStableFile(absolutePath, before)
    totalFileBytes += content.byteLength
    if (totalFileBytes > MAXIMUM_SANDBOX_SOURCE_BYTES) throw new Error('sandbox_source_size_exceeded')
    entries.push(Object.freeze({
      path: relativePath,
      kind: 'file',
      mode: (before.mode & 0o111n) === 0n ? '100644' : '100755',
      size: content.byteLength,
      sha256: await sha256Hex(content),
      contentBase64: Buffer.from(content).toString('base64'),
    }))
  }

  const body = Object.freeze({
    schema: SANDBOX_SOURCE_PACKAGE_SCHEMA,
    sourceFingerprint: fingerprintAtStart,
    entries: Object.freeze(entries),
    totalFileBytes,
  })
  const candidate = Object.freeze({ ...body, packageDigest: await sha256Hex(canonicalJson(body)) })
  const verified = await parseSandboxSourcePackage(candidate)
  if (!verified) throw new Error('sandbox_source_package_self_verification_failed')
  const fingerprintAtEnd = computeAuthoredSourceFingerprint(
    workspaceRoot,
    options.implementationBaseline,
    trustedGit,
  )
  if (!sameAuthoredSource(fingerprintAtStart, fingerprintAtEnd)) throw new Error('sandbox_source_changed_during_packaging')
  return verified
}

function readStableFile(absolutePath: string, before: fs.BigIntStats): Buffer {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!sameStableFile(before, opened)) throw new Error('sandbox_source_file_changed')
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (read === 0) throw new Error('sandbox_source_file_short_read')
      offset += read
    }
    if (!sameStableFile(opened, fs.fstatSync(descriptor, { bigint: true }))) {
      throw new Error('sandbox_source_file_changed')
    }
    return bytes
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

async function missingEntry(relativePath: string): Promise<SandboxSourceEntry> {
  return Object.freeze({
    path: relativePath,
    kind: 'missing',
    mode: 'missing',
    size: 0,
    sha256: await sha256Hex(new Uint8Array()),
    contentBase64: '',
  })
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

function decodePath(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new Error('sandbox_source_path_not_utf8')
  }
}

function excluded(value: Buffer): boolean {
  const relativePath = new TextDecoder().decode(value).replaceAll('\\', '/')
  return EXCLUDED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
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

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
