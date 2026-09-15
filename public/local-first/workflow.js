import { saveDraft, validWorkflow } from './drafts.js';

const base = '/agentic-commerce-os';
const node = (tag, text) => { const value = document.createElement(tag); if (text) value.textContent = text; return value; };
let dialog, current, saved, busy = false;
const elements = {};
function message(text) { elements.message.textContent = text; }
function matches() { return current?.workflow?.title === current?.title && current?.workflow?.description === current?.description; }
function render() {
  const flow = current?.workflow;
  elements.title.textContent = flow?.title || current?.title || 'Listing';
  elements.output.replaceChildren(...(flow?.text || '').split('\n').map(line => node('p', line)));
  elements.reviewLabel.hidden = flow?.status !== 'completed';
  if (!busy) elements.review.checked = !!flow?.reviewedDigest && matches();
  elements.resume.disabled = busy || !navigator.onLine;
  elements.cancel.disabled = busy || !navigator.onLine || !flow?.runId || ['completed', 'canceled'].includes(flow.status);
  elements.retry.hidden = flow?.status !== 'blocked'; elements.retry.disabled = busy || !navigator.onLine;
  elements.review.disabled = busy || !matches();
  elements.checkout.disabled = busy || !navigator.onLine || !flow?.reviewedDigest || !matches();
  elements.new.disabled = busy || flow?.runId && !['completed', 'canceled', 'blocked'].includes(flow.status);
  elements.new.hidden = !flow;
  if (flow && !matches()) message('This result belongs to an earlier draft. Review its text or prepare a new listing from the saved draft.');
}
async function persist(workflow) {
  if (!validWorkflow(workflow)) throw Error('The saved job response could not be verified. Refresh before retrying.');
  current = await saveDraft({ ...current, workflow }, current.revision);
  await saved(current); render();
}
async function request(path, body, token) {
  let response;
  try { response = await fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'content-type': 'application/json', 'x-commerce-csrf': token } : {},
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }); }
  catch { throw Error('Reconnect to check the job. Your saved draft and handle remain available.'); }
  const value = await response.json();
  if (!response.ok || value.ok !== true) throw Error(response.status === 401 || response.status === 403
    ? 'This browser session cannot access the job. Keep your draft and reconnect with its original session.'
    : 'The execution host is unavailable or refused this operation. Your saved job remains; refresh before retrying.');
  return value;
}
async function refresh(operation = 'status') {
  if (!navigator.onLine) { message('Saved on this device. Reconnect and choose Resume to submit or check the job.'); return; }
  const session = await request('/fulfillment/session');
  const flow = current.workflow;
  const body = !flow.runId ? { draftId: current.id, revision: flow.inputRevision, title: flow.title, description: flow.description }
    : { runId: flow.runId, ...(operation === 'retry' ? { operationId: crypto.randomUUID() } : {}) };
  const value = await request('/fulfillment/' + (flow.runId ? operation : 'start'), body, session.csrfToken);
  const next = { ...flow, runId: value.runId, status: value.status, text: value.text ?? null,
    outputDigest: value.outputDigest ?? null, reviewedDigest: value.outputDigest === flow.reviewedDigest ? flow.reviewedDigest : null };
  if (next.text !== null) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(next.text)))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== next.outputDigest) throw Error('Result changed during delivery. Refresh before reviewing it.');
  }
  await persist(next);
  message(({ completed: 'Your listing is ready. Review the facts before using it in the sandbox example.',
    canceled: 'Job canceled. Its existing checkpoints remain with the execution host.',
    blocked: 'The job stopped. Retry only after resolving its execution or authorization issue.' })[next.status]
    || 'Job accepted. You can close this browser and use Resume to check it later.');
}
async function run(operation) {
  if (busy) return; busy = true; render();
  try { await operation(); } catch (error) { message(error.message || 'Could not check the job. Your saved draft remains.'); }
  finally { busy = false; render(); }
}
async function prepare() {
  await persist({ runId: null, inputRevision: current.revision, title: current.title, description: current.description,
    status: 'queued', text: null, outputDigest: null, reviewedDigest: null });
  await refresh();
}
function createDialog() {
  dialog = node('dialog'); dialog.id = 'listing-dialog'; dialog.className = 'panel';
  dialog.setAttribute('aria-labelledby', 'listing-heading');
  const heading = node('h2', 'Prepare and review your listing'); heading.id = 'listing-heading';
  elements.title = node('h3'); elements.message = node('p'); elements.message.id = 'listing-status'; elements.message.setAttribute('role', 'status');
  elements.output = node('div'); elements.output.id = 'listing-output';
  elements.output.className = 'preview-explainer';
  elements.reviewLabel = node('label'); elements.reviewLabel.className = 'review-approval';
  elements.review = node('input'); elements.review.type = 'checkbox'; elements.review.id = 'listing-review';
  elements.reviewLabel.append(elements.review, document.createTextNode('I reviewed the listing and checked its facts.'));
  elements.review.addEventListener('change', () => { const checked = elements.review.checked; void run(async () => {
    if (!matches() || current.workflow.status !== 'completed') throw Error('Review the current saved draft first.');
    await persist({ ...current.workflow, reviewedDigest: checked ? current.workflow.outputDigest : null });
  }); });
  const buttons = node('div'); buttons.className = 'editor-actions';
  for (const [key, label, action] of [
    ['resume', 'Resume / refresh', () => refresh()], ['cancel', 'Cancel job', () => refresh('cancel')],
    ['retry', 'Retry stopped job', () => refresh('retry')], ['new', 'Prepare new listing', prepare],
    ['checkout', 'Use in sandbox checkout', async () => {
      if (!matches() || current.workflow.reviewedDigest !== current.workflow.outputDigest) throw Error('Review the listing first.');
      const { selectFulfillment } = await import('./checkout.js');
      selectFulfillment({ runId: current.workflow.runId, outputDigest: current.workflow.outputDigest }, current.title);
      dialog.close(); location.hash = 'checkout';
    }],
  ]) {
    const button = node('button', label); button.id = 'listing-' + key; button.type = 'button';
    button.addEventListener('click', () => void run(action)); elements[key] = button; buttons.append(button);
  }
  const close = node('button', 'Close'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  dialog.append(heading, elements.title, elements.message, elements.output, elements.reviewLabel, buttons,
    node('p', 'Drafts and job handles stay on this device. Execution needs the operator’s host. No publishing or real payment occurs here.'), close);
  document.body.append(dialog);
  for (const name of ['online', 'offline']) window.addEventListener(name, () => {
    render(); if (!navigator.onLine && dialog.open) message('Offline. Your saved draft and job handle remain available.');
  });
}
export async function openWorkflow({ draft, onSaved }) {
  if (busy) throw Error('Wait for the current job request to finish.');
  if (!dialog) createDialog(); current = draft; saved = onSaved;
  elements.message.textContent = ''; dialog.showModal(); render();
  await run(() => current.workflow ? refresh() : prepare());
}
