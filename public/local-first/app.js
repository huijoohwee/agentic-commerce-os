import { listDrafts, saveDraft, importDrafts, exportDrafts, LIMITS } from './drafts.js';
import { inspectLaunchInput, parseLaunchInput, evaluateOfferSetup } from './launch.js';

const $ = selector => document.querySelector(selector);
let selected = null, dirty = false, busy = false;
let reviewed = null;
let stale = false, actionFailed = false;
const textFields = { merchantId: '#merchant-id', agentId: '#agent-id', audience: '#audience', outcome: '#outcome', currency: '#currency' };
const moneyFields = { priceMinor: '#sale-price', deliveryCostMinor: '#delivery-cost', providerFeeMinor: '#provider-fee',
  agentCostMinor: '#agent-cost', acquisitionCostMinor: '#acquisition-cost', fixedCostMinor: '#fixed-cost' };
function changed() { document.dispatchEvent(new Event('commerce:drafts-updated')); }
function message(text, error = false) { $('#status').textContent = text; $('#status').dataset.error = String(error); }
function invalidateReview() { reviewed = null; $('#launch-review').hidden = true; $('#approve-launch').checked = false; $('#export-launch').disabled = true; }
function rawLaunch() { return Object.fromEntries(Object.entries({ ...textFields, ...moneyFields }).map(([key, selector]) => [key, $(selector).value])); }
function setupState() { return evaluateOfferSetup({ title: $('#title').value, launch: inspectLaunchInput(rawLaunch()).terms }); }
function renderSetup() {
  const setup = setupState(), saved = selected && !dirty && !stale && !actionFailed;
  const currentReview = saved && reviewed?.draftId === selected.id && reviewed?.revision === selected.revision;
  const acknowledged = Boolean(currentReview && $('#approve-launch').checked);
  const steps = [...setup.steps, { id: 'review', complete: acknowledged }];
  $('#setup-count').textContent = `${steps.filter(step => step.complete).length} of 4 steps complete`;
  for (const step of steps) {
    const row = $(`[data-setup-step="${step.id}"]`);
    row.dataset.complete = String(step.complete);
    row.querySelector('[data-step-status]').textContent = step.complete ? 'Complete' : 'Needs attention';
  }
  $('#setup-status').textContent = busy ? 'Checking this offer…' : actionFailed ? 'The action could not finish. Your editor text is still here; check the message above.'
    : stale ? 'The saved offer changed. Reload its latest version before review.'
    : dirty || !selected ? 'Your current inputs are checked below. Save them before review.'
    : acknowledged ? `Revision ${selected.revision} reviewed on this device. You can export its setup.`
    : currentReview ? `Read the review for revision ${selected.revision}, then acknowledge it below.`
    : `Revision ${selected.revision} saved on this device. Review it when the first three steps are complete.`;
  const action = $('#setup-review-action');
  action.textContent = stale ? 'Reload saved offer' : !saved ? 'Save offer' : acknowledged ? 'Export reviewed setup'
    : currentReview ? 'Read and acknowledge review' : 'Review saved offer';
  action.dataset.action = stale ? 'reload' : !saved ? 'save' : acknowledged ? 'export' : currentReview ? 'acknowledge' : 'review';
  action.disabled = busy || action.dataset.action === 'review' && setup.status !== 'reviewable';
  $('#export-launch').disabled = busy || !acknowledged;
}
function edited() { dirty = true; actionFailed = false; $('#save-state').textContent = 'Unsaved changes'; invalidateReview(); renderSetup(); }
function mayLeave() { return !dirty || window.confirm('Leave these unsaved edits? Your saved drafts will remain.'); }
function show(draft) {
  selected = draft; dirty = false; stale = false; actionFailed = false;
  invalidateReview();
  $('#title').value = draft?.title ?? ''; $('#description').value = draft?.description ?? ''; $('#price').value = draft?.price ?? '';
  $('#editor-heading').textContent = draft ? 'Offer draft' : 'New offer draft';
  $('#save-state').textContent = draft ? 'Saved on this device' : 'Not saved yet';
  for (const [key, selector] of Object.entries(textFields)) $(selector).value = draft?.launch?.[key] ?? '';
  for (const selector of Object.values(moneyFields)) $(selector).value = '';
  if (draft?.launch) {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: draft.launch.currency }).resolvedOptions().maximumFractionDigits;
    for (const [key, selector] of Object.entries(moneyFields)) $(selector).value = (draft.launch[key] / 10 ** digits).toFixed(digits);
    $('#launch-fields').open = true;
  }
  message(''); renderSetup();
}
async function refresh() {
  const drafts = await listDrafts();
  $('#draft-count').textContent = String(drafts.length);
  $('#empty-state').hidden = drafts.length > 0;
  $('#draft-list').replaceChildren();
  for (const draft of drafts) {
    const button = document.createElement('button'), title = document.createElement('span'), time = document.createElement('small');
    button.type = 'button'; button.setAttribute('aria-current', String(draft.id === selected?.id));
    title.textContent = draft.title; time.textContent = new Date(draft.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    button.append(title, time);
    button.addEventListener('click', () => {
      if (busy || !mayLeave()) return;
      void run(async () => {
        const current = (await listDrafts()).find(item => item.id === draft.id);
        if (!current) throw Error('Draft no longer available.');
        show(current); await refresh(); $('#title').focus();
      });
    });
    $('#draft-list').append(button);
  }
}
function controls() { return document.querySelectorAll('[data-view-panel="vendor-editor"] button, [data-view-panel="vendor-editor"] input, [data-view-panel="vendor-editor"] textarea, [data-view-panel="admin-data"] button, [data-view-panel="admin-data"] input'); }
async function run(operation) {
  if (busy) return;
  busy = true; actionFailed = false; renderSetup();
  for (const element of controls()) element.disabled = true;
  try { return await operation(); } catch (error) {
    actionFailed = true; if (error.code === 'draft_revision_conflict') stale = true;
    invalidateReview(); message(error.message || 'Could not complete this action.', true); return false;
  }
  finally {
    busy = false; for (const element of controls()) element.disabled = false;
    renderSetup();
  }
}
$('#draft-form').addEventListener('input', edited);
$('#draft-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = { id: selected?.id, title: $('#title').value, description: $('#description').value, price: $('#price').value };
  void run(async () => {
    input.launch = parseLaunchInput(rawLaunch());
    const saved = await saveDraft(input, selected?.revision ?? null);
    show(saved); await refresh(); message('Saved privately on this device.'); changed();
  });
});
$('#review-launch').addEventListener('click', () => void run(async () => {
  invalidateReview();
  if (!selected || dirty) throw Error('Save this offer before reviewing its launch.');
  const current = (await listDrafts()).find(draft => draft.id === selected.id);
  if (!current || current.revision !== selected.revision) { stale = true; throw Error('This offer changed. Reopen the saved version before review.'); }
  const { reviewLaunch, formatMoney } = await import('./launch.js');
  reviewed = await reviewLaunch(current);
  $('#review-offer').textContent = `${current.title} · ${reviewed.terms.outcome} · ${reviewed.terms.audience}`;
  $('#economics').replaceChildren();
  for (const [label, value] of [
    ['Planned price', formatMoney(reviewed.economics.priceMinor, reviewed.terms.currency)],
    ['Contribution per sale', formatMoney(reviewed.economics.contributionMinor, reviewed.terms.currency)],
    ['After the first sale and setup', formatMoney(reviewed.economics.firstSaleNetMinor, reviewed.terms.currency)],
    ['After 10 sales and setup', formatMoney(reviewed.economics.tenSalesNetMinor, reviewed.terms.currency)],
    ['Sales to recover setup cost', String(reviewed.economics.breakEvenSales)],
  ]) {
    const term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value; $('#economics').append(term, detail);
  }
  $('#launch-review').hidden = false; message('Review the saved offer and costs before exporting.');
}));
$('#prepare-listing').addEventListener('click', () => void run(async () => {
  if (!selected || dirty) throw Error('Save this draft before preparing a listing.');
  const current = (await listDrafts()).find(draft => draft.id === selected.id);
  if (!current || current.revision !== selected.revision) { stale = true; throw Error('This draft changed. Reopen the saved version first.'); }
  const { openWorkflow } = await import('./workflow.js');
  await openWorkflow({ draft: current, onSaved: async saved => { selected = saved; invalidateReview(); await refresh(); renderSetup(); changed(); } });
}));
$('#approve-launch').addEventListener('change', renderSetup);
$('#export-launch').addEventListener('click', () => void run(async () => {
  if (!reviewed || dirty || !$('#approve-launch').checked) throw Error('Review and acknowledge this saved offer first.');
  const current = (await listDrafts()).find(draft => draft.id === reviewed.draftId);
  if (!current || current.revision !== reviewed.revision) { stale = true; throw Error('This offer changed. Review the saved version again.'); }
  const { exportLaunchPack } = await import('./launch.js');
  const pack = await exportLaunchPack(current, reviewed);
  downloadJson(JSON.stringify(pack, null, 2), `commerce-launch-${pack.themeManifest.merchantId}.json`);
  message('Reviewed launch pack exported. Publishing and payment still require the authorized Commerce runtime.');
}));
function downloadJson(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('#new-draft').addEventListener('click', () => {
  if (newDraft()) $('#title').focus();
});
$('#export').addEventListener('click', () => void run(async () => {
  const text = await exportDrafts();
  downloadJson(text, `commerce-drafts-${new Date().toISOString().slice(0, 10)}.json`);
  message(dirty ? 'Saved drafts exported. Unsaved editor text is not included.' : 'Draft backup exported. Keep it somewhere safe.');
}));
$('#import').addEventListener('change', event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  void run(async () => {
    if (file.size > LIMITS.transferBytes) throw Error('Import exceeds 8 MB.');
    const count = await importDrafts(await file.text(),
      () => import('./workflow.js').then(module => module.authorizeWorkflowImport())); await refresh();
    message(`Imported ${count} draft${count === 1 ? '' : 's'}. Existing drafts were preserved.`); changed();
  });
});
export async function externalChange() {
  invalidateReview(); stale = Boolean(selected); renderSetup();
  try { await refresh(); }
  catch (error) { actionFailed = true; renderSetup(); throw error; }
  if (selected) message('Saved drafts changed in another tab. Reopen a draft to load its latest version.');
}
export async function openSavedDraft(id) {
  if (busy || !mayLeave()) return false;
  return run(async () => {
    const current = (await listDrafts()).find(draft => draft.id === id);
    if (!current) throw Error('Draft no longer available.');
    show(current); await refresh(); return true;
  });
}
export function newDraft() {
  if (busy || !mayLeave()) return false;
  show(null); void refresh().catch(error => { actionFailed = true; message(error.message, true); renderSetup(); }); return true;
}
for (const button of document.querySelectorAll('[data-setup-edit]')) button.addEventListener('click', () => {
  const id = button.dataset.setupEdit;
  const defaults = { describe: 'title', identity: 'merchantId', economics: 'currency' };
  const field = setupState().steps.find(step => step.id === id).fields[0] || defaults[id];
  $('#launch-fields').open = true;
  $(({ title: '#title', ...textFields, ...moneyFields })[field] || '#title').focus();
});
$('#setup-review-action').addEventListener('click', () => {
  if (busy) return;
  switch ($('#setup-review-action').dataset.action) {
    case 'save': $('#draft-form').requestSubmit(); break;
    case 'review': $('#review-launch').click(); break;
    case 'acknowledge': $('#approve-launch').focus(); break;
    case 'export': $('#export-launch').click(); break;
    case 'reload': void openSavedDraft(selected.id).catch(error => { actionFailed = true; message(error.message, true); renderSetup(); }); break;
  }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
void refresh().catch(error => { actionFailed = true; message(error.message, true); renderSetup(); });
$('#editor-fields').disabled = false; $('#import').disabled = false; $('#export').disabled = false;
renderSetup();
