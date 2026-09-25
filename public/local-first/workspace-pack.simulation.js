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
    || !Number.isSafeInteger(state.runId) || state.runId < 1 || typeof state.recovered !== 'boolean') {
    throw Error('simulation_state_invalid')
  }
}
export function startSimulation(scenario, runId) {
  const state = { scenario, runId, stage: 'triage', recovered: false }
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
  if (state.runId !== runId || state.stage !== 'recovery' || state.recovered) throw Error('simulation_recovery_not_reviewable')
  return Object.freeze({ ...state, recovered: true })
}
export function inspectSimulation(state) {
  validate(state)
  const scenario = SCENARIOS[state.scenario]
  return Object.freeze({ name: scenario.name, scope: scenario.scope, runId: state.runId, stage: state.stage,
    recovered: state.recovered, outcome: state.recovered && state.stage === 'recovery' ? scenario.after : scenario.before,
    heading: state.stage === 'triage' ? 'Initial signal' : state.stage === 'diagnosis' ? 'Understand the condition' : 'Review the next step',
    explanation: state.stage === 'triage' ? scenario.signal : state.stage === 'diagnosis' ? scenario.diagnosis : scenario.recovery,
    result: state.recovered && state.stage === 'recovery' ? scenario.result : null })
}
