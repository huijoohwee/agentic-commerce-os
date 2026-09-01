import { canonicalJson, sha256Hex } from './digest'
import { isRecord } from './http'

export const THEME_MANIFEST_MAX_BYTES = 65_536
const MAXIMUM_TEXT_LENGTH = 280
const MAXIMUM_CATALOG_SCOPE = 500
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const COLOR_PATTERN = /^#[0-9a-f]{6}$/u
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u

export type ThemeManifest = Readonly<{
  merchantId: string
  palette: Readonly<{
    ink: string
    muted: string
    line: string
    panel: string
    accent: string
    background: string
  }>
  logo: Readonly<{ href: string | null; alt: string }>
  copy: Readonly<{ brand: string; headline: string; subhead: string; footer: string }>
  catalogScope: readonly string[]
  locale: string
}>

export type ThemeViolation = Readonly<{ field: string; reason: string }>
export type ThemeManifestVerdict =
  | Readonly<{
    ok: true
    manifest: ThemeManifest
    defaultedFields: readonly string[]
    digest: string
  }>
  | Readonly<{ ok: false; violations: readonly ThemeViolation[] }>

export const THEME_MANIFEST_DEFAULTS: ThemeManifest = Object.freeze({
  merchantId: 'operator',
  palette: Object.freeze({
    ink: '#f3f0e8',
    muted: '#a9b2aa',
    line: '#34443a',
    panel: '#172019',
    accent: '#c6f36b',
    background: '#101713',
  }),
  logo: Object.freeze({ href: null, alt: 'Agentic Commerce OS' }),
  copy: Object.freeze({
    brand: 'AC/OS',
    headline: 'Agents discover. Humans decide.',
    subhead: 'A local-first control surface for agent-native discovery, guarded checkout, and evidence-bound settlement.',
    footer: 'Agentic Commerce OS · browser shell',
  }),
  catalogScope: Object.freeze(['agentic-commerce']),
  locale: 'en-US',
})

const TOP_LEVEL_FIELDS = new Set(['merchantId', 'palette', 'logo', 'copy', 'catalogScope', 'locale'])
const PALETTE_FIELDS = ['ink', 'muted', 'line', 'panel', 'accent', 'background'] as const
const COPY_FIELDS = ['brand', 'headline', 'subhead', 'footer'] as const
const LOGO_FIELDS = ['href', 'alt'] as const

export async function validateThemeManifest(value: unknown): Promise<ThemeManifestVerdict> {
  const violations: ThemeViolation[] = []
  if (!isRecord(value)) return rejected([{ field: '$', reason: 'must be an object' }])
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    return rejected([{ field: '$', reason: 'must be JSON serializable' }])
  }
  if (new TextEncoder().encode(encoded).byteLength > THEME_MANIFEST_MAX_BYTES) {
    violations.push({ field: '$', reason: `must not exceed ${THEME_MANIFEST_MAX_BYTES} bytes` })
  }
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, '', violations)

  const merchantId = readIdentifier(value.merchantId, 'merchantId', violations)
  const catalogScope = readCatalogScope(value.catalogScope, violations)
  const defaultedFields: string[] = []
  const palette = readPalette(value.palette, defaultedFields, violations)
  const logo = readLogo(value.logo, defaultedFields, violations)
  const copy = readCopy(value.copy, defaultedFields, violations)
  const locale = readLocale(value.locale, defaultedFields, violations)
  if (violations.length > 0 || !merchantId || !catalogScope || !palette || !logo || !copy || !locale) {
    return rejected(violations)
  }
  const manifest: ThemeManifest = Object.freeze({
    merchantId,
    palette,
    logo,
    copy,
    catalogScope,
    locale,
  })
  return Object.freeze({
    ok: true,
    manifest,
    defaultedFields: Object.freeze(defaultedFields.sort()),
    digest: await sha256Hex(serializeThemeManifest(manifest)),
  })
}

export function serializeThemeManifest(manifest: ThemeManifest): string {
  return canonicalJson(manifest)
}

function readPalette(
  value: unknown,
  defaulted: string[],
  violations: ThemeViolation[],
): ThemeManifest['palette'] | null {
  if (value !== undefined && !isRecord(value)) {
    violations.push({ field: 'palette', reason: 'must be an object' })
    return null
  }
  const source = isRecord(value) ? value : {}
  rejectUnknownFields(source, new Set(PALETTE_FIELDS), 'palette.', violations)
  const resolved = Object.fromEntries(PALETTE_FIELDS.map((field) => {
    if (source[field] === undefined) {
      defaulted.push(`palette.${field}`)
      return [field, THEME_MANIFEST_DEFAULTS.palette[field]]
    }
    const entry = source[field]
    if (typeof entry !== 'string' || !COLOR_PATTERN.test(entry)) {
      violations.push({ field: `palette.${field}`, reason: 'must be a lowercase six-digit hex color' })
      return [field, THEME_MANIFEST_DEFAULTS.palette[field]]
    }
    return [field, entry]
  })) as Record<(typeof PALETTE_FIELDS)[number], string>
  return Object.freeze(resolved)
}

function readLogo(
  value: unknown,
  defaulted: string[],
  violations: ThemeViolation[],
): ThemeManifest['logo'] | null {
  if (value !== undefined && !isRecord(value)) {
    violations.push({ field: 'logo', reason: 'must be an object' })
    return null
  }
  const source = isRecord(value) ? value : {}
  rejectUnknownFields(source, new Set(LOGO_FIELDS), 'logo.', violations)
  let href = THEME_MANIFEST_DEFAULTS.logo.href
  if (source.href === undefined) defaulted.push('logo.href')
  else if (source.href === null) href = null
  else if (typeof source.href === 'string'
    && source.href.length <= MAXIMUM_TEXT_LENGTH
    && validateThemeAssetUrl(source.href)) href = source.href
  else violations.push({ field: 'logo.href', reason: 'must be null or a bounded HTTPS URL' })
  const alt = readOptionalText(source.alt, 'logo.alt', THEME_MANIFEST_DEFAULTS.logo.alt, defaulted, violations)
  return Object.freeze({ href, alt })
}

function readCopy(
  value: unknown,
  defaulted: string[],
  violations: ThemeViolation[],
): ThemeManifest['copy'] | null {
  if (value !== undefined && !isRecord(value)) {
    violations.push({ field: 'copy', reason: 'must be an object' })
    return null
  }
  const source = isRecord(value) ? value : {}
  rejectUnknownFields(source, new Set(COPY_FIELDS), 'copy.', violations)
  return Object.freeze({
    brand: readOptionalText(source.brand, 'copy.brand', THEME_MANIFEST_DEFAULTS.copy.brand, defaulted, violations),
    headline: readOptionalText(source.headline, 'copy.headline', THEME_MANIFEST_DEFAULTS.copy.headline, defaulted, violations),
    subhead: readOptionalText(source.subhead, 'copy.subhead', THEME_MANIFEST_DEFAULTS.copy.subhead, defaulted, violations),
    footer: readOptionalText(source.footer, 'copy.footer', THEME_MANIFEST_DEFAULTS.copy.footer, defaulted, violations),
  })
}

function readLocale(value: unknown, defaulted: string[], violations: ThemeViolation[]): string {
  if (value === undefined) {
    defaulted.push('locale')
    return THEME_MANIFEST_DEFAULTS.locale
  }
  if (typeof value !== 'string' || value.length > 35 || !LOCALE_PATTERN.test(value)) {
    violations.push({ field: 'locale', reason: 'must be a bounded BCP-47 language tag' })
    return THEME_MANIFEST_DEFAULTS.locale
  }
  return value
}

function readCatalogScope(value: unknown, violations: ThemeViolation[]): readonly string[] | null {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAXIMUM_CATALOG_SCOPE) {
    violations.push({ field: 'catalogScope', reason: 'must contain between 1 and 500 agent identifiers' })
    return null
  }
  const result: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !IDENTIFIER_PATTERN.test(entry)) {
      violations.push({ field: `catalogScope[${index}]`, reason: 'must be a bounded agent identifier' })
      continue
    }
    result.push(entry)
  }
  if (new Set(result).size !== result.length) {
    violations.push({ field: 'catalogScope', reason: 'must not contain duplicate agent identifiers' })
  }
  return Object.freeze(result)
}

function readIdentifier(value: unknown, field: string, violations: ThemeViolation[]): string | null {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    violations.push({ field, reason: 'must be a bounded identifier' })
    return null
  }
  return value
}

function readOptionalText(
  value: unknown,
  field: string,
  fallback: string,
  defaulted: string[],
  violations: ThemeViolation[],
): string {
  if (value === undefined) {
    defaulted.push(field)
    return fallback
  }
  if (typeof value !== 'string' || value.length > MAXIMUM_TEXT_LENGTH) {
    violations.push({ field, reason: `must be text no longer than ${MAXIMUM_TEXT_LENGTH} characters` })
    return fallback
  }
  return value
}

function rejectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
  violations: ThemeViolation[],
): void {
  for (const field of Object.keys(value).filter((entry) => !allowed.has(entry)).sort()) {
    violations.push({ field: `${prefix}${field}`, reason: 'is not supported' })
  }
}

export function validateThemeAssetUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.port === ''
      && parsed.hash === ''
      && !isLocalHostname(hostname)
      && !isIpLiteral(hostname)
  } catch {
    return false
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
}

function isIpLiteral(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return true
  }
  return hostname.includes(':')
}

function rejected(violations: readonly ThemeViolation[]): ThemeManifestVerdict {
  return Object.freeze({
    ok: false,
    violations: Object.freeze([...violations]
      .sort((left, right) => left.field.localeCompare(right.field) || left.reason.localeCompare(right.reason))
      .map((entry) => Object.freeze(entry))),
  })
}
