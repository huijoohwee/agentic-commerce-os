export const SANDBOX_PROVISION_HARNESS_SOURCE = String.raw`
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const PACKAGE_SCHEMA = 'agentic-commerce-sandbox-source-package/v1'
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 4096

const sourcePath = requiredEnv('AG_SANDBOX_SOURCE_PACKAGE_PATH')
const workspace = requiredEnv('AG_SANDBOX_WORKSPACE')
const artifactPath = requiredEnv('AG_SANDBOX_INSPECTION_PATH')
const mode = requiredEnv('AG_SANDBOX_PROOF_MODE')

if (mode === 'extract') extract()
else if (mode === 'inspect') inspect()
else fail('sandbox_proof_mode_invalid')

function extract() {
  const packageBytes = stableRead(sourcePath, 8 * 1024 * 1024)
  const value = JSON.parse(packageBytes.toString('utf8'))
  exactRecord(value, ['schema', 'sourceFingerprint', 'entries', 'totalFileBytes', 'packageDigest'])
  if (value.schema !== PACKAGE_SCHEMA || !digest(value.packageDigest) || !Array.isArray(value.entries)
    || value.entries.length < 2 || value.entries.length > MAX_ENTRIES) fail('sandbox_source_package_invalid')
  const fingerprint = value.sourceFingerprint
  exactRecord(fingerprint, [
    'schema', 'implementationBaseline', 'headRevision', 'authoredFileCount', 'authoredTreeSha256', 'fingerprintDigest',
  ])
  const fingerprintBody = {
    schema: fingerprint.schema,
    implementationBaseline: fingerprint.implementationBaseline,
    headRevision: fingerprint.headRevision,
    authoredFileCount: fingerprint.authoredFileCount,
    authoredTreeSha256: fingerprint.authoredTreeSha256,
  }
  if (fingerprint.schema !== 'agentic-commerce-authored-source-fingerprint/v1'
    || sha256(canonicalJson(fingerprintBody)) !== fingerprint.fingerprintDigest) fail('sandbox_source_fingerprint_invalid')

  const entries = []
  let totalBytes = 0
  let priorPath = null
  for (const candidate of value.entries) {
    const entry = validateEntry(candidate)
    if (priorPath !== null && Buffer.compare(priorPath, Buffer.from(entry.path)) >= 0) fail('sandbox_source_order_invalid')
    priorPath = Buffer.from(entry.path)
    totalBytes += entry.size
    if (totalBytes > MAX_SOURCE_BYTES) fail('sandbox_source_size_exceeded')
    entries.push(entry)
  }
  if (totalBytes !== value.totalFileBytes || entries.length !== fingerprint.authoredFileCount
    || !entries.some((entry) => entry.path === 'package.json' && entry.kind === 'file')
    || !entries.some((entry) => entry.path === 'package-lock.json' && entry.kind === 'file')) {
    fail('sandbox_source_completeness_invalid')
  }
  if (sourceTreeSha256(entries) !== fingerprint.authoredTreeSha256) fail('sandbox_source_tree_invalid')
  const body = {
    schema: PACKAGE_SCHEMA,
    sourceFingerprint: fingerprint,
    entries,
    totalFileBytes: totalBytes,
  }
  if (sha256(canonicalJson(body)) !== value.packageDigest) fail('sandbox_source_package_digest_invalid')

  fs.mkdirSync(workspace, { recursive: false, mode: 0o700 })
  const root = fs.realpathSync(workspace)
  for (const entry of entries) {
    if (entry.kind === 'missing') continue
    const target = path.resolve(root, entry.path)
    if (!within(root, target)) fail('sandbox_source_target_escape')
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try {
      const bytes = Buffer.from(entry.contentBase64, 'base64')
      let offset = 0
      while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644)
  }
  writeArtifact({
    ok: true,
    mode,
    packageDigest: value.packageDigest,
    sourceFingerprintDigest: fingerprint.fingerprintDigest,
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    totalBytes,
  })
}

function inspect() {
  const root = fs.realpathSync(workspace)
  if (!fs.statSync(root).isDirectory()) fail('sandbox_workspace_invalid')
  const manifest = JSON.parse(stableRead(path.join(root, 'package.json'), MAX_ENTRY_BYTES).toString('utf8'))
  if (manifest.devDependencies?.['@playwright/test'] !== '1.62.1') fail('sandbox_playwright_pin_invalid')
  const require = createRequire(path.join(root, 'package.json'))
  const playwrightVersion = require(path.join(root, 'node_modules/@playwright/test/package.json')).version
  if (playwrightVersion !== '1.62.1') fail('sandbox_playwright_runtime_invalid')
  const { chromium } = require(path.join(root, 'node_modules/playwright/index.js'))
  const executable = fs.realpathSync(chromium.executablePath())
  const executableStat = fs.statSync(executable)
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) fail('sandbox_chromium_executable_invalid')
  const versionText = execFileSync(executable, ['--version'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }).trim()
  const match = /^(?:Chromium|Google Chrome for Testing|HeadlessChrome)\s+(\d+)(?:\.|\s|$)/u.exec(versionText)
  if (!match) fail('sandbox_chromium_version_invalid')
  const boundary = JSON.parse(stableRead(
    path.join(root, 'docs/deploy-boundary-register.json'), MAX_ENTRY_BYTES,
  ).toString('utf8'))
  const supportedBrowsers = boundary.webMcp?.supportedBrowsers
  if (!Array.isArray(supportedBrowsers) || supportedBrowsers.length < 1) fail('sandbox_browser_support_invalid')
  const support = supportedBrowsers.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.minimumVersion)
      || entry.minimumVersion < 1) fail('sandbox_browser_support_invalid')
    return { name: entry.name, minimumVersion: entry.minimumVersion }
  }).sort((left, right) => left.name.localeCompare(right.name))
  if (new Set(support.map(({ name }) => name)).size !== support.length) fail('sandbox_browser_support_invalid')
  writeArtifact({
    ok: true,
    mode,
    nodeVersion: process.versions.node,
    playwrightVersion,
    browser: {
      engine: 'Chromium',
      version: Number(match[1]),
      executableSha256: fileSha256(executable),
      supportedBrowsers: support,
    },
  })
}

function validateEntry(value) {
  exactRecord(value, ['path', 'kind', 'mode', 'size', 'sha256', 'contentBase64'])
  if (!validPath(value.path) || (value.kind !== 'file' && value.kind !== 'missing')
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_ENTRY_BYTES
    || !digest(value.sha256) || typeof value.contentBase64 !== 'string') fail('sandbox_source_entry_invalid')
  if ((value.kind === 'file' && value.mode !== '100644' && value.mode !== '100755')
    || (value.kind === 'missing' && value.mode !== 'missing')) fail('sandbox_source_entry_invalid')
  const bytes = Buffer.from(value.contentBase64, 'base64')
  if (bytes.toString('base64') !== value.contentBase64 || bytes.length !== value.size
    || (value.kind === 'missing' && bytes.length !== 0) || sha256(bytes) !== value.sha256) {
    fail('sandbox_source_entry_invalid')
  }
  return Object.freeze({
    path: value.path,
    kind: value.kind,
    mode: value.mode,
    size: value.size,
    sha256: value.sha256,
    contentBase64: value.contentBase64,
  })
}

function validPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || value.includes('\0')
    || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')
    || segments.includes('.git') || segments.includes('node_modules')
    || value === 'docs/evidence-verdicts' || value.startsWith('docs/evidence-verdicts/')) return false
  const basename = segments.at(-1).toLowerCase()
  if (basename === '.env' || basename === '.dev.vars' || basename === '.npmrc'
    || basename === 'id_rsa' || basename === 'id_ed25519' || /\.(key|p12|pfx|pem)$/u.test(basename)) return false
  return Buffer.from(value, 'utf8').toString('utf8') === value
}

function sourceTreeSha256(entries) {
  const hash = crypto.createHash('sha256')
  for (const entry of entries) {
    hash.update(frame(Buffer.from(entry.path)))
    hash.update(frame(Buffer.from(entry.mode)))
    hash.update(frame(Buffer.from(entry.kind)))
    hash.update(frame(entry.kind === 'missing' ? Buffer.alloc(0) : Buffer.from(entry.contentBase64, 'base64')))
  }
  return hash.digest('hex')
}

function stableRead(requested, maximumBytes) {
  const before = fs.lstatSync(requested, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) fail('sandbox_file_invalid')
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!sameFile(before, opened)) fail('sandbox_file_changed')
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (read === 0) fail('sandbox_file_short_read')
      offset += read
    }
    if (!sameFile(opened, fs.fstatSync(descriptor, { bigint: true }))) fail('sandbox_file_changed')
    return bytes
  } finally {
    fs.closeSync(descriptor)
  }
}

function fileSha256(requested) {
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeArtifact(value) {
  fs.writeFileSync(artifactPath, canonicalJson(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) fail('canonical_json_invalid')
  return encoded
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('sandbox_record_invalid')
}

function frame(value) {
  return Buffer.concat([Buffer.from(String(value.length) + ':'), value, Buffer.from(';')])
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) fail('sandbox_environment_incomplete')
  return value
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function fail(code) {
  throw new Error(code)
}
`
