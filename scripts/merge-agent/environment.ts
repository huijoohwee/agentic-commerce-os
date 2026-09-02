export type CommandEnvironment = Readonly<Record<string, string | undefined>>

const COMMON_NAMES = Object.freeze([
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'WINDIR',
])
const READ_ONLY_GITHUB_NAMES = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN'])

export function commandEnvironment(
  source: CommandEnvironment,
  mode: 'observation' | 'mutation',
): CommandEnvironment {
  const names = mode === 'observation' ? [...COMMON_NAMES, 'HOME', ...READ_ONLY_GITHUB_NAMES] : COMMON_NAMES
  return Object.freeze(copy(source, names))
}

function copy(source: CommandEnvironment, names: readonly string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string' && !value.includes('\0')) result[name] = value
  }
  return result
}
