import { createHash } from 'node:crypto'

export type CheckScriptClosure = Readonly<{
  rootScript: string
  scripts: Readonly<Record<string, string>>
  sha256: string
}>

export function readCheckScriptClosure(packageDocument: unknown, rootScript: string): CheckScriptClosure | null {
  if (!record(packageDocument) || !record(packageDocument.scripts) || !scriptName(rootScript)) return null
  const scripts = packageDocument.scripts
  const discovered = new Map<string, string>()
  const pending = [rootScript]
  while (pending.length > 0) {
    const name = pending.pop() ?? ''
    if (discovered.has(name)) continue
    const command = scripts[name]
    if (typeof command !== 'string' || command.length < 1 || command.length > 65_536) return null
    discovered.set(name, command)
    const dependencies = npmRunDependencies(command)
    if (!dependencies) return null
    for (const dependency of dependencies) {
      if (!discovered.has(dependency)) pending.push(dependency)
    }
  }
  const sortedScripts = Object.freeze(Object.fromEntries([...discovered].sort(([left], [right]) => (
    left.localeCompare(right, 'en')
  ))))
  const canonical = JSON.stringify({ rootScript, scripts: sortedScripts })
  return Object.freeze({
    rootScript,
    scripts: sortedScripts,
    sha256: createHash('sha256').update(canonical).digest('hex'),
  })
}

function npmRunDependencies(command: string): readonly string[] | null {
  const dependencies = [...command.matchAll(/(?:^|[\s;&|()])npm\s+run(?:-script)?\s+([A-Za-z0-9][A-Za-z0-9:._-]{0,127})/gu)]
    .map((match) => match[1] ?? '')
  const npmRunMentions = command.match(/npm\s+run(?:-script)?\b/gu)?.length ?? 0
  return npmRunMentions === dependencies.length ? Object.freeze([...new Set(dependencies)]) : null
}

function scriptName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
