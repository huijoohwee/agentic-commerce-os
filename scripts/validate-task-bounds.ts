import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export type TaskBounds = Readonly<{
  taskId: string
  namedCheck: string
  tokenCeiling: number
  iterationCeiling: number
  wallClockMinutes: number
  contextCeiling: number
  circuitBreaker: string
}>

export type TaskBoundsVerdict = Readonly<{
  ok: boolean
  taskCount: number
  boundsCount: number
  findings: readonly string[]
}>

const TASK_PATTERN = /^  - \[ \]\*?\s+(\d+(?:\.\d+)+)\s+/u
const BOUNDS_PATTERN = /_Bounds: check `([^`]+)` · tokens (\d+) · iterations (\d+) · wall-clock (\d+) · context (\d+) · breaker: (.+)_/u

export function parseTaskBounds(markdown: string): Readonly<{
  tasks: readonly string[]
  bounds: readonly TaskBounds[]
  findings: readonly string[]
}> {
  const tasks: string[] = []
  const bounds: TaskBounds[] = []
  const findings: string[] = []
  let currentTaskId: string | null = null
  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    const task = line.match(TASK_PATTERN)
    if (task?.[1]) {
      currentTaskId = task[1]
      tasks.push(currentTaskId)
      continue
    }
    if (!/^\s+- _Bounds:/u.test(line)) continue
    const match = line.match(BOUNDS_PATTERN)
    if (!currentTaskId) {
      findings.push(`line ${index + 1}: bounds have no leaf task`)
      continue
    }
    if (!match) {
      findings.push(`task ${currentTaskId}: bounds do not match the required exact form`)
      continue
    }
    const [, namedCheck = '', token = '0', iteration = '0', wallClock = '0', context = '0', breaker = ''] = match
    bounds.push(Object.freeze({
      taskId: currentTaskId,
      namedCheck,
      tokenCeiling: Number(token),
      iterationCeiling: Number(iteration),
      wallClockMinutes: Number(wallClock),
      contextCeiling: Number(context),
      circuitBreaker: breaker,
    }))
    currentTaskId = null
  }
  return Object.freeze({ tasks: Object.freeze(tasks), bounds: Object.freeze(bounds), findings: Object.freeze(findings) })
}

export function validateTaskBounds(markdown: string): TaskBoundsVerdict {
  const parsed = parseTaskBounds(markdown)
  const findings = [...parsed.findings]
  const counts = new Map<string, number>()
  for (const bound of parsed.bounds) {
    counts.set(bound.taskId, (counts.get(bound.taskId) ?? 0) + 1)
    if (!bound.namedCheck.trim()) findings.push(`task ${bound.taskId}: namedCheck is empty`)
    for (const key of ['tokenCeiling', 'iterationCeiling', 'wallClockMinutes', 'contextCeiling'] as const) {
      if (!Number.isInteger(bound[key]) || bound[key] < 1) findings.push(`task ${bound.taskId}: ${key} is not positive`)
    }
    if (!bound.circuitBreaker.trim()) findings.push(`task ${bound.taskId}: circuitBreaker is empty`)
  }
  for (const taskId of parsed.tasks) {
    const count = counts.get(taskId) ?? 0
    if (count !== 1) findings.push(`task ${taskId}: expected one bounds record, observed ${count}`)
  }
  return Object.freeze({
    ok: findings.length === 0,
    taskCount: parsed.tasks.length,
    boundsCount: parsed.bounds.length,
    findings: Object.freeze(findings.sort()),
  })
}

export function resolveWorkspacePath(requestedPath: string, startDirectory = process.cwd()): string | null {
  if (path.isAbsolute(requestedPath)) return fs.existsSync(requestedPath) ? requestedPath : null
  let cursor = path.resolve(startDirectory)
  while (true) {
    const candidate = path.join(cursor, requestedPath)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function requestedTasksPath(): string {
  const argument = process.argv.slice(2).find((value) => value.startsWith('--tasks='))
  return argument?.slice('--tasks='.length) ?? '.kiro/specs/agentic-graph-commerce-platform/tasks.md'
}

export type TaskCheckGroup = Readonly<{
  namedCheck: string
  taskIds: readonly string[]
}>

export type BoundsSnapshot = Readonly<{
  schema: string
  source: string
  sourceSha256: string
  taskCount: number
  boundsCount: number
  findingCount: number
  namedCheckGroups: readonly TaskCheckGroup[]
}>

function snapshotPath(): string | null {
  return process.argv.slice(2).find((value) => value.startsWith('--snapshot='))?.slice('--snapshot='.length) ?? null
}

export function parseBoundsSnapshot(value: unknown): BoundsSnapshot | null {
  if (!isRecord(value) || value.schema !== 'agentic-commerce-task-bounds-snapshot/v2') return null
  if (typeof value.source !== 'string' || !/^[0-9a-f]{64}$/u.test(String(value.sourceSha256))) return null
  if (!Number.isInteger(value.taskCount) || !Number.isInteger(value.boundsCount) || value.findingCount !== 0) return null
  if (!Array.isArray(value.namedCheckGroups)) return null
  const groups: TaskCheckGroup[] = []
  const observedTaskIds = new Set<string>()
  for (const candidate of value.namedCheckGroups) {
    if (!isRecord(candidate) || typeof candidate.namedCheck !== 'string' || !candidate.namedCheck.trim()) return null
    if (!Array.isArray(candidate.taskIds) || candidate.taskIds.length === 0) return null
    const taskIds: string[] = []
    for (const taskId of candidate.taskIds) {
      if (typeof taskId !== 'string' || !/^\d+\.\d+$/u.test(taskId) || observedTaskIds.has(taskId)) return null
      observedTaskIds.add(taskId)
      taskIds.push(taskId)
    }
    groups.push(Object.freeze({ namedCheck: candidate.namedCheck, taskIds: Object.freeze(taskIds) }))
  }
  if (observedTaskIds.size !== value.taskCount || value.taskCount !== value.boundsCount) return null
  return Object.freeze({
    schema: value.schema,
    source: value.source,
    sourceSha256: String(value.sourceSha256),
    taskCount: Number(value.taskCount),
    boundsCount: Number(value.boundsCount),
    findingCount: 0,
    namedCheckGroups: Object.freeze(groups),
  })
}

export function namedCheckForTask(snapshot: BoundsSnapshot, taskId: string): string | null {
  return snapshot.namedCheckGroups.find(({ taskIds }) => taskIds.includes(taskId))?.namedCheck ?? null
}

function readSnapshot(requestedPath: string | null): BoundsSnapshot | null {
  if (!requestedPath) return null
  const resolved = resolveWorkspacePath(requestedPath)
  if (!resolved) return null
  return parseBoundsSnapshot(JSON.parse(fs.readFileSync(resolved, 'utf8')))
}

function main(): void {
  const requested = requestedTasksPath()
  const resolved = resolveWorkspacePath(requested)
  const snapshot = readSnapshot(snapshotPath())
  if (!resolved) {
    const ok = Boolean(snapshot && snapshot.source === requested)
    process.stdout.write(`${JSON.stringify({
      ok,
      code: ok ? 'portable_snapshot_validated' : 'tasks_not_found',
      requested,
      sourceAvailable: false,
      snapshotValidated: ok,
      taskCount: snapshot?.taskCount ?? 0,
      boundsCount: snapshot?.boundsCount ?? 0,
    })}\n`)
    if (!ok) process.exitCode = 1
    return
  }
  const schema = JSON.parse(fs.readFileSync(new URL('../config/task-bounds.schema.json', import.meta.url), 'utf8')) as {
    required?: unknown
  }
  const verdict = validateTaskBounds(fs.readFileSync(resolved, 'utf8'))
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
  const snapshotChecksMatch = snapshot ? snapshotMatchesBounds(snapshot, verdict.ok ? parseTaskBounds(fs.readFileSync(resolved, 'utf8')).bounds : []) : true
  const snapshotMatches = !snapshot || (
    snapshot.source === requested
    && snapshot.sourceSha256 === sourceSha256
    && snapshot.taskCount === verdict.taskCount
    && snapshot.boundsCount === verdict.boundsCount
    && snapshot.findingCount === verdict.findings.length
    && snapshotChecksMatch
  )
  const requiredFieldCount = Array.isArray(schema.required) ? schema.required.length : 0
  const output = {
    ...verdict,
    ok: verdict.ok && snapshotMatches,
    requiredFieldCount,
    tasks: requested,
    sourceAvailable: true,
    sourceSha256,
    snapshotValidated: Boolean(snapshot && snapshotMatches),
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
  if (!verdict.ok || !snapshotMatches || requiredFieldCount !== 7) process.exitCode = 1
}

function snapshotMatchesBounds(snapshot: BoundsSnapshot, bounds: readonly TaskBounds[]): boolean {
  if (bounds.length !== snapshot.boundsCount) return false
  return bounds.every((bound) => namedCheckForTask(snapshot, bound.taskId) === bound.namedCheck)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
