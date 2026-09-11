import { listDrafts, saveDraft, importDrafts, exportDrafts, LIMITS } from './drafts.js';

const $ = selector => document.querySelector(selector);
let selected = null, dirty = false, busy = false;
let reviewed = null;
const textFields = { merchantId: '#merchant-id', agentId: '#agent-id', audience: '#audience', outcome: '#outcome', currency: '#currency' };
const moneyFields = { priceMinor: '#sale-price', deliveryCostMinor: '#delivery-cost', providerFeeMinor: '#provider-fee',
  agentCostMinor: '#agent-cost', acquisitionCostMinor: '#acquisition-cost', fixedCostMinor: '#fixed-cost' };
function changed() { document.dispatchEvent(new Event('commerce:drafts-updated')); }
function message(text, error = false) { $('#status').textContent = text; $('#status').dataset.error = String(error); }
function invalidateReview() { reviewed = null; $('#launch-review').hidden = true; $('#approve-launch').checked = false; $('#export-launch').disabled = true; }
function edited() { dirty = true; $('#save-state').textContent = 'Unsaved changes'; invalidateReview(); }
function mayLeave() { return !dirty || window.confirm('Leave these unsaved edits? Your saved drafts will remain.'); }
function show(draft) {
  selected = draft; dirty = false;
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
  message('');
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
  busy = true;
  for (const element of controls()) element.disabled = true;
  try { await operation(); } catch (error) { message(error.message || 'Could not complete this action.', true); }
  finally {
    busy = false; for (const element of controls()) element.disabled = false;
    $('#export-launch').disabled = !reviewed || !$('#approve-launch').checked;
  }
}
$('#draft-form').addEventListener('input', edited);
$('#draft-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = { id: selected?.id, title: $('#title').value, description: $('#description').value, price: $('#price').value };
  void run(async () => {
    const hasTerms = Object.values(textFields).some(selector => $(selector).value.trim())
      || Object.values(moneyFields).some(selector => $(selector).value.trim());
    if (hasTerms) {
      const { parseMoney } = await import('./launch.js');
      input.launch = Object.fromEntries(Object.entries(textFields).map(([key, selector]) => [key, $(selector).value.trim()]));
      input.launch.currency = input.launch.currency.toUpperCase();
      for (const [key, selector] of Object.entries(moneyFields)) input.launch[key] = parseMoney($(selector).value.trim(), input.launch.currency);
    } else input.launch = null;
    const saved = await saveDraft(input, selected?.revision ?? null);
    show(saved); await refresh(); message('Saved privately on this device.'); changed();
  });
});
$('#review-launch').addEventListener('click', () => void run(async () => {
  invalidateReview();
  if (!selected || dirty) throw Error('Save this offer before reviewing its launch.');
  const current = (await listDrafts()).find(draft => draft.id === selected.id);
  if (!current || current.revision !== selected.revision) throw Error('This offer changed. Reopen the saved version before review.');
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
$('#approve-launch').addEventListener('change', () => { $('#export-launch').disabled = busy || !reviewed || !$('#approve-launch').checked; });
$('#export-launch').addEventListener('click', () => void run(async () => {
  if (!reviewed || dirty || !$('#approve-launch').checked) throw Error('Review and acknowledge this saved offer first.');
  const current = (await listDrafts()).find(draft => draft.id === reviewed.draftId);
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
    const count = await importDrafts(await file.text()); await refresh();
    message(`Imported ${count} draft${count === 1 ? '' : 's'}. Existing drafts were preserved.`); changed();
  });
});
export async function externalChange() {
  invalidateReview(); await refresh();
  if (selected) message('Saved drafts changed in another tab. Reopen a draft to load its latest version.');
}
export async function openSavedDraft(id) {
  if (busy || !mayLeave()) return false;
  const current = (await listDrafts()).find(draft => draft.id === id);
  if (!current) throw Error('Draft no longer available.');
  show(current); await refresh(); return true;
}
export function newDraft() {
  if (busy || !mayLeave()) return false;
  show(null); void refresh().catch(error => message(error.message, true)); return true;
}
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
void refresh().catch(error => message(error.message, true));
$('#editor-fields').disabled = false; $('#import').disabled = false; $('#export').disabled = false;
