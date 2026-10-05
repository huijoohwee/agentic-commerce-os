import { groupProjects, validDraft, validLaunchTerms, LIMITS as DRAFT_LIMITS } from './drafts.js';
import { evaluateOfferSetup } from './launch.js';

export const WORKSPACE_LIMITS = Object.freeze({ requestBytes: 196608, resultBytes: 196608, deadlineMs: 5000 });
const SNAPSHOT = 'commerce.workspace-snapshot/v1';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Error('workspace_' + code); };
const text = (maxLength, pattern) => ({ type: 'string', minLength: 1, maxLength, ...(pattern ? { pattern } : {}) });
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const id = text(36, '^[0-9a-f-]{36}$');
const termProperties = Object.fromEntries(['merchantId', 'agentId'].map(key => [key, text(128, '^[a-z0-9][a-z0-9._-]{0,127}$')]));
for (const key of ['audience', 'outcome']) termProperties[key] = text(280);
termProperties.currency = text(3, '^[A-Z]{3}$');
for (const key of ['priceMinor', 'deliveryCostMinor', 'providerFeeMinor', 'agentCostMinor', 'acquisitionCostMinor', 'fixedCostMinor']) {
  termProperties[key] = { type: 'integer', minimum: key === 'priceMinor' ? 1 : 0, maximum: 1000000000 };
}
const launchSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
  required: Object.keys(termProperties), properties: termProperties }] };
const offerProperties = { id, title: text(120), revision: integer, updatedAt: integer, launch: launchSchema };
const snapshotSchema = { type: 'object', additionalProperties: false, required: ['schema', 'offers'],
  properties: { schema: { const: SNAPSHOT }, offers: { type: 'array', maxItems: DRAFT_LIMITS.count,
    items: { type: 'object', additionalProperties: false, required: Object.keys(offerProperties), properties: offerProperties } } } };
function definition(name, title, description, properties = {}, required = []) {
  return Object.freeze({ name: 'commerce.workspace.' + name, title, description,
    inputSchema: { type: 'object', additionalProperties: false, required,
      properties: { ...properties, ...(name === 'environment.read' ? {} : { snapshot: snapshotSchema }) } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
}
export const WORKSPACE_TOOLS = Object.freeze([
  definition('projects.list', 'Find projects', 'Find merchant projects in browser drafts or an explicitly provided offer snapshot.', { query: { type: 'string', maxLength: 120 } }),
  definition('project.read', 'Inspect a project', 'Read project offers and revision numbers. No hosted infrastructure is managed.', { projectId: text(140) }, ['projectId']),
  definition('offer.review', 'Check offer readiness', 'Calculate estimates for an exact offer revision. Does not approve, export or publish.',
    { offerId: id, expectedRevision: integer }, ['offerId', 'expectedRevision']),
  definition('environment.read', 'Inspect environment', 'Read the current local-first runtime configuration. Does not prove deployment, payment or fulfillment.'),
]);
export function workspaceSnapshot(drafts) {
  if (!Array.isArray(drafts) || drafts.length > DRAFT_LIMITS.count || !drafts.every(draft => validDraft(draft))) fail('drafts_invalid');
  return validateSnapshot({ schema: SNAPSHOT, offers: drafts.map(({ id, title, revision, updatedAt, launch }) => ({ id, title, revision, updatedAt, launch: structuredClone(launch) })) });
}
function validateSnapshot(value) {
  if (!record(value) || Object.keys(value).sort().join() !== 'offers,schema' || value.schema !== SNAPSHOT
    || !Array.isArray(value.offers) || value.offers.length > DRAFT_LIMITS.count) fail('snapshot_invalid');
  for (const offer of value.offers) {
    if (!record(offer) || Object.keys(offer).sort().join() !== 'id,launch,revision,title,updatedAt'
      || typeof offer.id !== 'string' || !/^[0-9a-f-]{36}$/.test(offer.id)
      || typeof offer.title !== 'string' || !offer.title.trim() || offer.title.length > 120
      || !Number.isSafeInteger(offer.revision) || offer.revision < 1
      || !Number.isSafeInteger(offer.updatedAt) || offer.updatedAt < 1
      || offer.launch !== null && !validLaunchTerms(offer.launch)) fail('snapshot_invalid');
  }
  if (new Set(value.offers.map(offer => offer.id)).size !== value.offers.length) fail('snapshot_duplicate');
  if (new TextEncoder().encode(JSON.stringify(value)).length > WORKSPACE_LIMITS.requestBytes - 4096) fail('snapshot_limit');
  return structuredClone(value);
}
export function validateWorkspaceInput(name, args) {
  const tool = WORKSPACE_TOOLS.find(tool => tool.name === name);
  if (!tool) fail('tool_unknown');
  if (!record(args) || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))
    || tool.inputSchema.required.some(key => !Object.hasOwn(args, key))) fail('arguments_invalid');
  if ('query' in args && (typeof args.query !== 'string' || args.query.length > 120)) fail('query_invalid');
  if ('projectId' in args && (typeof args.projectId !== 'string' || !/^(?:local:unassigned|store:[a-z0-9][a-z0-9._-]{0,127})$/.test(args.projectId))) fail('project_invalid');
  if ('offerId' in args && (typeof args.offerId !== 'string' || !/^[0-9a-f-]{36}$/.test(args.offerId))) fail('offer_invalid');
  if ('expectedRevision' in args && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1)) fail('revision_invalid');
  return { ...args, ...('snapshot' in args ? { snapshot: validateSnapshot(args.snapshot) } : {}) };
}
export function parseWorkspaceInvocation(expression, routing) {
  if (typeof expression !== 'string' || expression.length > 300 || !record(routing)) fail('invocation_invalid');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 4 || parts[0] !== routing.commandToken || parts[1] !== routing.bindingToken
    || parts[2] !== routing.semanticToken || !WORKSPACE_TOOLS.some(tool => tool.name === parts[3])) fail('invocation_invalid');
  return parts[3];
}
export async function workspaceWait(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) fail('cancelled');
  let cancel;
  const aborted = new Promise((_, reject) => { cancel = () => reject(Error('workspace_cancelled')); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
export async function invokeWorkspace(name, input, context = {}) {
  const args = validateWorkspaceInput(name, input);
  if (context.signal?.aborted) fail('cancelled');
  let value, provenance;
  if (name.endsWith('.environment.read')) {
    if (!context.environment) fail('environment_unavailable');
    value = await workspaceWait(context.environment(context.signal), context.signal); provenance = 'runtime-observation';
  } else {
    const snapshot = args.snapshot ?? (context.snapshot ? await workspaceWait(context.snapshot(), context.signal) : fail('snapshot_required'));
    const offers = validateSnapshot(snapshot).offers, projects = groupProjects(offers);
    provenance = args.snapshot ? 'provided-snapshot' : 'browser-local';
    const status = offer => evaluateOfferSetup(offer).status;
    const summary = project => ({ id: project.id, name: project.name, offerCount: project.offers.length,
      reviewableCount: project.offers.filter(offer => status(offer) === 'reviewable').length });
    if (name.endsWith('.projects.list')) {
      const query = (args.query ?? '').trim().toLowerCase();
      value = { projects: projects.filter(project => [project.name, ...project.offers.map(offer => offer.title)]
        .some(value => value.toLowerCase().includes(query))).map(summary) };
    } else if (name.endsWith('.project.read')) {
      const project = projects.find(project => project.id === args.projectId);
      if (!project) fail('project_missing');
      value = { ...summary(project), offers: project.offers.map(offer => ({ id: offer.id, title: offer.title,
        revision: offer.revision, updatedAt: offer.updatedAt, status: status(offer) })) };
    } else {
      const offer = offers.find(offer => offer.id === args.offerId);
      if (!offer) fail('offer_missing');
      if (offer.revision !== args.expectedRevision) fail('revision_changed');
      const setup = evaluateOfferSetup(offer);
      value = { id: offer.id, title: offer.title, revision: offer.revision, status: setup.status,
        economics: setup.economics, humanReview: 'still-required', setup };
    }
  }
  if (context.signal?.aborted) fail('cancelled');
  const result = { schema: 'commerce.workspace-result/v1', tool: name, provenance, readOnly: true, value };
  if (new TextEncoder().encode(JSON.stringify(result)).length > WORKSPACE_LIMITS.resultBytes) fail('result_limit');
  return result;
}
