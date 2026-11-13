import { listDrafts, saveDraft, importDrafts, exportDrafts, LIMITS, LISTING_FIELDS, listingFieldIssues, isArchived } from './drafts.js';
import { inspectLaunchInput, parseLaunchInput, evaluateOfferSetup, parseMoney } from './launch.js';

const $ = selector => document.querySelector(selector);
const displayLocale = document.documentElement.lang || 'en';
let selected = null, dirty = false, busy = false;
let reviewed = null;
let stale = false, actionFailed = false;
let setupGuide, setupGeneration = 0, selectedSetupStep = 'describe', setupProjection;
const setupItems = [
  { id: 'describe', label: 'Describe the offer', detail: "Add a title, the buyer's problem and one outcome you will deliver.", actionLabel: 'Edit description' },
  { id: 'identity', label: 'Set storefront identifiers', detail: 'Enter the merchant and discovery agent IDs. This checks their format; connecting them is a separate step.', actionLabel: 'Edit identifiers' },
  { id: 'economics', label: 'Estimate price and costs', detail: 'Choose a currency and enter every estimate, including zero costs. The price must exceed costs per sale. These estimates do not validate demand.', actionLabel: 'Edit estimates' },
  { id: 'review', label: 'Save and review', detail: 'Save the offer, read its cost review and acknowledge that saved version. Editing it requires a fresh review.' },
];
const textFields = { merchantId: '#merchant-id', agentId: '#agent-id', audience: '#audience', outcome: '#outcome', currency: '#currency' };
const moneyFields = { priceMinor: '#sale-price', deliveryCostMinor: '#delivery-cost', providerFeeMinor: '#provider-fee',
  agentCostMinor: '#agent-cost', acquisitionCostMinor: '#acquisition-cost', fixedCostMinor: '#fixed-cost' };
const audienceInput = $('#audience'), audienceSuggestions = document.createElement('label'), audienceSelect = document.createElement('select');
audienceSuggestions.hidden = true;
audienceSuggestions.textContent = 'Reuse an audience from a saved offer';
audienceSelect.id = 'saved-audience';
audienceSelect.setAttribute('aria-label', 'Reuse an audience from a saved offer');
audienceInput.after(audienceSuggestions);
audienceSuggestions.append(audienceSelect);
audienceSelect.addEventListener('change', () => {
  if (!audienceSelect.value) return;
  audienceInput.value = audienceSelect.value;
  audienceInput.dispatchEvent(new Event('input', { bubbles: true }));
  audienceSelect.value = '';
});
function renderAudienceSuggestions(drafts) {
  const seen = new Set(), values = [];
  for (const draft of drafts) {
    const value = draft.launch?.audience?.trim();
    const key = value?.toLowerCase();
    if (value && !seen.has(key)) { seen.add(key); values.push(value); }
  }
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = 'Choose a saved audience'; placeholder.hidden = true;
  audienceSelect.replaceChildren(placeholder, ...values.map(value => {
    const option = document.createElement('option');
    option.value = value; option.textContent = value; return option;
  }));
  audienceSuggestions.hidden = values.length === 0;
}
const listingInputs = new Map();
let listingErrorField;
for (const field of LISTING_FIELDS) {
  const label = document.createElement('label'), input = document.createElement('input');
  label.htmlFor = input.id = 'listing-' + field.key; label.textContent = field.label;
  input.type = field.type === 'money' ? 'text' : field.type === 'integer' ? 'number' : field.type === 'text' ? 'text' : field.type;
  if (field.type === 'money' || field.type === 'number') input.inputMode = 'decimal';
  if (field.type === 'integer') { input.step = '1'; input.min = field.key === 'establishedYear' ? '1600' : '0'; }
  if (field.type === 'number') { input.step = 'any'; input.min = '0'; }
  if (field.maxLength) input.maxLength = field.maxLength;
  if (field.key === 'currency') { input.required = true; input.placeholder = 'Three-letter code'; }
  if (field.key === 'country') input.placeholder = 'Two-letter code';
  const error = document.createElement('small'); error.id = input.id + '-error';
  input.setAttribute('aria-describedby', error.id); input.autocomplete = 'off';
  label.append(input, error); $('#listing-inputs').append(label); listingInputs.set(field.key, input);
}
function clearListingIssues() {
  listingErrorField = null;
  for (const input of listingInputs.values()) { input.removeAttribute('aria-invalid'); $('#' + input.id + '-error').textContent = ''; }
}
function listingControls() {
  $('#listing-inputs').disabled = busy || !$('#listing-enabled').checked;
  $('#listing-enabled').disabled = busy || Boolean(selected?.listing);
  $('#archive-listing').hidden = !selected?.listing;
  $('#archive-listing').disabled = busy;
  $('#archive-listing').textContent = isArchived(selected) ? 'Restore listing' : 'Archive listing';
  $('#listing-state').textContent = selected?.listing ? isArchived(selected) ? 'Archived · private on this device' : 'Private listing draft' : '';
}
function showListing(draft) {
  clearListingIssues(); $('#listing-enabled').checked = Boolean(draft?.listing);
  $('#listing-fields').open = Boolean(draft?.listing);
  const currency = draft?.listing?.currency;
  const digits = currency ? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits : 2;
  for (const { key, type } of LISTING_FIELDS) {
    const value = draft?.listing?.[key];
    listingInputs.get(key).value = value === null || value === undefined ? '' : type === 'money' ? (value / 10 ** digits).toFixed(digits) : String(value);
  }
  listingControls();
}
function readListing() {
  clearListingIssues(); if (!$('#listing-enabled').checked) return undefined;
  const listing = { schemaVersion: 1, status: selected?.listing?.status ?? 'draft' }, issues = [];
  for (const { key, type } of LISTING_FIELDS) {
    const text = listingInputs.get(key).value.trim();
    if (type === 'money') {
      try {
        const negative = key === 'monthlyProfitMinor' && text.startsWith('-');
        listing[key] = text === '' ? null : parseMoney(negative ? text.slice(1) : text, listingInputs.get('currency').value.trim().toUpperCase()) * (negative ? -1 : 1);
      } catch (error) { listing[key] = null; issues.push({ field: key, message: error.message }); }
    } else listing[key] = ['integer', 'number'].includes(type) ? text === '' ? null : Number(text)
      : ['currency', 'country'].includes(key) ? text.toUpperCase() : text;
  }
  issues.push(...listingFieldIssues(listing));
  for (const issue of issues) {
    const input = listingInputs.get(issue.field); if (!input) continue;
    input.setAttribute('aria-invalid', 'true'); $('#' + input.id + '-error').textContent = issue.message;
  }
  if (issues.length) {
    $('#listing-fields').open = true; listingErrorField = issues[0].field;
    throw Error(issues[0].message);
  }
  return listing;
}
$('#listing-enabled').addEventListener('change', listingControls);
$('#archive-listing').addEventListener('click', () => void run(async () => {
  if (!selected?.listing || dirty) throw Error('Save or reopen your listing before changing its archive state.');
  const archived = isArchived(selected), saved = await saveDraft({ ...selected,
    listing: { ...selected.listing, status: archived ? 'draft' : 'archived' } }, selected.revision);
  show(saved); await refresh(); changed(); message(archived ? 'Listing restored as a private draft.' : 'Listing archived. Its facts are kept; restore it here or find it with the Archived filter.');
}));
function changed() { document.dispatchEvent(new Event('commerce:drafts-updated')); }
function message(text, error = false) { $('#status').textContent = text; $('#status').dataset.error = String(error); }
function invalidateReview() { reviewed = null; $('#launch-review').hidden = true; $('#approve-launch').checked = false; $('#export-launch').disabled = true; }
function rawLaunch() { return Object.fromEntries(Object.entries({ ...textFields, ...moneyFields }).map(([key, selector]) => [key, $(selector).value])); }
function setupState() { return evaluateOfferSetup({ title: $('#title').value, launch: inspectLaunchInput(rawLaunch()).terms }); }
function renderSetup() {
  const setup = setupState(), saved = selected && !isArchived(selected) && !dirty && !stale && !actionFailed;
  const currentReview = saved && reviewed?.draftId === selected.id && reviewed?.revision === selected.revision;
  const acknowledged = Boolean(currentReview && $('#approve-launch').checked);
  const steps = [...setup.steps, { id: 'review', complete: acknowledged }];
  $('#setup-count').textContent = `${steps.filter(step => step.complete).length} of 4 steps complete`;
  $('#setup-status').textContent = isArchived(selected) ? 'This listing is archived. Restore it before launch review.' : busy ? 'Checking this offer…' : actionFailed ? `The action could not finish. Your editor text is still here. ${$('#status').textContent}`
    : stale ? 'The saved offer changed. Reload its latest version before review.'
    : dirty || !selected ? 'Your current inputs are checked in the setup guide. Save them before review.'
    : acknowledged ? `Revision ${selected.revision} reviewed on this device. You can export its setup.`
    : currentReview ? `Read the review for revision ${selected.revision}, then acknowledge it below.`
    : `Revision ${selected.revision} saved on this device. Review it when the first three steps are complete.`;
  const reviewAction = stale ? 'reload' : !saved ? 'save' : acknowledged ? 'export' : currentReview ? 'acknowledge' : 'review';
  const actionLabel = stale ? 'Reload saved offer' : !saved ? 'Save offer' : acknowledged ? 'Export reviewed setup'
    : currentReview ? 'Read and acknowledge review' : 'Review saved offer';
  setupProjection = { title: 'Offer setup', closeLabel: 'Close offer setup', summary: $('#setup-count').textContent,
    status: $('#setup-status').textContent, selectedId: selectedSetupStep, busy,
    items: setupItems.map((item, index) => ({ ...item, meta: steps[index].complete ? 'Complete' : 'Needs attention',
      actionLabel: item.id === 'review' ? actionLabel : item.actionLabel,
      actionDisabled: busy || item.id === 'review' && reviewAction === 'review' && setup.status !== 'reviewable' })),
    notice: 'Local setup only. Publication, live pricing and payment require the authorized Commerce runtime.',
    onSelect(id) { if (!busy && setupItems.some(item => item.id === id)) { selectedSetupStep = id; renderSetup(); } },
    onAction(id) { if (!busy) activateSetupStep(id, reviewAction); },
    onClose() { setupGuide?.close(); },
  };
  setupGuide?.update(setupProjection);
  $('#export-launch').disabled = busy || !acknowledged || isArchived(selected);
  $('#review-launch').disabled = busy || isArchived(selected);
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
  showListing(draft); message(''); renderSetup();
}
async function refresh() {
  const drafts = await listDrafts();
  renderAudienceSuggestions(drafts);
  $('#draft-count').textContent = String(drafts.length);
  const hasDrafts = drafts.length > 0;
  const layout = $('#vendor [data-view-panel="vendor-editor"] .editor-layout');
  layout.querySelector('.draft-panel').hidden = !hasDrafts;
  layout.classList.toggle('no-saved-drafts', !hasDrafts);
  $('#draft-list').replaceChildren();
  for (const draft of drafts) {
    const button = document.createElement('button'), title = document.createElement('span'), time = document.createElement('small');
    button.type = 'button'; button.setAttribute('aria-current', String(draft.id === selected?.id));
    title.textContent = (isArchived(draft) ? 'Archived · ' : '') + draft.title; time.textContent = 'Updated ' + new Date(draft.updatedAt).toLocaleDateString(displayLocale, { month: 'short', day: 'numeric', year: 'numeric' });
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
function controls() { return document.querySelectorAll('[data-view-panel="vendor-editor"] button, [data-view-panel="vendor-editor"] input, [data-view-panel="vendor-editor"] select, [data-view-panel="vendor-editor"] textarea, [data-view-panel="admin-data"] button, [data-view-panel="admin-data"] input'); }
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
    renderSetup(); listingControls();
    if (listingErrorField) listingInputs.get(listingErrorField)?.focus();
  }
}
$('#draft-form').addEventListener('input', edited);
$('#draft-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = { id: selected?.id, title: $('#title').value, description: $('#description').value, price: $('#price').value };
  void run(async () => {
    input.listing = readListing();
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
function activateSetupStep(id, action) {
  if (id !== 'review') {
    const defaults = { describe: 'title', identity: 'merchantId', economics: 'currency' };
    const step = setupState().steps.find(item => item.id === id);
    if (!step) return;
    const field = step.fields[0] || defaults[id];
    setupGuide?.close(false); $('#launch-fields').open = true;
    $(({ title: '#title', ...textFields, ...moneyFields })[field] || '#title').focus();
    return;
  }
  switch (action) {
    case 'save': if (!$('#draft-form').checkValidity()) setupGuide?.close(false); $('#draft-form').requestSubmit(); break;
    case 'review': $('#review-launch').click(); break;
    case 'acknowledge': setupGuide?.close(false); $('#approve-launch').focus(); break;
    case 'export': $('#export-launch').click(); break;
    case 'reload': void openSavedDraft(selected.id).catch(error => { actionFailed = true; message(error.message, true); renderSetup(); }); break;
  }
}
$('#open-setup-guide').addEventListener('click', async () => {
  if (busy) return;
  const ticket = ++setupGeneration;
  try {
    const { createCommerceSetupGuide } = await import('./workspace-graph.js');
    if (ticket !== setupGeneration || location.hash !== '#vendor-editor') return;
    setupGuide ??= createCommerceSetupGuide({ launcher: $('#open-setup-guide') });
    await setupGuide.open(setupProjection);
  } catch (error) { if (ticket === setupGeneration) message(error.message || 'Could not open the setup guide.', true); }
});
window.addEventListener('hashchange', () => {
  if (location.hash !== '#vendor-editor') { setupGeneration++; setupGuide?.close(false); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
void refresh().catch(error => { actionFailed = true; message(error.message, true); renderSetup(); });
$('#editor-fields').disabled = false; $('#import').disabled = false; $('#export').disabled = false;
renderSetup();
listingControls();
