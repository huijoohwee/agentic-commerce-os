// Read-only, fail-closed projection of Agentic Canvas OS invocation metadata from the configured docs MCP.

import {
  CATALOG_LIMIT,
  MCP_PROTOCOL_VERSION,
  DOCS_INVOCATION_ENDPOINT,
  DOCS_INVOCATION_TOOL,
  SIGILS,
  InvocationClientError,
  assertSameMetadata,
  buildInvocationDigests,
  countKeyForSigil,
  fail,
  isRecord,
  normalizeEntry,
  normalizeMetadata,
  stableJson,
  validateToken,
  type CatalogMetadata,
  type FetchFunction,
  type InvocationCatalogEntry,
  type InvocationCatalogSnapshot,
  type InvocationClient,
  type InvocationClientOptions,
  type InvocationRequestOptions,
  type JsonRecord,
  type ResolvedInvocation,
} from "./catalog.js";

export {
  INVOCATION_ROUTING_SCHEMA,
  MCP_PROTOCOL_VERSION,
  DOCS_INVOCATION_ENDPOINT,
  DOCS_INVOCATION_TOOL,
  InvocationClientError,
  buildInvocationDigests,
  serializeInvocationCatalog,
  serializeInvocationRouting,
} from "./catalog.js";
export type {
  FetchFunction,
  FetcherBinding,
  InvocationCatalogEntry,
  InvocationCatalogSnapshot,
  InvocationClient,
  InvocationClientErrorCode,
  InvocationClientOptions,
  InvocationCounts,
  InvocationKind,
  InvocationRequestOptions,
  InvocationSigil,
  ResolvedInvocation,
} from "./catalog.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;

const normalizeEndpoint = (value: string | undefined): string => {
  const endpoint = value ?? DOCS_INVOCATION_ENDPOINT;
  if (endpoint !== endpoint.trim() || endpoint.length === 0 || endpoint.length > 2_048) {
    return fail("invalid_input", "Docs MCP endpoint is not a bounded URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return fail("invalid_input", "Docs MCP endpoint is invalid");
  }
  const localHttp = parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    return fail("invalid_input", "Docs MCP endpoint must use HTTPS or loopback HTTP");
  }
  return parsed.toString();
};

const resolveFetch = (fetcher: InvocationClientOptions["fetcher"]): FetchFunction => {
  if (typeof fetcher === "function") return fetcher;
  if (fetcher && typeof fetcher.fetch === "function") return fetcher.fetch.bind(fetcher);
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  return fail("invalid_input", "A fetch-compatible function or Fetcher binding is required");
};

const readBoundedBody = async (response: Response, limit: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    return fail("response_too_large", "Docs MCP response exceeds the configured byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return fail("response_too_large", "Docs MCP response exceeds the configured byte limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const parseJsonRecord = (text: string): JsonRecord | null => {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const parseMcpEnvelope = (text: string): JsonRecord => {
  const direct = parseJsonRecord(text);
  if (direct) return direct;
  const frames = text.split(/\r?\n\r?\n/u).slice(-16);
  const parsed = frames.flatMap((frame) => {
    const data = frame.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const record = data ? parseJsonRecord(data) : null;
    return record ? [record] : [];
  });
  return parsed.at(-1)
    ?? fail("invalid_mcp_response", "Docs MCP returned unreadable JSON-RPC");
};

const extractToolPayload = (rpc: JsonRecord): JsonRecord => {
  if (!isRecord(rpc.result)) {
    return fail("invalid_mcp_response", "MCP tools/call result is missing");
  }
  const result = rpc.result;
  if (result.isError === true) {
    return fail("mcp_tool_failed", "Docs invocation tool returned an error result");
  }
  if (result.isError !== undefined && result.isError !== false) {
    return fail("invalid_mcp_response", "MCP tool isError flag is invalid");
  }
  const structured = isRecord(result.structuredContent) ? result.structuredContent : null;
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((block) => (
    isRecord(block) && block.type === "text" && typeof block.text === "string"
  ));
  const textPayload = textBlock && isRecord(textBlock)
    ? parseJsonRecord(String(textBlock.text))
    : null;
  if (structured && textPayload && stableJson(structured) !== stableJson(textPayload)) {
    return fail("invalid_mcp_response", "MCP structured and text payloads disagree");
  }
  return structured
    ?? textPayload
    ?? fail("invalid_mcp_response", "MCP invocation payload is missing");
};

export const createInvocationClient = (
  options: InvocationClientOptions = {},
): InvocationClient => {
  const endpoint = normalizeEndpoint(options.endpoint);
  const fetchImpl = resolveFetch(options.fetcher);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(maxResponseBytes)
    || maxResponseBytes < 1
    || maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    return fail("invalid_input", "maxResponseBytes is outside the supported bound");
  }
  const clientName = options.clientName ?? "agentic-commerce-os";
  const clientVersion = options.clientVersion ?? "0.1.0";
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(clientName)
    || !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(clientVersion)
  ) {
    return fail("invalid_input", "MCP client identity is invalid");
  }

  let nextRequestId = 1;
  let sessionId = "";
  let initialization: Promise<void> | null = null;
  let snapshotState: InvocationCatalogSnapshot | null = null;
  let snapshotPromise: Promise<InvocationCatalogSnapshot> | null = null;

  const post = async (
    body: JsonRecord,
    signal: AbortSignal | undefined,
    includeSession: boolean,
  ): Promise<{ response: Response; text: string }> => {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(includeSession ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof InvocationClientError) throw error;
      return fail(
        "transport_failed",
        `Docs MCP request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (response.status === 404 && includeSession) {
      return fail("mcp_session_expired", "Docs MCP session expired");
    }
    const text = await readBoundedBody(response, maxResponseBytes);
    if (!response.ok) {
      return fail("transport_failed", `Docs MCP responded with HTTP ${response.status}`);
    }
    const returnedSession = response.headers.get("mcp-session-id");
    if (includeSession && returnedSession && returnedSession !== sessionId) {
      return fail("invalid_mcp_response", "Docs MCP session changed during a request");
    }
    return { response, text };
  };

  const request = async (
    method: string,
    params: JsonRecord,
    signal: AbortSignal | undefined,
    includeSession: boolean,
  ): Promise<{ rpc: JsonRecord; response: Response }> => {
    const id = nextRequestId++;
    const { response, text } = await post(
      { jsonrpc: "2.0", id, method, params },
      signal,
      includeSession,
    );
    const rpc = parseMcpEnvelope(text);
    if (rpc.jsonrpc !== "2.0" || rpc.id !== id) {
      return fail("invalid_mcp_response", "Docs MCP JSON-RPC identity does not match the request");
    }
    if (isRecord(rpc.error)) {
      const message = typeof rpc.error.message === "string"
        ? rpc.error.message.slice(0, 512)
        : "MCP request failed";
      return fail("mcp_tool_failed", message);
    }
    return { rpc, response };
  };

  const ensureInitialized = async (signal?: AbortSignal): Promise<void> => {
    if (sessionId) return;
    if (!initialization) {
      initialization = (async () => {
        const initialized = await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: clientName, version: clientVersion },
        }, signal, false);
        if (
          !isRecord(initialized.rpc.result)
          || initialized.rpc.result.protocolVersion !== MCP_PROTOCOL_VERSION
        ) {
          return fail("invalid_mcp_response", "Docs MCP did not negotiate the requested protocol");
        }
        const assignedSession = initialized.response.headers.get("mcp-session-id") ?? "";
        if (!/^[\x21-\x7e]{1,256}$/u.test(assignedSession)) {
          return fail("invalid_mcp_response", "Docs MCP initialize did not return a valid session ID");
        }
        sessionId = assignedSession;
        const notification = await post({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }, signal, true);
        if (notification.text !== "") {
          return fail("invalid_mcp_response", "MCP initialized notification returned an unexpected body");
        }
      })().catch((error) => {
        sessionId = "";
        throw error;
      }).finally(() => {
        initialization = null;
      });
    }
    await initialization;
  };

  const callInvocationTool = async (
    invocationArguments: JsonRecord,
    signal?: AbortSignal,
  ): Promise<JsonRecord> => {
    await ensureInitialized(signal);
    const called = await request("tools/call", {
      name: DOCS_INVOCATION_TOOL,
      arguments: invocationArguments,
    }, signal, true);
    return extractToolPayload(called.rpc);
  };

  const hydrateFresh = async (signal?: AbortSignal): Promise<InvocationCatalogSnapshot> => {
    let metadata: CatalogMetadata | null = null;
    const entries: InvocationCatalogEntry[] = [];
    const tokens = new Set<string>();
    for (const sigil of SIGILS) {
      const payload = await callInvocationTool({ query: sigil, limit: CATALOG_LIMIT }, signal);
      if (payload.ok !== true || payload.truncated !== false || !Array.isArray(payload.catalog)) {
        return fail("invalid_catalog", `Docs ${sigil} catalog is incomplete`);
      }
      const currentMetadata = normalizeMetadata(payload);
      if (metadata) assertSameMetadata(metadata, currentMetadata);
      else metadata = currentMetadata;
      const currentEntries = payload.catalog.map((entry) => (
        normalizeEntry(entry, currentMetadata.sourceRevision)
      ));
      const expectedKind = countKeyForSigil(sigil);
      if (
        currentEntries.length !== currentMetadata.counts[expectedKind]
        || currentEntries.some((entry) => (
          entry.kind !== expectedKind || !entry.token.startsWith(sigil)
        ))
      ) {
        return fail("invalid_catalog", `Docs ${sigil} catalog does not match its full count`);
      }
      for (const entry of currentEntries) {
        if (tokens.has(entry.token)) {
          return fail("invalid_catalog", `Duplicate invocation token ${entry.token}`);
        }
        tokens.add(entry.token);
        entries.push(entry);
      }
    }
    if (!metadata) return fail("invalid_catalog", "Docs invocation catalog is empty");
    const fullCount = metadata.counts.command
      + metadata.counts.semantic
      + metadata.counts.binding;
    if (entries.length !== fullCount) {
      return fail("invalid_catalog", "Invocation catalog full counts do not reconcile");
    }
    const sortedEntries = Object.freeze(
      [...entries].sort((left, right) => left.token.localeCompare(right.token)),
    );
    const computed = await buildInvocationDigests(sortedEntries);
    if (
      computed.catalogDigest !== metadata.catalogDigest
      || computed.routingDigest !== metadata.routingDigest
    ) {
      return fail("catalog_drift", "Invocation catalog bytes do not match the advertised digests");
    }
    return Object.freeze({ ...metadata, entries: sortedEntries });
  };

  const hydrate = async (
    requestOptions: InvocationRequestOptions = {},
  ): Promise<InvocationCatalogSnapshot> => {
    if (snapshotState) return snapshotState;
    if (!snapshotPromise) {
      snapshotPromise = hydrateFresh(requestOptions.signal).then((snapshot) => {
        snapshotState = snapshot;
        return snapshot;
      }).finally(() => {
        snapshotPromise = null;
      });
    }
    return snapshotPromise;
  };

  const refresh = async (
    requestOptions: InvocationRequestOptions = {},
  ): Promise<InvocationCatalogSnapshot> => {
    if (snapshotPromise) await snapshotPromise;
    snapshotState = null;
    return hydrate(requestOptions);
  };

  const resolve = async (
    rawToken: string,
    requestOptions: InvocationRequestOptions = {},
  ): Promise<ResolvedInvocation> => {
    const token = validateToken(rawToken, "invalid_input");
    const snapshot = await hydrate(requestOptions);
    const payload = await callInvocationTool({ token }, requestOptions.signal);
    const metadata = normalizeMetadata(payload);
    assertSameMetadata(snapshot, metadata);
    if (payload.ok !== true && payload.ok !== false) {
      return fail("invalid_catalog", "Exact invocation response has an invalid result status");
    }
    if (
      payload.token !== token
      || payload.truncated !== false
      || !Array.isArray(payload.catalog)
      || payload.catalog.length !== 0
    ) {
      return fail("invalid_catalog", "Exact invocation response has an invalid envelope");
    }
    const expected = snapshot.entries.find((entry) => entry.token === token);
    if (payload.ok === false || payload.invocation === null || payload.invocation === undefined) {
      if (expected) return fail("catalog_drift", `Invocation ${token} disappeared from the verified catalog`);
      return fail("invocation_not_found", `Unknown invocation token: ${token}`);
    }
    if (!expected) {
      return fail("catalog_drift", `Invocation ${token} appeared outside the verified catalog`);
    }
    const invocation = normalizeEntry(payload.invocation, snapshot.sourceRevision);
    if (invocation.token !== token || stableJson(invocation) !== stableJson(expected)) {
      return fail("catalog_drift", `Invocation ${token} does not match its verified catalog entry`);
    }
    return Object.freeze({
      sourceRevision: snapshot.sourceRevision,
      catalogDigest: snapshot.catalogDigest,
      routingSchema: snapshot.routingSchema,
      routingDigest: snapshot.routingDigest,
      counts: snapshot.counts,
      invocation,
    });
  };

  const close = async (
    requestOptions: InvocationRequestOptions = {},
  ): Promise<void> => {
    if (initialization) {
      try {
        await initialization;
      } catch {
        return;
      }
    }
    const closingSession = sessionId;
    sessionId = "";
    if (!closingSession) return;
    try {
      const response = await fetchImpl(endpoint, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": closingSession,
        },
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      await response.body?.cancel();
    } catch {
      // A verified tool result remains authoritative if best-effort session cleanup fails.
    }
  };

  return Object.freeze({ hydrate, refresh, resolve, close });
};
