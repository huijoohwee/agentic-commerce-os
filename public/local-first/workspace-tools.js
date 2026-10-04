import { listDrafts, groupProjects } from './drafts.js';
import { WORKSPACE_TOOLS, workspaceSnapshot, invokeWorkspace, parseWorkspaceInvocation, validateWorkspaceInput, workspaceWait } from './workspace-capabilities.js';

const $ = id => document.getElementById(id);
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
  function reset(initial) {
    const tool = selected(); expression.value = prefix + tool.name;
    args.value = JSON.stringify(initial ?? (tool.name.endsWith('.project.read') ? { projectId: 'local:unassigned' }
      : tool.name.endsWith('.offer.review') ? { offerId: '', expectedRevision: 1 } : {}), null, 2);
    $('workspace-tool-description').textContent = tool.description;
    $('workspace-result').textContent = ''; $('workspace-tool-status').textContent = 'Ready. Uses device drafts unless you supply a snapshot.';
  }
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
    $('workspace-result').textContent = ''; $('workspace-tool-status').textContent = prepare ? 'Preparing a request on this device…' : 'Reading current state…';
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
      $('workspace-result').textContent = JSON.stringify(result, null, 2);
      $('workspace-tool-status').textContent = prepare
        ? 'Request prepared locally. Review titles, audiences, outcomes and estimated costs before sharing. Nothing was sent.'
        : 'Read complete. No offer was approved or published.';
    } catch (error) { $('workspace-tool-status').textContent = controller.signal.aborted ? 'Cancelled or timed out. The result is unknown.' : error.message; }
    finally { clearTimeout(timer); runController = null; $('workspace-run').disabled = false; $('workspace-prepare').disabled = false; $('workspace-cancel').hidden = true; }
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
          catch (error) { disable(); throw error; }
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
