// Local educational fixtures. Native owner checks bind these expected outcomes;
// this module neither evaluates live policy nor obtains authority to call a service.
const scenarios = {
  calm: {
    name: 'Calm', scope: 'Workspace Pack',
    before: { status: 200, code: null }, after: { status: 200, code: null },
    signal: 'The service descriptor identifies a free Workspace Pack conversion.',
    diagnosis: 'The readiness fixture is healthy. A registered browser tool is availability evidence, not an agent connection.',
    recovery: 'Keep the service unchanged. Finish the rehearsal with an observation-only outcome.',
    result: 'Observation complete. The simulated service remains ready.',
    owner: 'src/local-first/workspace-pack.ts',
  },
  checkout: {
    name: 'Checkout', scope: 'Sandbox checkout',
    before: { status: 403, code: 'checkout_confirmation_required' }, after: { status: 200, code: null },
    signal: 'A simulated checkout request has an invalid confirmation token. Creation is refused before provider access.',
    diagnosis: 'The checkout owner checks origin, session-bound confirmation and content type before accepting the reviewed offer.',
    recovery: 'Reopen the sandbox offer and review it with a fresh session-bound confirmation. The fixture then permits one test checkout.',
    result: 'The simulated reviewed request is accepted. Its payment remains pending.',
    owner: 'src/local-first/checkout.ts',
  },
  timeout: {
    name: 'Timeout', scope: 'Workspace Pack request',
    before: { status: 504, code: null }, after: { status: 200, code: null },
    signal: 'The simulated request body does not finish before the service deadline. No verified result is available.',
    diagnosis: 'The request deadline interrupts unfinished input. Missing output cannot be treated as a completed pack.',
    recovery: 'Keep the original source, review it again and make one fresh request after the interruption ends.',
    result: 'The simulated retry returns four files. A real request must verify every returned digest.',
    owner: 'src/local-first/workspace-pack.ts',
  },
  payment: {
    name: 'Payment', scope: 'Sandbox delivery',
    before: { status: 409, code: 'sandbox_success_required' }, after: { status: 200, code: null },
    signal: 'A simulated unpaid checkout cannot download its deliverable.',
    diagnosis: 'Delivery requires a provider-verified session with both complete and paid states. A return URL does not prove payment.',
    recovery: 'Recheck the same sandbox session. Only a verified completed test payment can unlock the simulated download.',
    result: 'The completed-and-paid fixture permits its simulated download. No payment was made.',
    owner: 'src/local-first/checkout.ts',
  },
  backlog: {
    name: 'Backlog', scope: 'Local Workspace Pack host',
    before: { status: 503, code: 'workspace_pack_busy' }, after: { status: 200, code: null },
    signal: 'Four simulated requests occupy the local host. An additional request is refused.',
    diagnosis: 'The local host bounds concurrent work at four requests. It rejects excess work rather than creating a hidden queue.',
    recovery: 'Let active work finish, then review and retry once. Keep the capacity bound unchanged.',
    result: 'The simulated active requests finish and one fresh request is accepted.',
    owner: 'src/local-host/workspace-pack-host.ts',
  },
}
for (const scenario of Object.values(scenarios)) {
  Object.freeze(scenario.before); Object.freeze(scenario.after); Object.freeze(scenario)
}
export const SCENARIOS = Object.freeze(scenarios)
export const STAGES = Object.freeze(['triage', 'diagnosis', 'recovery'])
function validate(state) {
  if (!state || !Object.hasOwn(SCENARIOS, state.scenario) || !STAGES.includes(state.stage)
    || !Number.isSafeInteger(state.runId) || state.runId < 1 || typeof state.recovered !== 'boolean' || typeof state.rejected !== 'boolean') {
    throw Error('simulation_state_invalid')
  }
}
export function startSimulation(scenario, runId) {
  const state = { scenario, runId, stage: 'triage', recovered: false, rejected: false }
  validate(state)
  return Object.freeze(state)
}
export function selectStage(state, stage) {
  validate(state)
  if (!STAGES.includes(stage)) throw Error('simulation_stage_invalid')
  return Object.freeze({ ...state, stage })
}
export function applyRecovery(state, runId) {
  validate(state)
  if (state.runId !== runId || state.stage !== 'recovery' || state.recovered || state.rejected) throw Error('simulation_recovery_not_reviewable')
  return Object.freeze({ ...state, recovered: true })
}
export function inspectSimulation(state) {
  validate(state)
  const scenario = SCENARIOS[state.scenario]
  return Object.freeze({ name: scenario.name, scope: scenario.scope, runId: state.runId, stage: state.stage,
    recovered: state.recovered, rejected: state.rejected, outcome: state.recovered && state.stage === 'recovery' ? scenario.after : scenario.before,
    heading: state.stage === 'triage' ? 'Initial signal' : state.stage === 'diagnosis' ? 'Understand the condition' : 'Review the next step',
    explanation: state.stage === 'triage' ? scenario.signal : state.stage === 'diagnosis' ? scenario.diagnosis : scenario.recovery,
    result: state.recovered && state.stage === 'recovery' ? scenario.result : null })
}

export function rejectRecovery(state, runId) {
  applyRecovery(state, runId) // Reuse the same exact-run and stage gate without applying its result.
  return Object.freeze({ ...state, rejected: true })
}
const schema = properties => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties })
const runId = { type: 'integer', minimum: 1 }
export const CONSOLE_TOOLS = Object.freeze([
  { key: 'inspect', title: 'Inspect Console', effect: 'Read', description: 'Read service status and this tab’s rehearsal metadata. No source or generated files.', inputSchema: schema({}) },
  { key: 'rehearse', title: 'Start rehearsal', effect: 'Local simulation', description: 'Replace only the local rehearsal with a chosen scenario. No service request.', inputSchema: schema({ scenario: { type: 'string', enum: Object.keys(SCENARIOS) } }) },
  { key: 'stage', title: 'Select response stage', effect: 'Local simulation', description: 'Choose an explanation stage for the exact current rehearsal run. Grants no service authority.', inputSchema: schema({ runId, stage: { type: 'string', enum: STAGES } }) },
  { key: 'diagnose', title: 'Read diagnosis', effect: 'Read', description: 'Read the selected fixture’s native cause after entering Diagnosis or Recovery.', inputSchema: schema({ runId }) },
  { key: 'propose', title: 'Prepare recovery review', effect: 'Review proposal', description: 'Show a recovery proposal for the exact current simulated run. Only the visible human controls can apply or reject it.', inputSchema: schema({ runId }) },
].map(tool => Object.freeze({ ...tool, name: `commerce.console.${tool.key}` })))
export function toolGate(key, state) {
  if (!CONSOLE_TOOLS.some(tool => tool.key === key)) return 'Unknown capability'
  if (key === 'inspect' || key === 'rehearse') return null
  if (!state) return 'Run a rehearsal first'
  validate(state)
  if (key === 'stage') return null
  if (key === 'diagnose' && state.stage === 'triage') return 'Needs Diagnosis or Recovery'
  if (key === 'propose') {
    if (state.stage !== 'recovery') return 'Needs Recovery'
    if (state.recovered || state.rejected) return 'Decision recorded; start a new run'
  }
  return null
}
export function validateToolInput(key, input, state) {
  const tool = CONSOLE_TOOLS.find(tool => tool.key === key)
  if (!tool || !input || typeof input !== 'object' || Array.isArray(input)) throw Error('console_input_invalid')
  const keys = Object.keys(tool.inputSchema.properties)
  if (Object.keys(input).length !== keys.length || keys.some(name => !Object.hasOwn(input, name))) throw Error('console_input_invalid')
  for (const [name, spec] of Object.entries(tool.inputSchema.properties)) {
    if (spec.type === 'integer' ? !Number.isSafeInteger(input[name]) || input[name] < 1 : typeof input[name] !== spec.type) throw Error('console_input_invalid')
    if (spec.enum && !spec.enum.includes(input[name])) throw Error('console_input_invalid')
  }
  const refusal = toolGate(key, state)
  if (refusal) throw Error(refusal)
  if (keys.includes('runId') && input.runId !== state.runId) throw Error('console_run_stale')
}
export function customerPreview(state) {
  validate(state)
  const scenario = SCENARIOS[state.scenario]
  const text = state.recovered ? scenario.result : {
    calm: 'Your free program pack is ready to prepare.',
    checkout: 'The sandbox checkout needs a fresh review before it can start.',
    timeout: 'The sample request timed out. Keep your source and review a fresh attempt.',
    payment: 'This sample download is waiting for a verified test payment.',
    backlog: 'The sample service is at capacity. Wait for active work to finish before retrying.',
  }[state.scenario]
  return Object.freeze({ scope: scenario.scope, text, tone: state.recovered || state.scenario === 'calm' ? 'ready' : 'attention',
    decision: state.rejected ? 'Recovery declined. The simulated condition is unchanged.' : null })
}
