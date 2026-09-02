import {
  WEBMCP_CLIENT_RUNTIME,
  WEBMCP_CLIENT_RUNTIME_SHA256,
} from '../edge/client/webmcp-runtime.js'

export const WEBMCP_SANDBOX_INPUT_CONTRACT = 'agentic-graph-webmcp-isolation-input/v1'
export const WEBMCP_SANDBOX_RESULT_CONTRACT = 'agentic-graph-webmcp-isolation-result/v1'

export type WebMcpSandboxInput = Readonly<{
  contract: typeof WEBMCP_SANDBOX_INPUT_CONTRACT
  scenario: 'registration-drift'
  runtimeSource: typeof WEBMCP_CLIENT_RUNTIME
  runtimeDigest: typeof WEBMCP_CLIENT_RUNTIME_SHA256
}>

export type WebMcpSandboxResult = Readonly<{
  contract: typeof WEBMCP_SANDBOX_RESULT_CONTRACT
  status: 'completed'
  runtimeDigest: string
  toolNames: readonly string[]
  toolCount: number
  registeredInMs: number
  recordedDigest: string
  observedDigest: string
  driftRefused: true
  driftEventCount: 1
  actionInvocationCount: 0
}>

export function webMcpSandboxInput(): WebMcpSandboxInput {
  return Object.freeze({
    contract: WEBMCP_SANDBOX_INPUT_CONTRACT,
    scenario: 'registration-drift',
    runtimeSource: WEBMCP_CLIENT_RUNTIME,
    runtimeDigest: WEBMCP_CLIENT_RUNTIME_SHA256,
  })
}

export function validWebMcpSandboxInput(value: unknown): value is WebMcpSandboxInput {
  return value !== null
    && typeof value === 'object'
    && Object.keys(value).sort().join(',') === 'contract,runtimeDigest,runtimeSource,scenario'
    && 'contract' in value
    && value.contract === WEBMCP_SANDBOX_INPUT_CONTRACT
    && 'scenario' in value
    && value.scenario === 'registration-drift'
    && 'runtimeSource' in value
    && value.runtimeSource === WEBMCP_CLIENT_RUNTIME
    && 'runtimeDigest' in value
    && value.runtimeDigest === WEBMCP_CLIENT_RUNTIME_SHA256
}

export function readWebMcpSandboxResult(value: unknown): WebMcpSandboxResult | null {
  if (value === null
    || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== [
      'actionInvocationCount', 'contract', 'driftEventCount', 'driftRefused', 'observedDigest',
      'recordedDigest', 'registeredInMs', 'runtimeDigest', 'status', 'toolCount', 'toolNames',
    ].sort().join(',')
    || !('contract' in value) || value.contract !== WEBMCP_SANDBOX_RESULT_CONTRACT
    || !('status' in value) || value.status !== 'completed'
    || !('runtimeDigest' in value) || value.runtimeDigest !== WEBMCP_CLIENT_RUNTIME_SHA256
    || !('toolNames' in value) || !Array.isArray(value.toolNames)
    || value.toolNames.join(',') !== 'commerce.catalog.search,commerce.offer.select,commerce.checkout.initiate'
    || !('toolCount' in value) || value.toolCount !== 3
    || !('registeredInMs' in value) || typeof value.registeredInMs !== 'number'
    || !Number.isFinite(value.registeredInMs) || value.registeredInMs < 0 || value.registeredInMs > 2_000
    || !('recordedDigest' in value) || typeof value.recordedDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.recordedDigest)
    || !('observedDigest' in value) || typeof value.observedDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.observedDigest) || value.observedDigest === value.recordedDigest
    || !('driftRefused' in value) || value.driftRefused !== true
    || !('driftEventCount' in value) || value.driftEventCount !== 1
    || !('actionInvocationCount' in value) || value.actionInvocationCount !== 0) return null
  return Object.freeze({
    contract: WEBMCP_SANDBOX_RESULT_CONTRACT,
    status: 'completed',
    runtimeDigest: value.runtimeDigest,
    toolNames: Object.freeze([...value.toolNames]),
    toolCount: 3,
    registeredInMs: value.registeredInMs,
    recordedDigest: value.recordedDigest,
    observedDigest: value.observedDigest,
    driftRefused: true,
    driftEventCount: 1,
    actionInvocationCount: 0,
  })
}

export const WEBMCP_SANDBOX_TARGET_SOURCE = String.raw`
const expectedRuntimeDigest = ${JSON.stringify(WEBMCP_CLIENT_RUNTIME_SHA256)};
const runtimeSource = ${JSON.stringify(WEBMCP_CLIENT_RUNTIME)};
const events = [];
const registered = [];
const live = [];
let actionInvocationCount = 0;
const actions = Object.freeze({
  async searchCatalog() { actionInvocationCount += 1; return { ok: true, listings: [] }; },
  async selectOffer() { actionInvocationCount += 1; return { ok: true }; },
  async initiateCheckout() { actionInvocationCount += 1; return { ok: true }; }
});
const recordLocalEvent = async event => { events.push(event); };
const document = Object.freeze({
  modelContext: Object.freeze({
    async registerTool(definition, options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      registered.push(definition);
      live.push({ name: definition.name, inputSchema: definition.inputSchema });
    },
    async getTools() { return live; }
  })
});
${WEBMCP_CLIENT_RUNTIME}
const startedAt = performance.now();
await registerWebMcp();
const registeredInMs = Math.max(0, performance.now() - startedAt);
const metadata = definitions.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }));
const recordedDigest = await digest({
  tools: metadata.slice().sort((left, right) => left.name.localeCompare(right.name)),
  toolCount: metadata.length
});
live.push({ name: 'commerce.catalog.changed', inputSchema: { type: 'object' } });
const observed = nativeMetadata(live);
const observedDigest = await digest({
  tools: observed.slice().sort((left, right) => left.name.localeCompare(right.name)),
  toolCount: observed.length
});
const refusal = await registered[0]?.execute(
  { query: '', limit: 10 },
  { signal: new AbortController().signal }
);
const runtimeDigestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runtimeSource));
const runtimeDigest = [...new Uint8Array(runtimeDigestBytes)]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const toolNames = registered.map(({ name }) => name);
const driftEvents = events.filter(({ type }) => type === 'webmcp_registration_drift');
const ok = runtimeDigest === expectedRuntimeDigest
  && canonical(toolNames) === canonical([
    'commerce.catalog.search', 'commerce.offer.select', 'commerce.checkout.initiate'
  ])
  && toolNames.length >= 3 && toolNames.length <= MAXIMUM_REGISTERED_TOOLS
  && registeredInMs <= WEBMCP_REGISTRATION_LIMIT_MS
  && recordedDigest !== observedDigest
  && refusal?.code === 'webmcp_registration_drift'
  && driftEvents.length === 1
  && actionInvocationCount === 0;
process.stdout.write(JSON.stringify({
  ok,
  surfaceResult: {
    contract: ${JSON.stringify(WEBMCP_SANDBOX_RESULT_CONTRACT)},
    status: 'completed',
    runtimeDigest,
    toolNames,
    toolCount: toolNames.length,
    registeredInMs,
    recordedDigest,
    observedDigest,
    driftRefused: refusal?.code === 'webmcp_registration_drift',
    driftEventCount: driftEvents.length,
    actionInvocationCount
  }
}));
if (!ok) process.exitCode = 1;
`
