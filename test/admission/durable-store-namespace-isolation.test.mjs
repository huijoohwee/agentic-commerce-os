import test from "node:test";
import assert from "node:assert/strict";
import * as product from "../../src/admission/durable-object-state-store.js";
import * as agents from "agentic-os/agents/durable-object-store";
import * as adapters from "agentic-os/agents/durable-object-state-store";

test("every durable-object state store scope prefix is unique per factory", async () => {
  const factories = Object.fromEntries(Object.entries({ ...product, ...agents, ...adapters })
    .filter(([name]) => name.startsWith("createDurableObject")));
  const cases = {
    createDurableObjectCommerceAdmissionStore: [["list"], ["commerce-admission:operator-registry"]],
    createDurableObjectHumanReviewStore: [["take"], ["review:same-id"]],
    createDurableObjectPausedTurnStore: [["get"], ["paused-turn:same-id"]],
    createDurableObjectFunctionContinuationStore: [["get"], ["function-continuation:same-id"]],
    createDurableObjectFunctionExecutionReceiptStore: [["get"], ["function-execution:same-id"]],
    createDurableObjectSkillDraftStore: [["peek", "indexList"], ["skill-draft:same-id", "skill-draft-index:same-id"]],
    createDurableObjectSwarmRunStore: [["get"], ["swarm-run:same-id"]],
    createDurableObjectAgentToolkitStore: [["get"], ["agent-toolkit:same-id"]],
  };
  assert.deepEqual(Object.keys(factories).sort(), Object.keys(cases).sort(), "every exported factory needs namespace coverage");
  const owners = new Map();
  for (const [name, [methods, expected]] of Object.entries(cases)) {
    const observed = [];
    const namespace = {
      idFromName(scope) { observed.push(scope); return scope; },
      get(scope) {
        assert.ok(observed.includes(scope));
        return { fetch: async () => Response.json({ record: null, registrations: [], revision: "a".repeat(64) }) };
      },
    };
    const store = factories[name]({ namespace });
    for (const method of methods) await store[method]("same-id");
    assert.deepEqual(observed, expected, name + " must retain its persistence namespace");
    for (const scope of observed) {
      const prefix = scope.split(":")[0];
      assert.equal(owners.has(prefix), false, `${name} collides with ${owners.get(prefix)} at ${prefix}`);
      owners.set(prefix, name);
    }
  }
});
