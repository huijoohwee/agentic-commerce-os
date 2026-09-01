export type ConflictResolution = Readonly<{
  path: string
  originalBytes: string
  resolvedBytes: string
}>

export type ConflictOutcome = Readonly<{
  changedPaths: readonly string[]
  resolutions: readonly ConflictResolution[]
  unresolved: readonly Readonly<{ path: string; reason: 'out-of-write-set' }>[]
}>

export function resolveConflicts(
  conflicts: readonly ConflictResolution[],
  declaredWriteSet: readonly string[],
): ConflictOutcome {
  const resolutions: ConflictResolution[] = []
  const unresolved: { path: string; reason: 'out-of-write-set' }[] = []
  for (const conflict of conflicts) {
    if (!pathCovered(conflict.path, declaredWriteSet)) {
      unresolved.push(Object.freeze({ path: conflict.path, reason: 'out-of-write-set' }))
      continue
    }
    if (conflict.originalBytes !== conflict.resolvedBytes) resolutions.push(Object.freeze(conflict))
  }
  return Object.freeze({
    changedPaths: Object.freeze(resolutions.map(({ path }) => path).sort()),
    resolutions: Object.freeze(resolutions),
    unresolved: Object.freeze(unresolved),
  })
}

export function pathCovered(path: string, declaredWriteSet: readonly string[]): boolean {
  return declaredWriteSet.some((entry) => {
    const normalized = entry.endsWith('/') ? entry : `${entry}/`
    return path === entry || path.startsWith(normalized)
  })
}
