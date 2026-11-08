export const SECTION_ROUTES = Object.freeze([
  { id: "tokens", path: "/tokens", label: "Tokens" },
  { id: "profiles", path: "/profiles", label: "Profiles" },
  { id: "guidelines", path: "/guidelines", label: "Guidelines" },
  { id: "accessibility", path: "/accessibility", label: "Accessibility" },
  { id: "components", path: "/components", label: "Components" },
  { id: "examples", path: "/examples", label: "Examples" },
  { id: "releases", path: "/releases", label: "Releases" },
]);

export const REGISTRY_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "design_registry_search",
    title: "Search the design registry",
    description: "Search the local design ownership registry by text, /section, @owner, or #scope. This tool only reads the checked-in registry.",
    inputSchema: Object.freeze({
      type: "object",
      properties: { query: { type: "string", maxLength: 160, description: "Text, /section, @owner, or #scope." } },
      required: ["query"],
      additionalProperties: false,
    }),
    annotations: Object.freeze({ readOnlyHint: true }),
  }),
  Object.freeze({
    name: "design_registry_get",
    title: "Get a design registry record",
    description: "Read one exact owner, profile, token, catalog record, or section by its stable registry ID.",
    inputSchema: Object.freeze({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 320 },
        kind: { type: "string", enum: ["owner", "profile", "token", "record", "section"] },
      },
      required: ["id"],
      additionalProperties: false,
    }),
    annotations: Object.freeze({ readOnlyHint: true }),
  }),
]);

const SEARCH_TOOL = REGISTRY_TOOL_DEFINITIONS[0].name;
const GET_TOOL = REGISTRY_TOOL_DEFINITIONS[1].name;
const MAX_QUERY_CODE_POINTS = 160;
const lower = value => String(value ?? "").toLocaleLowerCase();
const includesTerm = (values, term) => values.some(value => lower(value).includes(term));

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactArgs(value, required, optional = []) {
  object(value, "Tool arguments");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError("Tool arguments do not match the declared input schema");
  }
}

function validateOwnerInventory(owners) {
  const ownerIds = new Set();
  const ownerRepositories = new Set();
  for (const owner of owners) {
    if (!owner || typeof owner.id !== "string" || ownerIds.has(owner.id)
      || typeof owner.repository !== "string" || ownerRepositories.has(owner.repository)
      || !Array.isArray(owner.scopes) || !Array.isArray(owner.sources)) {
      throw new TypeError("Registry owner inventory is incomplete or duplicated");
    }
    ownerIds.add(owner.id);
    ownerRepositories.add(owner.repository);
  }
}

export function validateRegistryContext(catalog, profiles) {
  object(catalog, "Catalog");
  const registry = object(catalog.registry, "Registry");
  if (catalog.catalogId !== "agentic-design-system"
    || registry.schema !== "agentic-design-system/owner-registry/v1"
    || registry.registryId !== "agentic-design-system"
    || !/^\d+\.\d+\.\d+$/u.test(registry.revision ?? "")
    || !Array.isArray(registry.owners) || !Array.isArray(registry.profiles)
    || !Array.isArray(profiles) || profiles.length !== registry.profiles.length
    || profiles.length < 1 || profiles.length > 12 || !Array.isArray(catalog.records)) {
    throw new TypeError("Registry context identity is incomplete");
  }
  validateOwnerInventory(registry.owners);
  const profileIds = new Set();
  const loadedProfiles = new Map();
  const globalKeys = new Set();
  const globalVariables = new Set();
  for (let index = 0; index < registry.profiles.length; index += 1) {
    const manifest = registry.profiles[index];
    const profile = object(profiles[index], "Profile");
    if (!manifest || typeof manifest.id !== "string" || profileIds.has(manifest.id)
      || manifest.status !== "candidate" || !Array.isArray(manifest.scope)
      || !Array.isArray(manifest.consumerPins) || profile.id !== manifest.id
      || profile.status !== "candidate" || profile.schema !== `agentic-design-system/${manifest.id}-profile/v1`
      || !Array.isArray(profile.tokens) || profile.tokens.length > 256) {
      throw new TypeError("Candidate profile inventory is incomplete or duplicated");
    }
    profileIds.add(manifest.id);
    const localKeys = new Set();
    const localVariables = new Set();
    for (const token of profile.tokens) {
      if (!token || typeof token.key !== "string" || typeof token.cssVar !== "string"
        || localKeys.has(token.key) || localVariables.has(token.cssVar)
        || globalKeys.has(`${manifest.id}:${token.key}`) || globalVariables.has(token.cssVar)) {
        throw new TypeError("Candidate token keys and CSS variables must be globally unique");
      }
      localKeys.add(token.key);
      localVariables.add(token.cssVar);
      globalKeys.add(`${manifest.id}:${token.key}`);
      globalVariables.add(token.cssVar);
    }
    loadedProfiles.set(manifest.id, profile);
  }
  const sectionIds = new Set();
  const sectionPaths = new Set();
  for (const route of SECTION_ROUTES) {
    if (!route.id || !/^\/[a-z0-9-]+$/u.test(route.path) || !route.label
      || sectionIds.has(route.id) || sectionPaths.has(route.path)) {
      throw new TypeError("Section navigation contains a duplicate or invalid route");
    }
    sectionIds.add(route.id);
    sectionPaths.add(route.path);
  }
  return { catalog, registry, profiles: loadedProfiles };
}

function parseQuery(query) {
  if (typeof query !== "string" || [...query].length > MAX_QUERY_CODE_POINTS) {
    throw new TypeError(`Search query must be a string of at most ${MAX_QUERY_CODE_POINTS} characters`);
  }
  const value = query.trim();
  if (value.startsWith("//")) throw new TypeError("Section queries must use a local /section path");
  const mode = value.startsWith("/") ? "section" : value.startsWith("@") ? "owner" : value.startsWith("#") ? "scope" : "text";
  const rawTerm = mode === "text" ? value : value.slice(1);
  const term = mode === "section" ? rawTerm.replace(/\/+$/u, "").toLocaleLowerCase() : lower(rawTerm);
  return { value, mode, term };
}

function ownerMatches(owner, { mode, term }) {
  if (mode === "section") return false;
  if (!term) return true;
  if (mode === "owner") return includesTerm([owner.id, owner.name, owner.repository], term);
  if (mode === "scope") return includesTerm(owner.scopes, term);
  return includesTerm([owner.id, owner.name, owner.repository, owner.role, ...owner.scopes,
    ...owner.sources.flatMap(source => [source.path, source.digest])], term);
}

function profileMatches(profile, manifest, { mode, term }) {
  if (mode === "section") return false;
  if (!term) return true;
  if (mode === "owner") return includesTerm([manifest.owner, manifest.repository, profile.scope?.repository ?? "",
    ...(manifest.consumerPins ?? []).map(pin => pin.repository)], term);
  if (mode === "scope") return includesTerm(manifest.scope, term);
  return includesTerm([profile.id, manifest.name, manifest.owner, manifest.repository, profile.status,
    ...manifest.scope, ...profile.tokens.flatMap(token => [token.key, token.cssVar, token.type])], term);
}

function tokenMatches(token, query) {
  if (!query.term || query.mode === "owner" || query.mode === "scope") return true;
  return query.mode === "text" && includesTerm([token.key, token.cssVar, token.type], query.term);
}

function sectionMatches(route, query) {
  if (query.mode === "section") return !query.term || route.path.slice(1).startsWith(query.term);
  return Boolean(query.term && query.mode === "text" && includesTerm([route.path, route.label, route.id], query.term));
}

function profileRow(manifest, profile, tokens) {
  return {
    ...manifest,
    kind: "profile",
    id: `profile:${manifest.id}`,
    tokenCount: profile.tokens.length,
    tokens: tokens.map(token => ({
      ...token,
      kind: "token",
      profileId: manifest.id,
      canonicalKey: `${manifest.id}:${token.key}`,
      id: `token:${manifest.id}:${token.key}`,
    })),
  };
}

export function searchRegistry(catalog, profiles, query) {
  const context = validateRegistryContext(catalog, profiles);
  const parsed = parseQuery(query);
  const { registry } = context;
  const owners = registry.owners.filter(owner => ownerMatches(owner, parsed)).map(owner => ({
    ...owner, kind: "owner", id: `owner:${owner.id}`, ownerId: owner.id,
  }));
  const profileRows = [];
  for (const manifest of registry.profiles) {
    const profile = context.profiles.get(manifest.id);
    const tokens = profile.tokens.filter(token => tokenMatches(token, parsed));
    if (profileMatches(profile, manifest, parsed) || (parsed.mode === "text" && tokens.length > 0)) {
      profileRows.push(profileRow(manifest, profile, tokens));
    }
  }
  const records = catalog.records.filter(record => {
    if (parsed.mode === "section") return false;
    if (parsed.mode === "owner") return includesTerm([record.owner], parsed.term);
    return includesTerm([record.id, record.name, record.concern, record.status, record.summary, record.owner], parsed.term);
  }).map(record => ({ ...record, kind: "record", id: `catalog:${record.id}` }));
  const sections = SECTION_ROUTES.filter(route => sectionMatches(route, parsed)).map(route => ({
    ...route, kind: "section", href: `#${route.id}`, id: `section:${route.path}`,
  }));
  return { registryId: registry.registryId, registryRevision: registry.revision, query, mode: parsed.mode,
    results: [...owners, ...profileRows, ...records, ...sections] };
}

function allRecords(catalog, profiles) {
  const context = validateRegistryContext(catalog, profiles);
  const { registry } = context;
  const rows = registry.owners.map(owner => ({ ...owner, kind: "owner", id: `owner:${owner.id}`, ownerId: owner.id }));
  for (const manifest of registry.profiles) {
    const profile = context.profiles.get(manifest.id);
    rows.push({ ...manifest, kind: "profile", id: `profile:${manifest.id}`, tokens: profile.tokens });
    for (const token of profile.tokens) rows.push({ ...token, kind: "token", profileId: manifest.id,
      canonicalKey: `${manifest.id}:${token.key}`, id: `token:${manifest.id}:${token.key}` });
  }
  for (const record of catalog.records) rows.push({ ...record, kind: "record", id: `catalog:${record.id}` });
  for (const route of SECTION_ROUTES) rows.push({ ...route, kind: "section", id: `section:${route.path}`, href: `#${route.id}` });
  return rows;
}

export function getRegistryRecord(catalog, profiles, id, kind) {
  if (typeof id !== "string" || !id.length || [...id].length > 320) {
    throw new TypeError("Record ID must be a non-empty string of at most 320 characters");
  }
  if (kind !== undefined && !["owner", "profile", "token", "record", "section"].includes(kind)) {
    throw new TypeError("Record kind is not supported");
  }
  const found = allRecords(catalog, profiles).find(row => row.id === id && (!kind || row.kind === kind));
  if (!found) throw new RangeError(`No ${kind ?? "registry"} record matches ${id}`);
  return found;
}

export function invokeRegistryTool(name, args, context) {
  object(context, "Registry context");
  const { catalog, profiles } = context;
  const loadedProfiles = profiles instanceof Map ? [...profiles.values()] : profiles;
  if (name === SEARCH_TOOL) {
    exactArgs(args, ["query"]);
    return searchRegistry(catalog, loadedProfiles, args.query);
  }
  if (name === GET_TOOL) {
    exactArgs(args, ["id"], ["kind"]);
    return getRegistryRecord(catalog, loadedProfiles, args.id, args.kind);
  }
  throw new RangeError(`Unknown design registry tool: ${String(name)}`);
}

export async function registerWebMcpTools(modelContext, context) {
  if (!modelContext || typeof modelContext.registerTool !== "function") return { supported: false, names: [] };
  const names = [];
  for (const definition of REGISTRY_TOOL_DEFINITIONS) {
    await modelContext.registerTool({
      ...definition,
      execute: async args => JSON.stringify(invokeRegistryTool(definition.name, args, context)),
    });
    names.push(definition.name);
  }
  return { supported: true, names };
}
