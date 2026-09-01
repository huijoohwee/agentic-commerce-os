import { validPath } from './observation.ts'

const MAXIMUM_PATCH_BYTES = 1_000_000

export function patchPaths(patch: string): readonly string[] | null {
  if (!patch.endsWith('\n')
    || patch.includes('\0')
    || Buffer.byteLength(patch) > MAXIMUM_PATCH_BYTES
    || /^(?:rename|copy) (?:from|to) /mu.test(patch)
    || /^(?:GIT binary patch|Binary files )/mu.test(patch)) return null
  const paths: string[] = []
  let currentPath: string | null = null
  let oldHeaderSeen = false
  let newHeaderSeen = false
  let oldHeaderIsNull = false
  let newHeaderIsNull = false
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (currentPath && (!oldHeaderSeen || !newHeaderSeen || oldHeaderIsNull && newHeaderIsNull)) return null
      const match = line.match(/^diff --git a\/([^\s]+) b\/([^\s]+)$/u)
      if (!match?.[1] || !match[2] || match[1] !== match[2] || !validPath(match[1])) return null
      currentPath = match[1]
      oldHeaderSeen = false
      newHeaderSeen = false
      oldHeaderIsNull = false
      newHeaderIsNull = false
      inHunk = false
      paths.push(currentPath)
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      if (!currentPath || oldHeaderSeen || !headerMatches(line.slice(4), 'a', currentPath)) return null
      oldHeaderSeen = true
      oldHeaderIsNull = line.slice(4) === '/dev/null'
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      if (!currentPath || !oldHeaderSeen || newHeaderSeen || !headerMatches(line.slice(4), 'b', currentPath)) return null
      newHeaderSeen = true
      newHeaderIsNull = line.slice(4) === '/dev/null'
      continue
    }
    if (line.startsWith('@@ ') || line.startsWith('@@@ ')) {
      if (!oldHeaderSeen || !newHeaderSeen || oldHeaderIsNull && newHeaderIsNull) return null
      inHunk = true
    }
  }
  if (!currentPath || !oldHeaderSeen || !newHeaderSeen
    || oldHeaderIsNull && newHeaderIsNull
    || paths.length < 1 || new Set(paths).size !== paths.length) return null
  return Object.freeze(paths.sort())
}

export function parsePatchNumstat(output: string): readonly string[] | null {
  if (!output.endsWith('\0')) return null
  const paths: string[] = []
  for (const record of output.slice(0, -1).split('\0')) {
    const match = record.match(/^(\d+|-)\t(\d+|-)\t(.+)$/su)
    if (!match?.[1] || !match[2] || !match[3]
      || match[1] === '-' || match[2] === '-'
      || !validPath(match[3])) return null
    paths.push(match[3])
  }
  if (paths.length < 1 || new Set(paths).size !== paths.length) return null
  return Object.freeze(paths.sort())
}

function headerMatches(header: string, prefix: 'a' | 'b', path: string): boolean {
  return header === '/dev/null' || header === `${prefix}/${path}`
}
