export const DOCS_INVOCATION_ENDPOINT =
  "https://airvio.co/agenticgraph/control-plane/mcp";
export const DOCS_INVOCATION_TOOL =
  "agenticgraph.agentic_canvas_os.docs.invoke";
export const INVOCATION_ROUTING_SCHEMA = "agentic-canvas-os-docs-routing/v1";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const CATALOG_LIMIT = 500;
const MAX_TOKEN_LENGTH = 128;
const MAX_FIELD_LENGTH = 4_096;
const MAX_ARRAY_ITEMS = 128;
export const SIGILS = ["/", "#", "@"] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const TOKEN_PATTERN = /^[/#@][a-z0-9][a-z0-9._-]*:?$/u;

export type InvocationSigil = (typeof SIGILS)[number];
export type InvocationKind = "command" | "semantic" | "binding";

export type InvocationCounts = Readonly<{
  command: number;
  semantic: number;
  binding: number;
}>;

export type InvocationCatalogEntry = Readonly<{
  token: string;
  kind: InvocationKind;
  label: string;
  summary: string;
  intent?: string;
  sourcePath: string;
  sourceUrl?: string;
  fileName?: string;
  keywords?: readonly string[];
  mcpTool?: string;
  mcpTools?: readonly string[];
  semantics?: readonly string[];
  bindings?: readonly string[];
}>;

export type InvocationCatalogSnapshot = Readonly<{
  sourceRevision: string;
  catalogDigest: string;
  routingSchema: typeof INVOCATION_ROUTING_SCHEMA;
  routingDigest: string;
  counts: InvocationCounts;
  entries: readonly InvocationCatalogEntry[];
}>;

export type ResolvedInvocation = Readonly<{
  sourceRevision: string;
  catalogDigest: string;
  routingSchema: typeof INVOCATION_ROUTING_SCHEMA;
  routingDigest: string;
  counts: InvocationCounts;
  invocation: InvocationCatalogEntry;
}>;

export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FetcherBinding = Readonly<{ fetch: FetchFunction }>;

export type InvocationClientOptions = Readonly<{
  endpoint?: string;
  fetcher?: FetchFunction | FetcherBinding;
  maxResponseBytes?: number;
  clientName?: string;
  clientVersion?: string;
}>;

export type InvocationRequestOptions = Readonly<{ signal?: AbortSignal }>;

export type InvocationClient = Readonly<{
  hydrate(options?: InvocationRequestOptions): Promise<InvocationCatalogSnapshot>;
  refresh(options?: InvocationRequestOptions): Promise<InvocationCatalogSnapshot>;
  resolve(token: string, options?: InvocationRequestOptions): Promise<ResolvedInvocation>;
  close(options?: InvocationRequestOptions): Promise<void>;
}>;

export type InvocationClientErrorCode =
  | "invalid_input"
  | "transport_failed"
  | "response_too_large"
  | "invalid_mcp_response"
  | "mcp_session_expired"
  | "mcp_tool_failed"
  | "invalid_catalog"
  | "catalog_drift"
  | "invocation_not_found";

export class InvocationClientError extends Error {
  readonly code: InvocationClientErrorCode;

  constructor(code: InvocationClientErrorCode, message: string) {
    super(message);
    this.name = "InvocationClientError";
    this.code = code;
  }
}

export type JsonRecord = Record<string, unknown>;

export const fail = (code: InvocationClientErrorCode, message: string): never => {
  throw new InvocationClientError(code, message);
};

export const isRecord = (value: unknown): value is JsonRecord => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

export const boundedText = (
  value: unknown,
  label: string,
  { allowEmpty = false, max = MAX_FIELD_LENGTH } = {},
): string => {
  if (typeof value !== "string" || value !== value.trim() || value.length > max) {
    return fail("invalid_catalog", `${label} is not a bounded canonical string`);
  }
  if (!allowEmpty && value.length === 0) return fail("invalid_catalog", `${label} is empty`);
  return value;
};

export const validateToken = (value: unknown, code: InvocationClientErrorCode): string => {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length > MAX_TOKEN_LENGTH
    || !TOKEN_PATTERN.test(value)
  ) {
    return fail(code, "Invocation token must be one exact bounded /, #, or @ token");
  }
  return value;
};

const kindForToken = (token: string): InvocationKind => {
  if (token.startsWith("/")) return "command";
  if (token.startsWith("#")) return "semantic";
  return "binding";
};

export const countKeyForSigil = (sigil: InvocationSigil): InvocationKind => {
  if (sigil === "/") return "command";
  if (sigil === "#") return "semantic";
  return "binding";
};

const optionalString = (record: JsonRecord, key: string): string | undefined => (
  record[key] === undefined ? undefined : boundedText(record[key], `invocation.${key}`, { allowEmpty: true })
);

const optionalStringArray = (
  record: JsonRecord,
  key: string,
  tokenSigil = "",
): readonly string[] | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    return fail("invalid_catalog", `invocation.${key} is not a bounded array`);
  }
  const normalized = value.map((item) => boundedText(
    item,
    `invocation.${key} item`,
    { max: MAX_TOKEN_LENGTH },
  ));
  if (new Set(normalized).size !== normalized.length) {
    return fail("invalid_catalog", `invocation.${key} contains duplicates`);
  }
  if (tokenSigil && normalized.some((item) => (
    !item.startsWith(tokenSigil) || validateToken(item, "invalid_catalog") !== item
  ))) {
    return fail("invalid_catalog", `invocation.${key} contains an invalid token kind`);
  }
  return Object.freeze(normalized);
};

const ENTRY_KEYS = new Set([
  "token", "kind", "label", "summary", "intent", "sourcePath", "sourceUrl",
  "fileName", "keywords", "mcpTool", "mcpTools", "semantics", "bindings",
]);

export const normalizeEntry = (value: unknown, sourceRevision: string): InvocationCatalogEntry => {
  if (!isRecord(value) || Object.keys(value).some((key) => !ENTRY_KEYS.has(key))) {
    return fail("invalid_catalog", "Invocation entry has an unsupported shape");
  }
  const token = validateToken(value.token, "invalid_catalog");
  const kind = boundedText(value.kind, "invocation.kind") as InvocationKind;
  if (kind !== kindForToken(token)) {
    return fail("invalid_catalog", `Invocation ${token} kind does not match its sigil`);
  }
  const sourceUrl = optionalString(value, "sourceUrl");
  if (sourceUrl) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return fail("invalid_catalog", `Invocation ${token} has an invalid source URL`);
    }
    if (parsed.protocol !== "https:" || !parsed.pathname.includes(`/${sourceRevision}/`)) {
      return fail("invalid_catalog", `Invocation ${token} source URL is not revision-bound`);
    }
  }
  const intent = optionalString(value, "intent");
  const fileName = optionalString(value, "fileName");
  const keywords = optionalStringArray(value, "keywords");
  const mcpTools = optionalStringArray(value, "mcpTools");
  const semantics = optionalStringArray(value, "semantics", "#");
  const bindings = optionalStringArray(value, "bindings", "@");
  const mcpTool = optionalString(value, "mcpTool");
  if (mcpTool && mcpTools?.length && mcpTools[0] !== mcpTool) {
    return fail("invalid_catalog", `Invocation ${token} MCP tool projection disagrees`);
  }
  return Object.freeze({
    token,
    kind,
    label: boundedText(value.label, "invocation.label", { allowEmpty: true }),
    summary: boundedText(value.summary, "invocation.summary", { allowEmpty: true }),
    ...(intent !== undefined ? { intent } : {}),
    sourcePath: boundedText(value.sourcePath, "invocation.sourcePath"),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(fileName !== undefined ? { fileName } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(mcpTool !== undefined ? { mcpTool } : {}),
    ...(mcpTools !== undefined ? { mcpTools } : {}),
    ...(semantics !== undefined ? { semantics } : {}),
    ...(bindings !== undefined ? { bindings } : {}),
  });
};

const digestText = (value: unknown): string => String(value ?? "").trim();

export const serializeInvocationCatalog = (
  entries: readonly InvocationCatalogEntry[],
): string => `${JSON.stringify(entries.map((entry) => ({
  token: digestText(entry.token),
  kind: digestText(entry.kind).toLowerCase(),
  label: digestText(entry.label),
  summary: digestText(entry.summary),
  sourcePath: digestText(entry.sourcePath),
})).sort((left, right) => left.token.localeCompare(right.token)))}\n`;

const routingValues = (values: readonly string[] | undefined, sigil = ""): string[] => [
  ...new Set((values ?? []).map(digestText).filter((value) => value && (!sigil || value.startsWith(sigil)))),
];

export const serializeInvocationRouting = (
  entries: readonly InvocationCatalogEntry[],
): string => `${JSON.stringify({
  schema: INVOCATION_ROUTING_SCHEMA,
  routes: entries.map((entry) => ({
    token: digestText(entry.token),
    kind: digestText(entry.kind).toLowerCase(),
    sourcePath: digestText(entry.sourcePath),
    mcpTools: routingValues(entry.mcpTools !== undefined
      ? entry.mcpTools
      : entry.mcpTool ? [entry.mcpTool] : []),
    semantics: routingValues(entry.semantics, "#"),
    bindings: routingValues(entry.bindings, "@"),
  })).sort((left, right) => left.token.localeCompare(right.token)),
})}\n`;

const sha256 = async (text: string): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fail("invalid_catalog", "Web Crypto SHA-256 is unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const buildInvocationDigests = async (
  entries: readonly InvocationCatalogEntry[],
): Promise<Readonly<{ catalogDigest: string; routingDigest: string }>> => ({
  catalogDigest: await sha256(serializeInvocationCatalog(entries)),
  routingDigest: await sha256(serializeInvocationRouting(entries)),
});

export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export type CatalogMetadata = Readonly<{
  sourceRevision: string;
  catalogDigest: string;
  routingSchema: typeof INVOCATION_ROUTING_SCHEMA;
  routingDigest: string;
  counts: InvocationCounts;
}>;

const normalizeCounts = (value: unknown): InvocationCounts => {
  if (!isRecord(value)) return fail("invalid_catalog", "Invocation catalog counts are missing");
  const read = (kind: InvocationKind): number => {
    const count = value[kind];
    if (!Number.isInteger(count) || Number(count) < 0 || Number(count) > CATALOG_LIMIT) {
      return fail("invalid_catalog", `Invocation ${kind} count is not exact and bounded`);
    }
    return Number(count);
  };
  return Object.freeze({ command: read("command"), semantic: read("semantic"), binding: read("binding") });
};

export const normalizeMetadata = (payload: JsonRecord): CatalogMetadata => {
  const sourceRevision = boundedText(payload.sourceRevision, "sourceRevision", { max: 40 });
  const catalogDigest = boundedText(payload.catalogDigest, "catalogDigest", { max: 64 });
  const routingDigest = boundedText(payload.routingDigest, "routingDigest", { max: 64 });
  if (!REVISION_PATTERN.test(sourceRevision)) return fail("invalid_catalog", "Source revision is not an exact SHA");
  if (!DIGEST_PATTERN.test(catalogDigest) || !DIGEST_PATTERN.test(routingDigest)) {
    return fail("invalid_catalog", "Catalog digest proof is invalid");
  }
  if (payload.routingSchema !== INVOCATION_ROUTING_SCHEMA) {
    return fail("invalid_catalog", "Invocation routing schema is unsupported");
  }
  return Object.freeze({
    sourceRevision,
    catalogDigest,
    routingSchema: INVOCATION_ROUTING_SCHEMA,
    routingDigest,
    counts: normalizeCounts(payload.counts),
  });
};

export const assertSameMetadata = (expected: CatalogMetadata, actual: CatalogMetadata): void => {
  const proof = (value: CatalogMetadata) => ({
    sourceRevision: value.sourceRevision,
    catalogDigest: value.catalogDigest,
    routingSchema: value.routingSchema,
    routingDigest: value.routingDigest,
    counts: value.counts,
  });
  if (stableJson(proof(expected)) !== stableJson(proof(actual))) {
    fail("catalog_drift", "Docs invocation responses disagree on source or catalog proof");
  }
};
