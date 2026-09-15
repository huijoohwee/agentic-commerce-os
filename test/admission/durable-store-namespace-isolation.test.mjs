import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("every durable-object state store scope prefix is unique per factory", async () => {
  const text = (await Promise.all([
    fileURLToPath(new URL("../../src/admission/durable-object-state-store.js", import.meta.url)),
    fileURLToPath(import.meta.resolve("agentic-os/agents/durable-object-store")),
    fileURLToPath(import.meta.resolve("agentic-os/agents/durable-object-state-store")),
  ].map((file) => readFile(file, "utf8")))).join("\n");
  // Split the file into factory bodies so a prefix used twice inside one
  // factory (the same namespace) does not read as a cross-factory collision.
  const factoryBodies = text.split(/export function createDurableObject/).slice(1);
  assert.ok(factoryBodies.length >= 7, `expected at least 7 store factories, found ${factoryBodies.length}`);
  const prefixSets = factoryBodies.map((body) => {
    const prefixes = [...body.matchAll(/`([a-z0-9-]+):\$\{/g)].map((match) => match[1]);
    return new Set(prefixes);
  });
  const allPrefixes = prefixSets.flatMap((set) => [...set]);
  assert.ok(allPrefixes.includes("skill-draft"), "the skill-draft prefix must be declared");
  assert.ok(allPrefixes.includes("skill-draft-index"), "the skill-draft-index prefix must be declared");
  const collisions = [];
  for (let outer = 0; outer < prefixSets.length; outer += 1) {
    for (let inner = outer + 1; inner < prefixSets.length; inner += 1) {
      for (const prefix of prefixSets[outer]) {
        if (prefixSets[inner].has(prefix)) collisions.push(prefix);
      }
    }
  }
  assert.deepEqual(collisions, [], "no two store factories may share a scope prefix");
});
