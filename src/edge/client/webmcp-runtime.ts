/** Exact browser runtime also embedded in the isolated WebMCP proof target. */
export const WEBMCP_CLIENT_RUNTIME_SHA256 = '5e71a34f97d6eb7ddb2a712a8e4609b752c874bb08f44b1ca5f9335dea133d17'

export const WEBMCP_CLIENT_RUNTIME = String.raw`
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
};

const digest = async value => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = Object.freeze([
  Object.freeze({
    name: 'commerce.catalog.search', title: 'Search storefront catalog',
    description: 'Search the current storefront catalog with a bounded shopper query.',
    inputSchema: schema({ query: { type: 'string', maxLength: 280 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query', 'limit']),
    outputSchema: schema({ ok: { const: true }, query: { type: 'string' }, limit: { type: 'integer' }, listings: { type: 'array' } }, ['ok', 'query', 'limit', 'listings']),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: input => actions.searchCatalog(input)
  }),
  Object.freeze({
    name: 'commerce.offer.select', title: 'Select one storefront offer',
    description: 'Select one offer previously returned by the current storefront catalog.',
    inputSchema: schema({ listingId: { type: 'string', maxLength: 128 }, offerId: { type: 'string', maxLength: 128 } }, ['listingId', 'offerId']),
    outputSchema: schema({ ok: { type: 'boolean' }, listingId: { type: 'string' }, offerId: { type: 'string' }, amountMinor: { type: 'integer' }, currency: { type: 'string' }, code: { type: 'string' } }, ['ok']),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: input => actions.selectOffer(input)
  }),
  Object.freeze({
    name: 'commerce.checkout.initiate', title: 'Initiate a guarded checkout',
    description: 'Prepare the selected offer for a separate human-confirmation step; this tool cannot settle.',
    inputSchema: schema({ offerId: { type: 'string', maxLength: 128 }, amountMinor: { type: 'integer', minimum: 1 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, ['offerId', 'amountMinor', 'currency']),
    outputSchema: schema({ ok: { type: 'boolean' }, checkoutId: { type: 'string' }, state: { const: 'awaiting-human-confirmation' }, code: { type: 'string' } }, ['ok']),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: input => actions.initiateCheckout(input)
  })
]);

const MAXIMUM_REGISTERED_TOOLS = 16;
const WEBMCP_REGISTRATION_LIMIT_MS = 2000;

const nativeMetadata = tools => {
  const outputSchemas = new Map(definitions.map(({ name, outputSchema }) => [name, outputSchema]));
  return tools.map(tool => ({
    name: tool.name,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { invalidNativeInputSchema: true },
    outputSchema: outputSchemas.get(tool.name) || { unknownNativeTool: true }
  }));
};

const registerWebMcp = async () => {
  if (!document.modelContext?.registerTool || !document.modelContext?.getTools) {
    await recordLocalEvent({ type: 'webmcp_surface_unavailable', absentApi: 'document.modelContext' });
    return;
  }
  if (definitions.length < 3 || definitions.length > MAXIMUM_REGISTERED_TOOLS) {
    await recordLocalEvent({ type: 'webmcp_registration_failed', reason: 'tool_count_out_of_bounds' });
    return;
  }
  const metadata = definitions.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }));
  const recordedDigest = await digest({ tools: metadata.slice().sort((left, right) => left.name.localeCompare(right.name)), toolCount: metadata.length });
  const registrationController = new AbortController();
  let registrationTimeout;
  try {
    const liveTools = await Promise.race([
      Promise.all(definitions.map(definition => document.modelContext.registerTool({
        name: definition.name,
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
        execute: async (input, options) => {
          const current = nativeMetadata(await document.modelContext.getTools());
          const observedDigest = await digest({ tools: current.slice().sort((left, right) => left.name.localeCompare(right.name)), toolCount: current.length });
          if (recordedDigest !== observedDigest) {
            const refusal = { ok: false, code: 'webmcp_registration_drift', invokedTool: definition.name, recordedDigest, observedDigest };
            registrationController.abort(new Error('webmcp_registration_drift'));
            await recordLocalEvent({ type: 'webmcp_registration_drift', ...refusal });
            return refusal;
          }
          if (options.signal.aborted) throw options.signal.reason;
          return definition.execute(input);
        }
      }, { signal: registrationController.signal }))).then(() => document.modelContext.getTools()),
      new Promise((_, reject) => {
        registrationTimeout = setTimeout(
          () => reject(new Error('webmcp_registration_timeout')),
          WEBMCP_REGISTRATION_LIMIT_MS
        );
      })
    ]);
    const observed = nativeMetadata(liveTools);
    const observedDigest = await digest({
      tools: observed.slice().sort((left, right) => left.name.localeCompare(right.name)),
      toolCount: observed.length
    });
    if (recordedDigest !== observedDigest) {
      registrationController.abort(new Error('webmcp_registration_drift'));
      await recordLocalEvent({ type: 'webmcp_registration_drift', invokedTool: 'registration', recordedDigest, observedDigest });
    }
  } catch (error) {
    registrationController.abort(error);
    await recordLocalEvent({
      type: error?.message === 'webmcp_registration_timeout'
        ? 'webmcp_registration_timeout'
        : 'webmcp_registration_failed'
    });
  } finally {
    if (registrationTimeout !== undefined) clearTimeout(registrationTimeout);
  }
};
`
