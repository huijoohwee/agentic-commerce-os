import fs from 'node:fs'
import path from 'node:path'

export const AUTHORED_LINE_CEILING = 600

export type LimitFinding = Readonly<{
  path: string
  line: number | null
  finding: 'line-ceiling-exceeded' | 'absolute-developer-path' | 'credential-value' | 'account-identifier'
  detail: string
}>

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.wrangler', '.recovery', 'coverage', 'dist', 'node_modules', 'playwright-report', 'test-results',
])
const EXCLUDED_FILES = new Set(['.git', 'package-lock.json'])
const TEXT_EXTENSIONS = new Set([
  '', '.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.toml', '.ts', '.tsx', '.yaml', '.yml',
])

export function validateAuthoredLimits(rootDirectory: string): Readonly<{
  ok: boolean
  scannedFileCount: number
  findings: readonly LimitFinding[]
}> {
  const findings: LimitFinding[] = []
  const files = authoredFiles(rootDirectory)
  for (const relativePath of files) {
    const text = fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8')
    const lines = text.split(/\r?\n/u)
    const authoredLineCount = text.endsWith('\n') ? lines.length - 1 : lines.length
    if (authoredLineCount > AUTHORED_LINE_CEILING) {
      findings.push(finding(relativePath, null, 'line-ceiling-exceeded', `authored line count exceeds ${AUTHORED_LINE_CEILING}`))
    }
    for (const [index, line] of lines.entries()) scanLine(relativePath, index + 1, line, findings)
  }
  return Object.freeze({
    ok: findings.length === 0,
    scannedFileCount: files.length,
    findings: Object.freeze(findings.sort(compareFindings)),
  })
}

function authoredFiles(rootDirectory: string): readonly string[] {
  const files: string[] = []
  const visit = (relativeDirectory: string): void => {
    const directory = path.join(rootDirectory, relativeDirectory)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory.replaceAll(path.sep, '/'), entry.name)
        .replace(/^\.\//u, '')
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && relativePath !== 'src/generated') visit(relativePath)
        continue
      }
      if (!entry.isFile() || EXCLUDED_FILES.has(relativePath)) continue
      if (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name.startsWith('.')) files.push(relativePath)
    }
  }
  visit('')
  return Object.freeze(files.sort())
}

function scanLine(pathName: string, lineNumber: number, line: string, findings: LimitFinding[]): void {
  const userRootPattern = new RegExp(`(?:^|["'=\\s])${escape('/')}(?:Users|home)${escape('/')}[^/\\s"']+${escape('/')}`, 'u')
  const windowsUserPattern = new RegExp(`(?:^|["'=\\s])[A-Za-z]:${escape('\\')}Users${escape('\\')}[^\\\\s"']+${escape('\\')}`, 'u')
  if (userRootPattern.test(line) || windowsUserPattern.test(line)) {
    findings.push(finding(pathName, lineNumber, 'absolute-developer-path', 'developer home-directory pattern'))
  }
  const credentialAssignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|password|secret)\b\s*[:=]\s*["'][^"'${}]{8,}["']/iu
  const bearerValue = /\bauthorization\s*[:=]\s*["']bearer\s+[a-z0-9._~+/=-]{8,}["']/iu
  if (credentialAssignment.test(line) || bearerValue.test(line)) {
    findings.push(finding(pathName, lineNumber, 'credential-value', 'credential-shaped literal assignment'))
  }
  const accountAssignment = /\b(?:account[_-]?id|cloudflare[_-]?account[_-]?id)\b\s*[:=]\s*["'][a-z0-9-]{8,}["']/iu
  if (accountAssignment.test(line)) {
    findings.push(finding(pathName, lineNumber, 'account-identifier', 'account identifier literal assignment'))
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function finding(
  pathName: string,
  line: number | null,
  kind: LimitFinding['finding'],
  detail: string,
): LimitFinding {
  return Object.freeze({ path: pathName, line, finding: kind, detail })
}

function compareFindings(left: LimitFinding, right: LimitFinding): number {
  return left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0)
    || left.finding.localeCompare(right.finding)
}
