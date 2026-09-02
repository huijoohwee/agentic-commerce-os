import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Disposition = 'renamed' | 'externally-owned' | 'historical-record'
type RegisterOccurrence = Readonly<{
  path: string
  line: number
  legacyIdentifier: string
  supersedingIdentifier: string
  disposition: Disposition
  owningSystem?: string
  reason?: string
  preservingArtifact?: string
  readOnly?: boolean
}>
type Registry = Readonly<{
  schema: string
  environmentKeyPrefix: string
  fileScope: Readonly<{ exclude: readonly string[] }>
  matcher: Readonly<{
    boundaryAware: boolean
    caseSensitiveTerms: readonly string[]
    caseInsensitiveTerms: readonly string[]
  }>
  occurrences: readonly RegisterOccurrence[]
}>

export type TerminologyFinding = Readonly<{
  path: string
  line: number
  column: number
  matchedTerm: string
  finding: 'undispositioned' | 'renamed-occurrence-remains' | 'disposition-fields-missing'
}>
export type TerminologyVerdict = Readonly<{
  ok: boolean
  scannedFileCount: number
  matchedOccurrenceCount: number
  dispositionCounts: Readonly<Record<Disposition, number>>
  findings: readonly TerminologyFinding[]
}>

export function validateTerminology(rootDirectory: string): TerminologyVerdict {
  const registry = readRegistry(rootDirectory)
  const findings: TerminologyFinding[] = []
  const counts: Record<Disposition, number> = { renamed: 0, 'externally-owned': 0, 'historical-record': 0 }
  const files = authoredFiles(rootDirectory, registry.fileScope.exclude)
  let matchedOccurrenceCount = 0

  for (const entry of registry.occurrences) {
    counts[entry.disposition] += 1
    if (!dispositionComplete(entry)) {
      findings.push(toFinding(entry, 'disposition-fields-missing'))
    }
  }

  for (const relativePath of files) {
    const lines = fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8').split(/\r?\n/u)
    const entries = registry.occurrences.filter((entry) => entry.path === relativePath)
    const ranges = entries.flatMap((entry) => {
      const line = lines[entry.line - 1]
      if (line === undefined) {
        findings.push(toFinding(entry, 'undispositioned'))
        return []
      }
      const index = line.indexOf(entry.legacyIdentifier)
      if (index < 0) {
        findings.push(toFinding(entry, 'undispositioned'))
        return []
      }
      return [{ entry, line: entry.line, start: index, end: index + entry.legacyIdentifier.length }]
    })
    for (const [lineIndex, line] of lines.entries()) {
      for (const match of matchesInLine(line, registry)) {
        matchedOccurrenceCount += 1
        const owners = ranges.filter((range) => (
          range.line === lineIndex + 1 && match.start >= range.start && match.end <= range.end
        ))
        if (owners.length !== 1) {
          findings.push(Object.freeze({
            path: relativePath,
            line: lineIndex + 1,
            column: match.start + 1,
            matchedTerm: match.term,
            finding: 'undispositioned',
          }))
        } else if (owners[0]?.entry.disposition === 'renamed') {
          findings.push(Object.freeze({
            path: relativePath,
            line: lineIndex + 1,
            column: match.start + 1,
            matchedTerm: match.term,
            finding: 'renamed-occurrence-remains',
          }))
        }
      }
    }
  }

  const ordered = findings.sort((left, right) => (
    left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
  ))
  return Object.freeze({
    ok: ordered.length === 0,
    scannedFileCount: files.length,
    matchedOccurrenceCount,
    dispositionCounts: Object.freeze(counts),
    findings: Object.freeze(ordered),
  })
}

function readRegistry(rootDirectory: string): Registry {
  const value = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'config/terminology-register.json'), 'utf8')) as Registry
  if (value.schema !== 'agentic-graph-terminology-register/v1'
    || value.environmentKeyPrefix !== 'AG_'
    || value.matcher.boundaryAware !== true
    || !Array.isArray(value.occurrences)) throw new Error('Terminology register shape is invalid')
  return value
}

function authoredFiles(rootDirectory: string, exclusions: readonly string[]): readonly string[] {
  const files: string[] = []
  const visit = (relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(path.join(rootDirectory, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory.replaceAll(path.sep, '/'), entry.name).replace(/^\.\//u, '')
      if (excluded(relativePath, exclusions)) continue
      if (entry.isDirectory()) visit(relativePath)
      else if (entry.isFile() && !binaryExtension(relativePath)) files.push(relativePath)
    }
  }
  visit('')
  return Object.freeze(files.sort())
}

function excluded(relativePath: string, exclusions: readonly string[]): boolean {
  return exclusions.some((pattern) => (
    pattern.endsWith('/**')
      ? relativePath === pattern.slice(0, -3) || relativePath.startsWith(`${pattern.slice(0, -3)}/`)
      : relativePath === pattern
  ))
}

function binaryExtension(relativePath: string): boolean {
  return new Set(['.gif', '.ico', '.jpeg', '.jpg', '.png', '.wasm', '.woff', '.woff2']).has(path.extname(relativePath))
}

function matchesInLine(line: string, registry: Registry): readonly Readonly<{
  term: string
  start: number
  end: number
}>[] {
  const found: { term: string; start: number; end: number }[] = []
  for (const term of registry.matcher.caseSensitiveTerms) collectMatches(line, term, false, found)
  for (const term of registry.matcher.caseInsensitiveTerms) collectMatches(line, term, true, found)
  return Object.freeze(found.sort((left, right) => left.start - right.start || left.term.localeCompare(right.term)))
}

function collectMatches(
  line: string,
  term: string,
  insensitive: boolean,
  found: { term: string; start: number; end: number }[],
): void {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, insensitive ? 'giu' : 'gu')
  for (const match of line.matchAll(pattern)) {
    const start = match.index
    found.push({ term: match[0], start, end: start + match[0].length })
  }
}

function dispositionComplete(entry: RegisterOccurrence): boolean {
  if (!entry.supersedingIdentifier) return false
  if (entry.disposition === 'externally-owned') return Boolean(entry.owningSystem && entry.reason)
  if (entry.disposition === 'historical-record') return Boolean(entry.preservingArtifact && entry.readOnly === true)
  return true
}

function toFinding(entry: RegisterOccurrence, kind: TerminologyFinding['finding']): TerminologyFinding {
  return Object.freeze({
    path: entry.path,
    line: entry.line,
    column: 1,
    matchedTerm: entry.legacyIdentifier,
    finding: kind,
  })
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function main(): void {
  const verdict = validateTerminology(process.cwd())
  process.stdout.write(`${JSON.stringify(verdict)}\n`)
  if (!verdict.ok) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
