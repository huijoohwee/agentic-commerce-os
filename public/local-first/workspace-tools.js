import { listDrafts, groupProjects } from './drafts.js';
import { WORKSPACE_TOOLS, workspaceSnapshot, invokeWorkspace, parseWorkspaceInvocation, validateWorkspaceInput, workspaceWait } from './workspace-capabilities.js';
import { formatMoney } from './launch.js';

const $ = id => document.getElementById(id);
const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const SOURCES = { 'browser-local': 'Saved on this device', 'provided-snapshot': 'Supplied snapshot', 'runtime-observation': 'Current runtime observation' };
const FIELD_LABELS = { query: 'Find a project or offer', projectId: 'Project ID', offerId: 'Offer ID', expectedRevision: 'Saved revision' };
function summarize(result, prepare) {
  const summary = $('workspace-summary'); summary.replaceChildren();
  const facts = node('dl'); facts.className = 'readiness';
  const fact = (label, value) => { facts.append(node('dt', label), node('dd', String(value ?? 'Unknown'))); };
  if (prepare) {
    const offers = result.params.arguments.snapshot?.offers ?? [];
    const fields = offers.reduce((count, offer) => count + Object.keys(offer).length + Object.keys(offer.launch ?? {}).length, 0);
    summary.append(node('h3', 'Request ready to inspect'));
    fact('Capability', result.params.name); fact('Offers included', offers.length); fact('Offer and launch field values', fields);
    $('workspace-privacy').textContent = `${offers.length} ${offers.length === 1 ? 'offer' : 'offers'} · ${fields} offer and launch field values prepared on this device. ${offers.length ? 'Includes titles and any launch terms or estimated costs. ' : ''}Private notes and workflow output are excluded. Nothing was sent.`;
  } else {
    const value = result.value;
    summary.append(node('h3', 'Read result')); fact('Source', SOURCES[result.provenance] ?? result.provenance);
    if (result.tool.endsWith('.projects.list')) {
      fact('Projects', value.projects.length); fact('Saved offers', value.projects.reduce((count, project) => count + project.offerCount, 0));
    } else if (result.tool.endsWith('.project.read')) {
      fact('Project', value.name); fact('Project ID', value.id); fact('Saved offers', value.offerCount); fact('Ready for human review', value.reviewableCount);
    } else if (result.tool.endsWith('.offer.review')) {
      fact('Offer', value.title); fact('Offer ID', value.id); fact('Saved revision', value.revision);
      fact('Readiness', value.status === 'reviewable' ? 'Ready for human review' : value.status === 'draft' ? 'Launch terms incomplete' : 'Revise price or costs');
      if (value.economics) {
        fact('Estimated price', formatMoney(value.economics.priceMinor, value.economics.currency));
        fact('Estimated per-sale costs', formatMoney(value.economics.variableCostMinor, value.economics.currency));
        fact('Estimated contribution', formatMoney(value.economics.contributionMinor, value.economics.currency));
      }
      fact('Next action', 'Review the exact saved offer before exporting. Human launch review is still required.');
    } else {
      fact('Profile', value.profile); fact('Configuration', value.ok ? 'Configured at observation time' : 'Unavailable');
      fact('Source revision', value.sourceRevision); fact('Checkout mode', value.checkout); fact('Fulfillment', value.fulfillment);
      fact('Boundary', 'This observation does not prove deployment, payment or delivery.');
    }
    const items = value.projects ?? value.offers;
    if (items) {
      const list = node('ul'); list.className = 'workspace-result-list';
      for (const item of items.slice(0, 10)) list.append(node('li', item.name
        ? `${item.name} · ${item.offerCount} offers · ${item.reviewableCount} ready for human review · ${item.id}`
        : `${item.title} · Revision ${item.revision} · ${item.status === 'reviewable' ? 'Ready for human review' : item.status === 'draft' ? 'Launch terms incomplete' : 'Revise price or costs'} · ${item.id}`));
      summary.append(list);
      if (items.length > 10) summary.append(node('p', `Showing 10 of ${items.length}; inspect the complete JSON below.`));
      if (!items.length) summary.append(node('p', 'No matches. Change the search or inspect another saved project.'));
    }
  }
  summary.insertBefore(facts, summary.children[1] ?? null);
}
function recovery(error, cancelled) {
  const code = error.message, target = $('workspace-recovery'); target.replaceChildren();
  const next = cancelled || code === 'workspace_cancelled' ? 'The result is unknown. Run again only when you are ready for a fresh read.'
    : code === 'workspace_revision_changed' ? 'The saved offer changed. Close this panel, reopen the offer and review its current revision.'
    : ['workspace_offer_missing', 'workspace_project_missing'].includes(code) ? 'Find projects again and choose an existing project or offer.'
    : code.startsWith('workspace_environment_') ? 'Reconnect or wait for the current check to finish, then explicitly check the environment again.'
    : code.includes('registration changed') ? 'Browser tools were disabled. Reload this page before enabling them again.'
    : 'Check the capability fields and advanced arguments, then explicitly run the read again.';
  target.append(node('span', next));
  if (!cancelled && (error instanceof SyntaxError || /workspace_(?:arguments|invocation|snapshot|query|project_invalid|offer_invalid|revision_invalid)/.test(code))) {
    const button = node('button', 'Inspect arguments'); button.type = 'button'; button.className = 'secondary';
    button.addEventListener('click', () => { $('workspace-advanced').open = true; $(code.includes('invocation') ? 'workspace-invocation' : 'workspace-arguments').focus(); });
    target.append(button);
  }
}
export async function mountWorkspaceTools({ checkEnvironment, sourceRevision }) {
  const response = await fetch(new URL('./services/workspace/service.json', location.href), {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Workspace tools are unavailable. Reconnect and open Tools & commands again.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 32768) throw Error('Workspace tool descriptor is too large.'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  const descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), routing = descriptor.routing;
  if (descriptor.schema !== 'commerce.workspace-service/v1' || descriptor.sourceRevision !== sourceRevision
    || descriptor.scope !== 'read-only' || JSON.stringify(descriptor.tools) !== JSON.stringify(WORKSPACE_TOOLS)
    || typeof routing?.commandToken !== 'string' || !/^\/[a-z.]+$/.test(routing.commandToken)
    || typeof routing?.bindingToken !== 'string' || !/^@[a-z-]+$/.test(routing.bindingToken)
    || typeof routing?.semanticToken !== 'string' || !/^#[a-z-]+$/.test(routing.semanticToken)) throw Error('Workspace tools do not match this page. Reload to refresh the release.');
  const prefix = `${routing.commandToken} ${routing.bindingToken} ${routing.semanticToken} `;
  const context = { snapshot: async () => workspaceSnapshot(await listDrafts()), environment: checkEnvironment };
  const toolSelect = $('workspace-tool'), args = $('workspace-arguments'), expression = $('workspace-invocation');
  toolSelect.replaceChildren(...WORKSPACE_TOOLS.map(tool => new Option(tool.title, tool.name)));
  $('workspace-mcp-endpoint').textContent = new URL(descriptor.mcp, location.origin).href;
  let runController, runTask, registration, registerPending;
  function selected() { return WORKSPACE_TOOLS.find(tool => tool.name === toolSelect.value); }
  function clearResult() {
    $('workspace-result').textContent = ''; $('workspace-summary').replaceChildren();
    $('workspace-privacy').textContent = ''; $('workspace-recovery').replaceChildren();
  }
  function markEdited() {
    clearResult(); $('workspace-tool-status').textContent = 'Inputs changed. Run explicitly to read, or prepare a request to inspect before sharing.';
  }
  function syncFields() {
    let values;
    try { values = JSON.parse(args.value); if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error(); }
    catch { $('workspace-provenance').textContent = 'Arguments need review. Open advanced arguments to correct the JSON.'; return; }
    for (const input of $('workspace-fields').querySelectorAll('input')) input.value = values[input.dataset.field] ?? '';
    $('workspace-provenance').textContent = selected().name.endsWith('.environment.read')
      ? 'Read only · Current runtime observation. Requires a connection; no deployment or payment authority.'
      : Object.hasOwn(values, 'snapshot') ? 'Read only · Supplied snapshot. It does not read or change device drafts.'
        : 'Read only · Saved on this device. Prepare a request to inspect the snapshot before sharing.';
  }
  function renderFields() {
    const tool = selected(), fields = $('workspace-fields'); fields.replaceChildren();
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      if (key === 'snapshot') continue;
      const label = node('label', FIELD_LABELS[key] ?? key), input = node('input');
      input.id = 'workspace-field-' + key; input.dataset.field = key; label.htmlFor = input.id;
      input.type = schema.type === 'integer' ? 'number' : key === 'query' ? 'search' : 'text';
      input.required = tool.inputSchema.required.includes(key); input.autocomplete = 'off';
      if (schema.maxLength) input.maxLength = schema.maxLength;
      if (schema.type === 'integer') { input.min = schema.minimum; input.max = schema.maximum; input.step = '1'; }
      if (input.required) label.append(node('span', ' · Required'));
      input.addEventListener('input', () => {
        try {
          const values = JSON.parse(args.value);
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('workspace_arguments_invalid');
          if (!input.value && !input.required) delete values[key];
          else values[key] = schema.type === 'integer' && input.value !== '' ? Number(input.value) : input.value;
          args.value = JSON.stringify(values, null, 2); markEdited(); syncFields();
        } catch (error) { recovery(error, false); }
      });
      fields.append(label, input);
    }
    if (!fields.children.length) fields.append(node('p', 'No fields required. Run explicitly to inspect the current runtime.'));
    syncFields();
  }
  function reset(initial) {
    const tool = selected(); expression.value = prefix + tool.name;
    args.value = JSON.stringify(initial ?? (tool.name.endsWith('.project.read') ? { projectId: 'local:unassigned' }
      : tool.name.endsWith('.offer.review') ? { offerId: '', expectedRevision: 1 } : {}), null, 2);
    $('workspace-tool-description').textContent = tool.description;
    clearResult(); renderFields(); $('workspace-tool-status').textContent = 'Ready. Uses device drafts unless you supply a snapshot.';
  }
  args.addEventListener('input', () => { markEdited(); syncFields(); });
  expression.addEventListener('input', markEdited);
  toolSelect.addEventListener('change', () => reset()); reset();
  $('workspace-run').disabled = false; $('workspace-prepare').disabled = false;
  function input() {
    const name = parseWorkspaceInvocation(expression.value, routing);
    if (name !== toolSelect.value) throw Error('Select the matching capability before running this invocation.');
    const input = validateWorkspaceInput(name, JSON.parse(args.value));
    return { name, arguments: input };
  }
  async function run(prepare = false) {
    if (runController) return;
    const controller = new AbortController(); runController = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    $('workspace-run').disabled = true; $('workspace-prepare').disabled = true; $('workspace-cancel').hidden = false;
    const controls = [toolSelect, args, expression, ...$('workspace-fields').querySelectorAll('input')];
    controls.forEach(control => { control.disabled = true; });
    clearResult(); $('workspace-tool-status').textContent = prepare ? 'Preparing a request on this device…' : 'Reading current state…';
    try {
      const request = input();
      let result;
      if (prepare) {
        if (!request.name.endsWith('.environment.read')) {
          const snapshot = request.arguments.snapshot ?? await workspaceWait(context.snapshot(), controller.signal);
          // Validate the exact requested object before reducing the transport snapshot.
          await invokeWorkspace(request.name, { ...request.arguments, snapshot }, { signal: controller.signal });
          const offers = request.name.endsWith('.project.read')
            ? groupProjects(snapshot.offers).find(project => project.id === request.arguments.projectId).offers
            : request.name.endsWith('.offer.review') ? snapshot.offers.filter(offer => offer.id === request.arguments.offerId) : snapshot.offers;
          request.arguments.snapshot = { ...snapshot, offers };
        }
        result = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: request };
      } else result = await invokeWorkspace(request.name, request.arguments, { ...context, signal: controller.signal });
      if (controller.signal.aborted) throw Error('Cancelled or timed out. Run again to obtain a current result.');
      summarize(result, prepare);
      $('workspace-result').textContent = JSON.stringify(result, null, 2);
      $('workspace-tool-status').textContent = prepare
        ? 'Request prepared locally. Review titles, audiences, outcomes and estimated costs before sharing. Nothing was sent.'
        : 'Read complete. No offer was approved or published.';
    } catch (error) { clearResult(); recovery(error, controller.signal.aborted); $('workspace-tool-status').textContent = controller.signal.aborted ? 'Cancelled or timed out. The result is unknown.' : error.message; }
    finally { clearTimeout(timer); runController = null; controls.forEach(control => { control.disabled = false; }); $('workspace-run').disabled = false; $('workspace-prepare').disabled = false; $('workspace-cancel').hidden = true; }
  }
  $('workspace-run').addEventListener('click', () => { runTask = run(); });
  $('workspace-prepare').addEventListener('click', () => { runTask = run(true); });
  $('workspace-cancel').addEventListener('click', () => runController?.abort());
  const modelContext = document.modelContext;
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
      : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const signature = tool => {
    if (typeof tool.inputSchema === 'string' && tool.inputSchema.length > 32768) throw Error('WebMCP schema exceeded its limit.');
    const inputSchema = typeof tool.inputSchema === 'string' ? JSON.parse(tool.inputSchema) : tool.inputSchema;
    return canonical({ name: tool.name, description: tool.description, inputSchema });
  };
  async function verifyRegistered() {
    const tools = await modelContext.getTools();
    if (!Array.isArray(tools) || tools.length > 64 || !WORKSPACE_TOOLS.every(tool => tools.filter(item => item.name === tool.name && signature(item) === signature(tool)).length === 1)) throw Error('Workspace WebMCP registration changed. Reload before enabling again.');
  }
  async function enableWebMCP() {
    if (registration || registerPending) return;
    registerPending = true; const controller = new AbortController(); registration = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('WebMCP registration cancelled.')), { once: true }));
      const work = Promise.all(WORKSPACE_TOOLS.map(tool => modelContext.registerTool({ ...tool,
        annotations: { ...tool.annotations, untrustedContentHint: true, consequentialHint: false },
        execute: async (input, agent) => {
          if (controller.signal.aborted) throw Error('Workspace WebMCP is disabled.');
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000), ...(agent?.signal ? [agent.signal] : [])]);
          try { await workspaceWait(verifyRegistered(), signal); }
          catch (error) { disable(); recovery(error, signal.aborted); throw error; }
          return invokeWorkspace(tool.name, input, { ...context, signal });
        } }, { signal: controller.signal }))).then(verifyRegistered);
      await Promise.race([work, cancelled]);
      $('workspace-webmcp-status').textContent = 'Enabled · Four read-only tools registered in this document.';
      $('workspace-webmcp-disable').hidden = false; $('workspace-webmcp-enable').disabled = true;
    } catch (error) { controller.abort(); registration = null; $('workspace-webmcp-status').textContent = error.message; }
    finally { clearTimeout(timer); registerPending = false; }
  }
  function disable() {
    registration?.abort(); registration = null; $('workspace-webmcp-disable').hidden = true;
    $('workspace-webmcp-enable').disabled = !modelContext?.registerTool || !modelContext?.getTools;
    $('workspace-webmcp-status').textContent = $('workspace-webmcp-enable').disabled
      ? 'Unavailable in this browser. Use the local runner or MCP endpoint.' : 'Disabled. Enable to let browser agents read project and offer summaries.';
  }
  $('workspace-webmcp-enable').addEventListener('click', () => void enableWebMCP());
  $('workspace-webmcp-disable').addEventListener('click', disable); disable();
  window.addEventListener('pagehide', () => { runController?.abort(); disable(); });
  return {
    async configure(name, input) {
      runController?.abort(); await runTask;
      validateWorkspaceInput(name, input); toolSelect.value = name; reset(input);
    },
    deactivate() { runController?.abort(); disable(); },
  };
}
