import { assert, expect, test } from "vitest";

import {
  INVOCATION_ROUTING_SCHEMA,
  MCP_PROTOCOL_VERSION,
  DOCS_INVOCATION_ENDPOINT,
  DOCS_INVOCATION_TOOL,
  buildInvocationDigests,
  createInvocationClient,
  type FetchFunction,
  type InvocationCatalogEntry,
} from "../../src/invocation/index.js";

const SOURCE_REVISION = "a".repeat(40);
const SESSION_ID = "fixture-session-1";
const ENDPOINT = new URL(new URL(DOCS_INVOCATION_ENDPOINT).pathname, "https://commerce.test").href;
const DISCOVERY_CREDENTIAL = "commerce-discovery-provider-test-credential";

const CATALOG: readonly InvocationCatalogEntry[] = Object.freeze([
  Object.freeze({
    token: "/compose-cart",
    kind: "command",
    label: "Compose cart",
    summary: "Plan a cart through its registered runtime tool.",
    intent: "Compose a deterministic cart plan.",
    sourcePath: "DICTIONARY-COMMAND.md#/compose-cart",
    sourceUrl: `https://github.com/huijoohwee/agentic-canvas-os/blob/${SOURCE_REVISION}/docs/DICTIONARY-COMMAND.md`,
    mcpTool: "commerce.cart.plan",
    mcpTools: Object.freeze(["commerce.cart.plan"]),
    semantics: Object.freeze(["#runtime-ready"]),
    bindings: Object.freeze(["@cart"]),
  }),
  Object.freeze({
    token: "#runtime-ready",
    kind: "semantic",
    label: "Runtime ready",
    summary: "Require runtime evidence.",
    sourcePath: "DICTIONARY-SEMANTIC.md##runtime-ready",
    sourceUrl: `https://github.com/huijoohwee/agentic-canvas-os/blob/${SOURCE_REVISION}/docs/DICTIONARY-SEMANTIC.md`,
  }),
  Object.freeze({
    token: "@cart",
    kind: "binding",
    label: "Cart",
    summary: "Bind an explicit cart identifier.",
    sourcePath: "DICTIONARY-BINDING.md#@cart",
    sourceUrl: `https://github.com/huijoohwee/agentic-canvas-os/blob/${SOURCE_REVISION}/docs/DICTIONARY-BINDING.md`,
  }),
]);

type RequestRecord = {
  headers: Headers;
  message: Record<string, unknown>;
};

type FakeBehavior = {
  mutatePayload?: (payload: Record<string, unknown>, message: Record<string, unknown>) => void;
  sse?: boolean;
};

const counts = Object.freeze({ command: 1, semantic: 1, binding: 1 });

const createFakeTransport = async (behavior: FakeBehavior = {}) => {
  const digests = await buildInvocationDigests(CATALOG);
  const requests: RequestRecord[] = [];
  const fetch: FetchFunction = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${DISCOVERY_CREDENTIAL}`);
    if (init?.method === "DELETE") {
      requests.push({ headers, message: { method: "session/close" } });
      assert.equal(headers.get("mcp-session-id"), SESSION_ID);
      return new Response(null, { status: 204 });
    }
    const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ headers, message });
    if (message.method === "initialize") {
      const params = message.params as Record<string, unknown>;
      assert.equal(params.protocolVersion, MCP_PROTOCOL_VERSION);
      return rpcResponse(message.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      }, { session: true, sse: Boolean(behavior.sse) });
    }
    assert.equal(headers.get("mcp-session-id"), SESSION_ID);
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    assert.equal(message.method, "tools/call");
    const params = message.params as Record<string, unknown>;
    assert.equal(params.name, DOCS_INVOCATION_TOOL);
    const args = params.arguments as Record<string, unknown>;
    const query = typeof args.query === "string" ? args.query : "";
    const token = typeof args.token === "string" ? args.token : "";
    const selected = query ? CATALOG.filter((entry) => entry.token.startsWith(query)) : [];
    const invocation = token ? CATALOG.find((entry) => entry.token === token) ?? null : null;
    const payload: Record<string, unknown> = {
      ok: token ? Boolean(invocation) : true,
      sourceRevision: SOURCE_REVISION,
      catalogDigest: digests.catalogDigest,
      routingSchema: INVOCATION_ROUTING_SCHEMA,
      routingDigest: digests.routingDigest,
      counts,
      ...(token ? { token } : {}),
      invocation,
      catalog: selected,
      truncated: false,
    };
    behavior.mutatePayload?.(payload, message);
    return rpcResponse(message.id, {
      isError: false,
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    }, { sse: Boolean(behavior.sse) });
  };
  return { fetch, requests };
};

const rpcResponse = (
  id: unknown,
  result: unknown,
  options: { session?: boolean; sse?: boolean } = {},
): Response => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  return new Response(options.sse ? `event: message\ndata: ${body}\n\n` : body, {
    status: 200,
    headers: {
      "content-type": options.sse ? "text/event-stream" : "application/json",
      ...(options.session ? { "mcp-session-id": SESSION_ID } : {}),
    },
  });
};

const rejectsWithCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
};

test("hydrates all three source slices and resolves one exact token through a Fetcher binding", async () => {
  const transport = await createFakeTransport();
  const binding = { fetch: transport.fetch };
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: binding,
    bearerToken: DISCOVERY_CREDENTIAL,
  });

  const snapshot = await client.hydrate();
  assert.deepEqual(snapshot.counts, counts);
  assert.deepEqual(snapshot.entries.map((entry) => entry.token), [
    "@cart", "/compose-cart", "#runtime-ready",
  ]);

  const resolved = await client.resolve("/compose-cart");
  assert.equal(resolved.invocation.token, "/compose-cart");
  assert.equal(resolved.sourceRevision, SOURCE_REVISION);
  assert.equal(resolved.routingSchema, INVOCATION_ROUTING_SCHEMA);
  await client.close();

  assert.deepEqual(transport.requests.map(({ message }) => message.method), [
    "initialize",
    "notifications/initialized",
    "tools/call",
    "tools/call",
    "tools/call",
    "tools/call",
    "session/close",
  ]);
  const calls = transport.requests.filter(({ message }) => message.method === "tools/call");
  assert.deepEqual(calls.slice(0, 3).map(({ message }) => (
    ((message.params as Record<string, unknown>).arguments as Record<string, unknown>).query
  )), ["/", "#", "@"]);
  assert.equal(
    ((calls[3]!.message.params as Record<string, unknown>).arguments as Record<string, unknown>).token,
    "/compose-cart",
  );
});

test("accepts SSE JSON-RPC frames over a fetch-compatible function", async () => {
  const transport = await createFakeTransport({ sse: true });
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  const result = await client.resolve("@cart");
  assert.equal(result.invocation.kind, "binding");
});

test("fails closed when catalog slices disagree on revision-bound metadata", async () => {
  const transport = await createFakeTransport({
    mutatePayload(payload, message) {
      const args = ((message.params as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;
      if (args.query === "#") payload.routingDigest = "f".repeat(64);
    },
  });
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  await rejectsWithCode(client.hydrate(), "catalog_drift");
});

test("recomputes both catalog and routing digests before accepting hydration", async () => {
  const transport = await createFakeTransport({
    mutatePayload(payload) {
      payload.catalogDigest = "e".repeat(64);
    },
  });
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  await rejectsWithCode(client.hydrate(), "catalog_drift");
});

test("rejects incomplete full counts and truncated sigil slices", async () => {
  const transport = await createFakeTransport({
    mutatePayload(payload, message) {
      const args = ((message.params as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;
      if (args.query === "/") payload.truncated = true;
    },
  });
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  await rejectsWithCode(client.hydrate(), "invalid_catalog");
});

test("compares an exact token result with its verified full-catalog entry", async () => {
  const transport = await createFakeTransport({
    mutatePayload(payload, message) {
      const args = ((message.params as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;
      if (args.token === "/compose-cart") {
        payload.invocation = { ...(payload.invocation as Record<string, unknown>), summary: "drifted" };
      }
    },
  });
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  await rejectsWithCode(client.resolve("/compose-cart"), "catalog_drift");
});

test("reports an exact unknown token only after verifying the current catalog proof", async () => {
  const transport = await createFakeTransport();
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  await rejectsWithCode(client.resolve("/not-registered"), "invocation_not_found");
  assert.equal(transport.requests.at(-1)?.message.method, "tools/call");
});

test("rejects aliases, whitespace, value-bearing bindings, and oversized tokens before I/O", async () => {
  const transport = await createFakeTransport();
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: transport.fetch,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  for (const token of [" /compose-cart", "/Compose-cart", "compose-cart", "@url:https://example.com", `/${"a".repeat(128)}`]) {
    await rejectsWithCode(client.resolve(token), "invalid_input");
  }
  assert.equal(transport.requests.length, 0);
});

test("requires a strong discovery credential before provider I/O", async () => {
  const transport = await createFakeTransport();
  for (const bearerToken of [undefined, "", "too-short"]) {
    expect(() => createInvocationClient({
      endpoint: ENDPOINT,
      fetcher: transport.fetch,
      ...(bearerToken === undefined ? {} : { bearerToken }),
    })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  }
  assert.equal(transport.requests.length, 0);
});

test("bounds response bytes before parsing JSON-RPC", async () => {
  const oversized: FetchFunction = async (_input, init) => {
    const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { padding: "x".repeat(300) } }), {
      headers: { "mcp-session-id": SESSION_ID },
    });
  };
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: oversized,
    bearerToken: DISCOVERY_CREDENTIAL,
    maxResponseBytes: 128,
  });
  await rejectsWithCode(client.hydrate(), "response_too_large");
});

test("rejects a session identifier that changes after initialization", async () => {
  const transport = await createFakeTransport();
  const changedSession: FetchFunction = async (input, init) => {
    const response = await transport.fetch(input, init);
    const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (message.method !== "tools/call") return response;
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json", "mcp-session-id": "different-session" },
    });
  };
  const client = createInvocationClient({
    endpoint: ENDPOINT,
    fetcher: changedSession,
    bearerToken: DISCOVERY_CREDENTIAL,
  });
  await rejectsWithCode(client.hydrate(), "invalid_mcp_response");
});
