import { createHash } from "node:crypto";

import fc from "fast-check";
import { expect, test } from "vitest";

import {
  buildInvocationDigests,
  serializeInvocationCatalog,
  serializeInvocationRouting,
  validateToken,
  type InvocationCatalogEntry,
} from "../../src/invocation/catalog.js";

// Captured from Commerce's former serializer bodies before replacing them.
// These direct-call edges include normalization that catalog admission rejects earlier.
const ENTRIES = Object.freeze([
  Object.freeze({
    token: " /alpha ", kind: " COMMAND ", label: " Label ", summary: " Summary ",
    sourcePath: " path ", mcpTools: ["one", "one", "two", ""],
    semantics: ["#tag", "#tag", "/invalid"], bindings: ["@url:", "invalid"],
  }),
  Object.freeze({
    token: "@url:", kind: "binding", label: "URL", summary: "",
    sourcePath: "binding", mcpTool: "lookup",
  }),
]) as unknown as readonly InvocationCatalogEntry[];

const CATALOG_BYTES = '[{"token":"@url:","kind":"binding","label":"URL","summary":"","sourcePath":"binding"},{"token":"/alpha","kind":"command","label":"Label","summary":"Summary","sourcePath":"path"}]\n';
const ROUTING_BYTES = '{"schema":"agentic-canvas-os-docs-routing/v1","routes":[{"token":"@url:","kind":"binding","sourcePath":"binding","mcpTools":["lookup"],"semantics":[],"bindings":[]},{"token":"/alpha","kind":"command","sourcePath":"path","mcpTools":["one","two"],"semantics":["#tag"],"bindings":["@url:"]}]}\n';

test("shared serializer preserves Commerce's catalog and routing wire bytes and digests", async () => {
  expect(serializeInvocationCatalog(ENTRIES)).toBe(CATALOG_BYTES);
  expect(serializeInvocationRouting(ENTRIES)).toBe(ROUTING_BYTES);
  expect(await buildInvocationDigests(ENTRIES)).toEqual({
    catalogDigest: "258e227fa58605ecbe70134eda6146a1df692df72c7088997b6bf82a33b9d48a",
    routingDigest: "afa8989408aa0de0a7fec756093c5165e69c88ee8f7e045d31f1ca27f383ce09",
  });
  expect(createHash("sha256").update(CATALOG_BYTES).digest("hex"))
    .toBe("258e227fa58605ecbe70134eda6146a1df692df72c7088997b6bf82a33b9d48a");
});

test("catalog and routing proofs ignore entry input order without changing Commerce token admission", () => {
  fc.assert(fc.property(fc.shuffledSubarray([...ENTRIES], { minLength: 2, maxLength: 2 }), (ordered) => {
    expect(serializeInvocationCatalog(ordered)).toBe(CATALOG_BYTES);
    expect(serializeInvocationRouting(ordered)).toBe(ROUTING_BYTES);
  }), { numRuns: 50, seed: 20_260_923 });

  expect(validateToken("/a_b", "invalid_input")).toBe("/a_b");
  expect(validateToken("/query:", "invalid_input")).toBe("/query:");
  expect(() => validateToken("@url:https://example.invalid/", "invalid_input"))
    .toThrowError(expect.objectContaining({ code: "invalid_input" }));
});
