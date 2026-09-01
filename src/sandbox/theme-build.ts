import { isRecord } from '../shared/http.js'
import { THEME_MANIFEST_DEFAULTS } from '../shared/theme-manifest.js'
import type { AttemptedCall } from './isolation.js'
import {
  EXECUTABLE_RUNNER_PATH,
  EXECUTABLE_RUNNER_SOURCE,
  EXECUTABLE_TARGET_CONTRACT,
  EXECUTABLE_TARGET_PATH,
  MAXIMUM_EXECUTABLE_TARGET_BYTES,
} from './registration-target.js'
import {
  WEBMCP_SANDBOX_INPUT_CONTRACT,
  WEBMCP_SANDBOX_TARGET_SOURCE,
  readWebMcpSandboxResult,
  type WebMcpSandboxResult,
} from './webmcp-target.js'
import {
  WEBMCP_CLIENT_RUNTIME,
  WEBMCP_CLIENT_RUNTIME_SHA256,
} from '../edge/client/webmcp-runtime.js'

export const THEME_BUILD_CONTRACT = 'agentic-graph-theme-build/v1'
export const THEME_BUILD_ARTIFACT_CONTRACT = 'agentic-graph-theme-artifact/v1'
export const THEME_BUILD_ARTIFACT_PATH = '/tmp/agentic-graph-theme-artifact.json'
export const SANDBOX_INPUT_PATH = '/tmp/agentic-graph-input.json'
export const SANDBOX_HARNESS_PATH = '/tmp/agentic-graph-harness.mjs'

export type ThemeBuildResult =
  | Readonly<{
    status: 'completed'
    contract: typeof THEME_BUILD_CONTRACT
    manifestDigest: string
    artifactDigest: string
    artifactBytes: number
    resolvedCatalogScope: readonly string[]
    defaultedFields: readonly string[]
  }>
  | Readonly<{
    status: 'failed'
    contract: typeof THEME_BUILD_CONTRACT
    code: 'theme_manifest_invalid'
    violations: readonly Readonly<{ field: string; reason: string }>[]
  }>

export type SandboxHarnessOutput = Readonly<{
  ok: boolean
  attemptedCalls: readonly AttemptedCall[]
  buildResult: ThemeBuildResult | null
  surfaceResult: WebMcpSandboxResult | null
  failureReason: SandboxHarnessFailureReason | null
}>

export type SandboxHarnessFailureReason =
  | 'sandbox_executable_target_required'
  | 'sandbox_executable_target_digest_mismatch'
  | 'sandbox_executable_target_load_failed'
  | 'sandbox_tool_execution_failed'
  | 'sandbox_tool_result_invalid'
  | 'sandbox_webmcp_input_invalid'
  | 'sandbox_webmcp_execution_failed'

/**
 * Static source is written into, and executed by, the isolated container. The
 * input path and command are repository-owned constants, so merchant bytes
 * never participate in shell construction.
 */
export const SANDBOX_HARNESS_SOURCE = String.raw`
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const THEME_BUILD_CONTRACT = ${JSON.stringify(THEME_BUILD_CONTRACT)};
const THEME_BUILD_ARTIFACT_CONTRACT = ${JSON.stringify(THEME_BUILD_ARTIFACT_CONTRACT)};
const THEME_BUILD_ARTIFACT_PATH = ${JSON.stringify(THEME_BUILD_ARTIFACT_PATH)};
const EXECUTABLE_RUNNER_PATH = ${JSON.stringify(EXECUTABLE_RUNNER_PATH)};
const EXECUTABLE_RUNNER_SOURCE = ${JSON.stringify(EXECUTABLE_RUNNER_SOURCE)};
const EXECUTABLE_TARGET_CONTRACT = ${JSON.stringify(EXECUTABLE_TARGET_CONTRACT)};
const EXECUTABLE_TARGET_PATH = ${JSON.stringify(EXECUTABLE_TARGET_PATH)};
const MAXIMUM_EXECUTABLE_TARGET_BYTES = ${MAXIMUM_EXECUTABLE_TARGET_BYTES};
const WEBMCP_SANDBOX_INPUT_CONTRACT = ${JSON.stringify(WEBMCP_SANDBOX_INPUT_CONTRACT)};
const WEBMCP_CLIENT_RUNTIME = ${JSON.stringify(WEBMCP_CLIENT_RUNTIME)};
const WEBMCP_CLIENT_RUNTIME_SHA256 = ${JSON.stringify(WEBMCP_CLIENT_RUNTIME_SHA256)};
const WEBMCP_SANDBOX_TARGET_SOURCE = ${JSON.stringify(WEBMCP_SANDBOX_TARGET_SOURCE)};
const DEFAULTS = Object.freeze(${JSON.stringify(THEME_MANIFEST_DEFAULTS)});
const MAXIMUM_MANIFEST_BYTES = 65536;
const MAXIMUM_TEXT_LENGTH = 280;
const MAXIMUM_CATALOG_SCOPE = 500;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/u;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const PALETTE_FIELDS = Object.freeze(['ink', 'muted', 'line', 'panel', 'accent', 'background']);
const COPY_FIELDS = Object.freeze(['brand', 'headline', 'subhead', 'footer']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
  return value;
};
const canonical = value => JSON.stringify(canonicalValue(value));
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const rejectUnknown = (value, allowed, prefix, violations) => {
  for (const field of Object.keys(value).filter(entry => !allowed.has(entry)).sort(compareText)) {
    violations.push({ field: prefix + field, reason: 'is not supported' });
  }
};
const validAssetUrl = value => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const octets = hostname.split('.').map(Number);
    const ipv4 = octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      && parsed.port === '' && parsed.hash === '' && hostname !== 'localhost'
      && !hostname.endsWith('.localhost') && !hostname.endsWith('.local')
      && !hostname.endsWith('.internal') && !ipv4 && !hostname.includes(':');
  } catch {
    return false;
  }
};
const optionalText = (source, field, fallback, defaultedFields, violations) => {
  if (source === undefined) {
    defaultedFields.push(field);
    return fallback;
  }
  if (typeof source !== 'string' || source.length > MAXIMUM_TEXT_LENGTH) {
    violations.push({ field, reason: 'must be text no longer than 280 characters' });
    return fallback;
  }
  return source;
};
const buildTheme = value => {
  const violations = [];
  if (!isRecord(value)) return { status: 'failed', contract: THEME_BUILD_CONTRACT, code: 'theme_manifest_invalid', violations: [{ field: '$', reason: 'must be an object' }] };
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { status: 'failed', contract: THEME_BUILD_CONTRACT, code: 'theme_manifest_invalid', violations: [{ field: '$', reason: 'must be JSON serializable' }] };
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAXIMUM_MANIFEST_BYTES) {
    violations.push({ field: '$', reason: 'must not exceed 65536 bytes' });
  }
  rejectUnknown(value, new Set(['merchantId', 'palette', 'logo', 'copy', 'catalogScope', 'locale']), '', violations);
  const merchantId = typeof value.merchantId === 'string' && IDENTIFIER_PATTERN.test(value.merchantId)
    ? value.merchantId
    : null;
  if (!merchantId) violations.push({ field: 'merchantId', reason: 'must be a bounded identifier' });

  const catalogScope = [];
  if (!Array.isArray(value.catalogScope) || value.catalogScope.length < 1 || value.catalogScope.length > MAXIMUM_CATALOG_SCOPE) {
    violations.push({ field: 'catalogScope', reason: 'must contain between 1 and 500 agent identifiers' });
  } else {
    for (const [index, entry] of value.catalogScope.entries()) {
      if (typeof entry !== 'string' || !IDENTIFIER_PATTERN.test(entry)) {
        violations.push({ field: 'catalogScope[' + index + ']', reason: 'must be a bounded agent identifier' });
      } else catalogScope.push(entry);
    }
    if (new Set(catalogScope).size !== catalogScope.length) {
      violations.push({ field: 'catalogScope', reason: 'must not contain duplicate agent identifiers' });
    }
  }

  const defaultedFields = [];
  const paletteSource = value.palette === undefined ? {} : value.palette;
  if (!isRecord(paletteSource)) violations.push({ field: 'palette', reason: 'must be an object' });
  const paletteRecord = isRecord(paletteSource) ? paletteSource : {};
  rejectUnknown(paletteRecord, new Set(PALETTE_FIELDS), 'palette.', violations);
  const palette = {};
  for (const field of PALETTE_FIELDS) {
    const entry = paletteRecord[field];
    if (entry === undefined) {
      defaultedFields.push('palette.' + field);
      palette[field] = DEFAULTS.palette[field];
    } else if (typeof entry !== 'string' || !COLOR_PATTERN.test(entry)) {
      violations.push({ field: 'palette.' + field, reason: 'must be a lowercase six-digit hex color' });
      palette[field] = DEFAULTS.palette[field];
    } else palette[field] = entry;
  }

  const logoSource = value.logo === undefined ? {} : value.logo;
  if (!isRecord(logoSource)) violations.push({ field: 'logo', reason: 'must be an object' });
  const logoRecord = isRecord(logoSource) ? logoSource : {};
  rejectUnknown(logoRecord, new Set(['href', 'alt']), 'logo.', violations);
  let href = DEFAULTS.logo.href;
  if (logoRecord.href === undefined) defaultedFields.push('logo.href');
  else if (logoRecord.href === null) href = null;
  else if (typeof logoRecord.href === 'string' && logoRecord.href.length <= MAXIMUM_TEXT_LENGTH && validAssetUrl(logoRecord.href)) href = logoRecord.href;
  else violations.push({ field: 'logo.href', reason: 'must be null or a bounded HTTPS URL' });
  const logo = {
    href,
    alt: optionalText(logoRecord.alt, 'logo.alt', DEFAULTS.logo.alt, defaultedFields, violations)
  };

  const copySource = value.copy === undefined ? {} : value.copy;
  if (!isRecord(copySource)) violations.push({ field: 'copy', reason: 'must be an object' });
  const copyRecord = isRecord(copySource) ? copySource : {};
  rejectUnknown(copyRecord, new Set(COPY_FIELDS), 'copy.', violations);
  const copy = Object.fromEntries(COPY_FIELDS.map(field => [
    field,
    optionalText(copyRecord[field], 'copy.' + field, DEFAULTS.copy[field], defaultedFields, violations)
  ]));

  let locale = value.locale;
  if (locale === undefined) {
    defaultedFields.push('locale');
    locale = DEFAULTS.locale;
  } else if (typeof locale !== 'string' || locale.length > 35 || !LOCALE_PATTERN.test(locale)) {
    violations.push({ field: 'locale', reason: 'must be a bounded BCP-47 language tag' });
    locale = DEFAULTS.locale;
  }
  if (violations.length > 0 || !merchantId || catalogScope.length < 1) {
    return {
      status: 'failed',
      contract: THEME_BUILD_CONTRACT,
      code: 'theme_manifest_invalid',
      violations: violations.sort((left, right) => compareText(left.field, right.field) || compareText(left.reason, right.reason))
    };
  }
  const manifest = { merchantId, palette, logo, copy, catalogScope, locale };
  const manifestBytes = canonical(manifest);
  const artifact = canonical({ contract: THEME_BUILD_ARTIFACT_CONTRACT, manifest });
  const artifactPath = process.env.AG_SANDBOX_ARTIFACT_PATH || THEME_BUILD_ARTIFACT_PATH;
  writeFileSync(artifactPath, artifact, { encoding: 'utf8', mode: 0o600 });
  return {
    status: 'completed',
    contract: THEME_BUILD_CONTRACT,
    manifestDigest: digest(manifestBytes),
    artifactDigest: digest(artifact),
    artifactBytes: Buffer.byteLength(artifact, 'utf8'),
    resolvedCatalogScope: catalogScope,
    defaultedFields: defaultedFields.sort(compareText)
  };
};

const registrationFailure = failureReason => ({
  ok: false,
  attemptedCalls: [],
  buildResult: null,
  surfaceResult: null,
  failureReason
});
const runRegistration = async source => {
  const target = source.payload?.executableTarget;
  if (!isRecord(target)
    || target.contract !== EXECUTABLE_TARGET_CONTRACT
    || target.kind !== 'javascript-module'
    || typeof target.source !== 'string'
    || target.source.length < 1
    || Buffer.byteLength(target.source, 'utf8') > MAXIMUM_EXECUTABLE_TARGET_BYTES
    || typeof target.sourceDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(target.sourceDigest)) {
    return registrationFailure('sandbox_executable_target_required');
  }
  if (digest(target.source) !== target.sourceDigest) {
    return registrationFailure('sandbox_executable_target_digest_mismatch');
  }
  const executableTargetPath = process.env.AG_EXECUTABLE_TARGET_PATH || EXECUTABLE_TARGET_PATH;
  const executableRunnerPath = process.env.AG_EXECUTABLE_RUNNER_PATH || EXECUTABLE_RUNNER_PATH;
  const configuredTimeoutMs = Number(process.env.AG_SANDBOX_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs >= 1
    ? Math.min(configuredTimeoutMs, 300000)
    : 300000;
  const deadlineMs = Date.now() + timeoutMs;
  const invoke = request => {
    writeFileSync(executableTargetPath, target.source, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(executableRunnerPath, EXECUTABLE_RUNNER_SOURCE, { encoding: 'utf8', mode: 0o600 });
    const remainingMs = Math.max(1, Math.min(30000, deadlineMs - Date.now()));
    return spawnSync(process.execPath, [executableRunnerPath], {
      input: JSON.stringify({
        ...request,
        sourceDigest: target.sourceDigest,
        targetPath: executableTargetPath
      }),
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: remainingMs
    }).status;
  };
  if (invoke({ mode: 'probe' }) !== 0) {
    return registrationFailure('sandbox_executable_target_load_failed');
  }
  const allowed = new Set(source.declaredAllowlist);
  const calls = Array.isArray(source.payload?.toolCalls) ? source.payload.toolCalls : [];
  const attemptedCalls = [];
  let failureReason = null;
  for (const call of calls) {
    const allowlisted = allowed.has(call.toolId);
    if (!allowlisted) {
      attemptedCalls.push({ toolId: call.toolId, allowlisted: false, outcome: 'refused' });
      break;
    }
    const status = invoke({ mode: 'call', toolId: call.toolId, input: call.input });
    if (status !== 0) {
      attemptedCalls.push({ toolId: call.toolId, allowlisted: true, outcome: 'failed' });
      failureReason = status === 3 ? 'sandbox_tool_result_invalid' : 'sandbox_tool_execution_failed';
      break;
    }
    attemptedCalls.push({ toolId: call.toolId, allowlisted: true, outcome: 'executed' });
  }
  return {
    ok: attemptedCalls.length === calls.length && attemptedCalls.every(call => call.outcome === 'executed'),
    attemptedCalls,
    buildResult: null,
    surfaceResult: null,
    failureReason
  };
};

const runWebMcp = source => {
  const payload = source.payload;
  if (!isRecord(payload)
    || Object.keys(payload).sort().join(',') !== 'contract,runtimeDigest,runtimeSource,scenario'
    || payload.contract !== WEBMCP_SANDBOX_INPUT_CONTRACT
    || payload.scenario !== 'registration-drift'
    || payload.runtimeSource !== WEBMCP_CLIENT_RUNTIME
    || payload.runtimeDigest !== WEBMCP_CLIENT_RUNTIME_SHA256) {
    return registrationFailure('sandbox_webmcp_input_invalid');
  }
  const executableTargetPath = process.env.AG_EXECUTABLE_TARGET_PATH || EXECUTABLE_TARGET_PATH;
  const configuredTimeoutMs = Number(process.env.AG_SANDBOX_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs >= 1
    ? Math.min(configuredTimeoutMs, 300000)
    : 300000;
  writeFileSync(executableTargetPath, WEBMCP_SANDBOX_TARGET_SOURCE, { encoding: 'utf8', mode: 0o600 });
  const execution = spawnSync(process.execPath, [executableTargetPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs
  });
  let parsed = null;
  try { parsed = JSON.parse(execution.stdout || 'null'); } catch { parsed = null; }
  const ok = execution.status === 0 && isRecord(parsed) && parsed.ok === true && isRecord(parsed.surfaceResult);
  return {
    ok,
    attemptedCalls: [],
    buildResult: null,
    surfaceResult: isRecord(parsed?.surfaceResult) ? parsed.surfaceResult : null,
    failureReason: ok ? null : 'sandbox_webmcp_execution_failed'
  };
};

const inputPath = process.env.AG_SANDBOX_INPUT_PATH;
const source = JSON.parse(inputPath ? readFileSync(inputPath, 'utf8') : readFileSync(0, 'utf8'));
if (source.purpose === 'theme-build') {
  const buildResult = buildTheme(source.payload?.manifest);
  process.stdout.write(JSON.stringify({
    ok: buildResult.status === 'completed', attemptedCalls: [], buildResult,
    surfaceResult: null, failureReason: null
  }));
} else if (source.purpose === 'unshipped-surface-build') {
  process.stdout.write(JSON.stringify(runWebMcp(source)));
} else {
  process.stdout.write(JSON.stringify(await runRegistration(source)));
}
`

export function readThemeBuildResult(value: unknown): ThemeBuildResult | null {
  if (!isRecord(value) || value.contract !== THEME_BUILD_CONTRACT) return null
  if (value.status === 'completed') {
    if (Object.keys(value).sort().join(',')
        !== 'artifactBytes,artifactDigest,contract,defaultedFields,manifestDigest,resolvedCatalogScope,status'
      || typeof value.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.manifestDigest)
      || typeof value.artifactDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.artifactDigest)
      || !Number.isSafeInteger(value.artifactBytes) || Number(value.artifactBytes) < 1
      || !validIdentifierArray(value.resolvedCatalogScope, 1, 500)
      || !validDefaultedFields(value.defaultedFields)) return null
    return Object.freeze({
      status: 'completed',
      contract: THEME_BUILD_CONTRACT,
      manifestDigest: value.manifestDigest,
      artifactDigest: value.artifactDigest,
      artifactBytes: Number(value.artifactBytes),
      resolvedCatalogScope: Object.freeze(value.resolvedCatalogScope),
      defaultedFields: Object.freeze(value.defaultedFields),
    })
  }
  if (Object.keys(value).sort().join(',') !== 'code,contract,status,violations'
    || value.status !== 'failed' || value.code !== 'theme_manifest_invalid' || !Array.isArray(value.violations)
    || value.violations.length < 1 || value.violations.length > 1000) return null
  const violations: Array<Readonly<{ field: string; reason: string }>> = []
  for (const violation of value.violations) {
    if (!isRecord(violation)
      || Object.keys(violation).sort().join(',') !== 'field,reason'
      || typeof violation.field !== 'string'
      || typeof violation.reason !== 'string'
      || violation.field.length > 280
      || violation.reason.length > 280) return null
    violations.push(Object.freeze({ field: violation.field, reason: violation.reason }))
  }
  return Object.freeze({
    status: 'failed',
    contract: THEME_BUILD_CONTRACT,
    code: 'theme_manifest_invalid',
    violations: Object.freeze(violations),
  })
}

export function readHarnessOutput(value: string): SandboxHarnessOutput | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join(',') !== 'attemptedCalls,buildResult,failureReason,ok,surfaceResult'
    || typeof parsed.ok !== 'boolean'
    || !Array.isArray(parsed.attemptedCalls)
    || parsed.attemptedCalls.length > 500
    || !validFailureReason(parsed.failureReason)) return null
  const attemptedCalls: AttemptedCall[] = []
  for (const attempted of parsed.attemptedCalls) {
    if (!isRecord(attempted)
      || Object.keys(attempted).sort().join(',') !== 'allowlisted,outcome,toolId'
      || typeof attempted.toolId !== 'string'
      || !IDENTIFIER_PATTERN.test(attempted.toolId)
      || typeof attempted.allowlisted !== 'boolean'
      || (attempted.outcome !== 'executed' && attempted.outcome !== 'refused' && attempted.outcome !== 'failed')
      || attempted.allowlisted !== (attempted.outcome !== 'refused')) return null
    attemptedCalls.push(Object.freeze({
      toolId: attempted.toolId,
      allowlisted: attempted.allowlisted,
      outcome: attempted.outcome,
    }))
  }
  const firstNonExecuted = attemptedCalls.findIndex(({ outcome }) => outcome !== 'executed')
  if (firstNonExecuted >= 0 && firstNonExecuted !== attemptedCalls.length - 1) return null
  const buildResult = parsed.buildResult === null ? null : readThemeBuildResult(parsed.buildResult)
  if (parsed.buildResult !== null && !buildResult) return null
  const surfaceResult = parsed.surfaceResult === null ? null : readWebMcpSandboxResult(parsed.surfaceResult)
  if (parsed.surfaceResult !== null && !surfaceResult) return null
  if (buildResult) {
    if (attemptedCalls.length > 0
      || surfaceResult !== null
      || parsed.failureReason !== null
      || parsed.ok !== (buildResult.status === 'completed')) return null
  } else if (surfaceResult) {
    if (!parsed.ok || attemptedCalls.length > 0 || parsed.failureReason !== null) return null
  } else if (parsed.ok) {
    if (parsed.failureReason !== null
      || !attemptedCalls.every(({ outcome }) => outcome === 'executed')) return null
  } else {
    const lastOutcome = attemptedCalls.at(-1)?.outcome
    if (lastOutcome === 'refused' && parsed.failureReason !== null) return null
    if (lastOutcome === 'failed' && !parsed.failureReason?.startsWith('sandbox_tool_')) return null
    if (lastOutcome === 'executed' || (lastOutcome === undefined
      && !parsed.failureReason?.startsWith('sandbox_executable_target_'))) return null
  }
  return Object.freeze({
    ok: parsed.ok,
    attemptedCalls: Object.freeze(attemptedCalls),
    buildResult,
    surfaceResult,
    failureReason: parsed.failureReason,
  })
}

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const DEFAULTED_FIELD_NAMES = new Set([
  'copy.brand', 'copy.footer', 'copy.headline', 'copy.subhead', 'locale', 'logo.alt', 'logo.href',
  'palette.accent', 'palette.background', 'palette.ink', 'palette.line', 'palette.muted', 'palette.panel',
])

function validIdentifierArray(value: unknown, minimum: number, maximum: number): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((entry) => typeof entry === 'string' && IDENTIFIER_PATTERN.test(entry))
    && new Set(value).size === value.length
}

function validDefaultedFields(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= DEFAULTED_FIELD_NAMES.size
    && value.every((entry) => typeof entry === 'string' && DEFAULTED_FIELD_NAMES.has(entry))
    && new Set(value).size === value.length
}

function validFailureReason(value: unknown): value is SandboxHarnessFailureReason | null {
  return value === null || value === 'sandbox_executable_target_required'
    || value === 'sandbox_executable_target_digest_mismatch'
    || value === 'sandbox_executable_target_load_failed'
    || value === 'sandbox_tool_execution_failed'
    || value === 'sandbox_tool_result_invalid'
    || value === 'sandbox_webmcp_input_invalid'
    || value === 'sandbox_webmcp_execution_failed'
}
