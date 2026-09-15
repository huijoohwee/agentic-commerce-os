// Product admission remains here; generic persistence has one upstream owner.
import { normalizeJson, serializedJsonLength } from "agentic-os/context/json";
import { MAX_RECORD_CHARS, requireNamespace, operate } from "agentic-os/agents/durable-object-transport";

export function createDurableObjectCommerceAdmissionStore({
  namespace,
  maxRecordChars = MAX_RECORD_CHARS,
} = {}) {
  const owner = requireNamespace(namespace);
  const scope = "commerce-admission:operator-registry";

  async function snapshot(knownRevision = null) {
    if (!(knownRevision === null || /^[0-9a-f]{64}$/u.test(knownRevision))) {
      throw new TypeError("Known commerce projection revision is malformed.");
    }
    const result = await operate(owner, scope, "commerce-admission-list", { knownRevision });
    if (!(result.registrations === null || Array.isArray(result.registrations))
      || typeof result.revision !== "string"
      || !/^[0-9a-f]{64}$/u.test(result.revision)) {
      throw new TypeError("Durable commerce admission list returned invalid evidence.");
    }
    return Object.freeze({
      revision: result.revision,
      registrations: result.registrations === null
        ? null
        : Object.freeze([...result.registrations]),
    });
  }

  return Object.freeze({
    async register(value) {
      const input = normalizeJson(value, "commerceAdmission");
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("commerceAdmission must be an object.");
      }
      if (serializedJsonLength(input) > maxRecordChars) {
        throw new RangeError(`commerceAdmission exceeds ${maxRecordChars} characters.`);
      }
      return operate(owner, scope, "commerce-admission-register", input);
    },
    snapshot,
    async list() {
      return [...(await snapshot(null)).registrations];
    },
    stats: () => Object.freeze({
      persistence: "durable-object",
      atomicFenceAndOutcome: true,
      revisionedProjectionSnapshot: true,
      permanent: true,
      owner: "commerce-admission-provider",
      keyNamespace: "commerce-admission:",
      bindingsAdded: 0,
    }),
  });
}
