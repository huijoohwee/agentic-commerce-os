import { SCENARIOS, STAGES, CONSOLE_TOOLS, startSimulation, selectStage, applyRecovery,
  rejectRecovery, inspectSimulation, customerPreview, toolGate, validateToolInput } from './workspace-pack.simulation.js'

export function initConsole(bridge) {
  const $ = id => document.getElementById(id)
  const stages = [...document.querySelectorAll('[data-response-stage]')]
  const sheet = $('console-sheet'), registrations = new Map()
  let state = null, generation = 0, guide = null, timer = null, events = [], sequence = 0, closed = false
  let sheetMode = 'tools', sheetTrigger = null
  const push = message => {
    events.push({ index: ++sequence, message }); events = events.slice(-12)
  }
  const snapshot = () => ({ live: bridge.live(), rehearsal: state ? inspectSimulation(state) : null,
    events: [...events], guide: guide ? { mode: guide.mode, paused: guide.paused, runId: guide.runId } : null,
    capabilities: CONSOLE_TOOLS.map(tool => ({ name: tool.name, effect: tool.effect,
      registered: registrations.get(tool.key)?.ready === true, blocked: toolGate(tool.key, state) })) })
  function counts() {
    const registered = CONSOLE_TOOLS.filter(tool => registrations.get(tool.key)?.ready).length
    return { registered, available: CONSOLE_TOOLS.filter(tool => registrations.get(tool.key)?.ready && !toolGate(tool.key, state)).length,
      stage: state ? `${SCENARIOS[state.scenario].name} / ${state.stage}` : 'Idle', events: sequence }
  }
  function stopGuide(message) {
    clearTimeout(timer); timer = null
    if (guide && message) push(message)
    guide = null
  }
  function render() {
    const view = state ? inspectSimulation(state) : null
    $('simulation-report').hidden = !view
    $('simulation-status').textContent = view ? `${view.name} · ${view.recovered ? 'Simulation complete' : view.rejected ? 'Recovery declined' : 'Simulated condition loaded'}` : 'Choose a scenario and run the rehearsal.'
    stages.forEach(button => {
      button.disabled = !state
      button.setAttribute('aria-pressed', String(button.dataset.responseStage === (state?.stage ?? 'triage')))
    })
    if (view) {
      $('simulation-report-heading').textContent = view.heading
      $('simulation-scope').textContent = `Run ${view.runId} · ${view.scope}`
      $('simulation-signal').textContent = `Fixture HTTP ${view.outcome.status}${view.outcome.code ? ` · ${view.outcome.code}` : ''}`
      $('simulation-explanation').textContent = view.explanation
      $('simulation-result').hidden = !view.result && !view.rejected
      $('simulation-result').textContent = view.rejected ? 'You declined the proposal. Start a new run to review another recovery.' : view.result ?? ''
      for (const id of ['simulation-recover', 'simulation-reject']) {
        $(id).hidden = view.stage !== 'recovery'
        $(id).disabled = view.recovered || view.rejected
        $(id).dataset.runId = String(view.runId)
      }
    }
    $('rehearsal-preview').hidden = !state
    if (state) {
      const preview = customerPreview(state)
      $('preview-scope').textContent = preview.scope
      $('customer-banner').textContent = preview.text
      $('customer-banner').dataset.tone = preview.tone
      $('preview-decision').textContent = preview.decision ?? 'Preview uses the selected local fixture. The real service and offer are unchanged.'
    }
    $('guide-controls').hidden = !guide
    if (guide) {
      const awaiting = state.stage === 'recovery'
      $('guide-status').textContent = awaiting ? 'Your decision is next. Playback cannot apply recovery.' : `Scripted guide · ${guide.paused ? 'Paused' : guide.mode === 'play' ? 'Playing' : 'Step by step'}`
      $('guide-next').disabled = awaiting
      $('guide-pause').hidden = guide.mode !== 'play'
      $('guide-pause').disabled = awaiting
      $('guide-pause').textContent = guide.paused ? 'Resume' : 'Pause'
    } else $('guide-status').textContent = 'Deterministic local guide. No model or live changes.'
    $('rehearsal-events').replaceChildren(...events.map(event => {
      const row = document.createElement('li'); row.textContent = `${event.index}. ${event.message}`; return row
    }))
    $('rehearsal-history').hidden = events.length === 0
    bridge.changed(counts())
    if (sheet.open) renderSheet()
  }
  function start(scenario, mode = null) {
    stopGuide(); events = []; sequence = 0
    state = startSimulation(scenario, ++generation)
    $('simulation-scenario').value = scenario
    push('Rehearsal started. Only local fixtures are in use.')
    if (mode) guide = { mode, paused: false, runId: state.runId }
    render(); schedule()
  }
  function reset() {
    stopGuide(); generation++; state = null; events = []; sequence = 0
    render()
  }
  function stage(value, fromGuide = false) {
    if (!state) throw Error('Run a rehearsal first')
    if (!fromGuide) stopGuide('Guide stopped by stage selection.')
    state = selectStage(state, value)
    push(value === 'recovery' ? 'Recovery prepared. Waiting for your visible decision.' : `${value === 'triage' ? 'Triage' : 'Diagnosis'} inspected.`)
    render()
  }
  function next() {
    if (!guide || !state || guide.runId !== state.runId || state.stage === 'recovery') return
    stage(STAGES[STAGES.indexOf(state.stage) + 1], true)
    schedule()
  }
  function schedule() {
    clearTimeout(timer); timer = null
    if (!guide || guide.mode !== 'play' || guide.paused || state.stage === 'recovery') return
    const run = guide.runId
    timer = setTimeout(() => { if (!closed && guide?.runId === run && !guide.paused) next() }, 1400)
  }
  function decide(accepted, expected) {
    state = accepted ? applyRecovery(state, expected) : rejectRecovery(state, expected)
    push(accepted ? 'You applied the reviewed recovery to this simulation.' : 'You declined the simulated recovery.')
    stopGuide(); render()
  }
  function closeSheet() {
    sheet.close()
    if (sheetTrigger?.isConnected && !sheetTrigger.disabled) sheetTrigger.focus()
  }
  function openSheet(mode, trigger) {
    if (document.querySelector('dialog[open]')) return
    sheetMode = mode; sheetTrigger = trigger; $('console-filter').value = ''
    renderSheet(); sheet.showModal(); $('console-filter').focus()
  }
  const commands = [
    ['tools', 'Inspect capabilities', 'See registered tools, effects and stage requirements.'],
    ['step', 'Step through a rehearsal', 'Follow one explanation at a time.'],
    ['play', 'Play a guided rehearsal', 'Pauses for your recovery decision.'],
    ['run', 'Start selected scenario', 'Reset the rehearsal without a service request.'],
    ['source', 'Focus Python source', 'Return to the current editor.'],
    ['review', 'Review current source', 'Open the existing review before conversion.'],
  ]
  function renderSheet() {
    const filter = $('console-filter').value.trim().toLowerCase(), live = bridge.live(), summary = counts()
    $('console-sheet-heading').textContent = sheetMode === 'tools' ? 'Console capabilities' : 'Workspace commands'
    $('console-sheet-summary').textContent = sheetMode === 'tools'
      ? `${summary.available + Number(live.conversionRegistered)} available now · ${summary.registered + Number(live.conversionRegistered)} registered · ${state?.stage ?? 'no rehearsal'}`
      : 'Commands use the same visible controls. Recovery decisions remain in the Console.'
    const rows = sheetMode === 'tools' ? [
      { name: 'commerce.workspace.program-pack.create', title: 'Create Workspace Program Pack', effect: 'Sends source for conversion',
        description: 'Free conversion with digest verification. Agent calls use the tool directly; the form has its own review.',
        status: live.conversionRegistered ? 'Available · registered' : `Not registered · ${live.browser}` },
      ...CONSOLE_TOOLS.map(tool => ({ ...tool, status: registrations.get(tool.key)?.ready
        ? toolGate(tool.key, state) ?? 'Available · registered' : registrations.get(tool.key)?.status ?? 'Browser WebMCP unavailable' })),
    ] : commands.map(([key, title, description]) => ({ key, title, description, effect: 'Visible action' }))
    const matches = rows.filter(row => `${row.title} ${row.name ?? ''} ${row.description}`.toLowerCase().includes(filter))
    $('console-sheet-list').replaceChildren(...matches.map(row => {
      const item = document.createElement('li'), title = document.createElement(sheetMode === 'tools' ? 'h3' : 'button')
      title.textContent = row.title
      if (sheetMode === 'commands') {
        title.type = 'button'
        title.addEventListener('click', () => { closeSheet(); action(row.key, sheetTrigger) })
      }
      const detail = document.createElement('p'); detail.textContent = row.description
      const status = document.createElement('span'); status.className = 'capability-state'; status.textContent = row.status ?? row.effect
      item.append(title, status, detail)
      if (row.name) { const code = document.createElement('code'); code.textContent = row.name; item.append(code) }
      if (sheetMode === 'tools') { const effect = document.createElement('small'); effect.textContent = `Effect: ${row.effect}`; item.append(effect) }
      return item
    }))
    $('console-sheet-empty').hidden = matches.length !== 0
  }
  function action(name, trigger) {
    if (name === 'tools' || name === 'commands') { openSheet(name, trigger); return }
    if (name === 'source') { $('source').focus(); return }
    if (name === 'review') { bridge.review(); return }
    bridge.openPanel()
    if (name === 'run' || name === 'step' || name === 'play') start($('simulation-scenario').value, name === 'run' ? null : name)
  }
  function execute(key, input) {
    if (closed || !registrations.get(key)?.ready) throw Error('console_tool_unavailable')
    validateToolInput(key, input, state)
    bridge.toolObserved()
    if (key === 'rehearse') { bridge.openPanel(); start(input.scenario) }
    if (key === 'stage') stage(input.stage)
    if (key === 'propose') { bridge.openPanel(); stopGuide(); push('Browser agent prepared a recovery proposal. Waiting for your decision.'); render() }
    const result = key === 'diagnose' ? { runId: state.runId, diagnosis: SCENARIOS[state.scenario].diagnosis }
      : key === 'propose' ? { runId: state.runId, proposal: SCENARIOS[state.scenario].recovery, decision: 'human-review-required', applied: false }
      : snapshot()
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
  function retire(key) {
    const registration = registrations.get(key)
    if (!registration) return
    registration.ready = false; registration.controller.abort()
    if (bridge.context !== document.modelContext) bridge.context?.unregisterTool?.(registration.name)
  }
  async function register(tool) {
    const registration = { name: tool.name, controller: new AbortController(), ready: false, status: 'Registering' }
    registrations.set(tool.key, registration)
    let deadline
    try {
      await Promise.race([Promise.resolve(bridge.context.registerTool({ name: tool.name, description: tool.description,
        inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.effect === 'Read', consequentialHint: false },
        execute: (input, options) => {
          if (options?.signal?.aborted) throw Error('console_call_cancelled')
          return execute(tool.key, input)
        },
      }, { signal: registration.controller.signal })), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('console_registration_timeout')), 2000)
      })])
      if (closed || registration.controller.signal.aborted) throw Error('console_registration_retired')
      registration.ready = true; registration.status = 'Registered'
    } catch { retire(tool.key); registration.status = 'Registration unavailable' }
    finally { clearTimeout(deadline); render() }
  }
  $('simulation-scenario').addEventListener('change', reset)
  $('simulation-reset').addEventListener('click', () => { reset(); $('simulation-run').focus() })
  stages.forEach(button => button.addEventListener('click', () => stage(button.dataset.responseStage)))
  $('simulation-recover').addEventListener('click', () => { if (state && !state.recovered && !state.rejected) decide(true, Number($('simulation-recover').dataset.runId)) })
  $('simulation-reject').addEventListener('click', () => { if (state && !state.recovered && !state.rejected) decide(false, Number($('simulation-reject').dataset.runId)) })
  $('guide-next').addEventListener('click', next)
  $('guide-pause').addEventListener('click', () => { if (guide) { guide.paused = !guide.paused; render(); schedule() } })
  $('guide-stop').addEventListener('click', () => { stopGuide('You stopped the guide. The current fixture is preserved.'); render() })
  $('console-sheet-close').addEventListener('click', closeSheet)
  $('console-filter').addEventListener('input', renderSheet)
  sheet.addEventListener('cancel', event => { event.preventDefault(); closeSheet() })
  sheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSheet(); return }
    if (event.key !== 'Tab') return
    const controls = [...sheet.querySelectorAll('button,input')].filter(control => !control.disabled && !control.hidden)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
  sheet.addEventListener('click', event => {
    if (event.target !== sheet) return
    const rect = sheet.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSheet()
  })
  document.addEventListener('visibilitychange', () => { if (document.hidden && guide) { guide.paused = true; render(); schedule() } })
  addEventListener('pagehide', () => { closed = true; stopGuide(); for (const tool of CONSOLE_TOOLS) retire(tool.key) }, { once: true })
  if (bridge.context?.registerTool) for (const tool of CONSOLE_TOOLS) void register(tool)
  render()
  return { action, refreshLive: () => { bridge.changed(counts()); if (sheet.open) renderSheet() } }
}
