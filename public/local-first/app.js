import { listDrafts, saveDraft, importDrafts, exportDrafts, LIMITS } from './drafts.js';

const $ = selector => document.querySelector(selector);
let selected = null, dirty = false, busy = false;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('commerce-local-drafts') : null;
function message(text, error = false) { $('#status').textContent = text; $('#status').dataset.error = String(error); }
function edited() { dirty = true; $('#save-state').textContent = 'Unsaved changes'; }
function mayLeave() { return !dirty || window.confirm('Leave these unsaved edits? Your saved drafts will remain.'); }
function show(draft) {
  selected = draft; dirty = false;
  $('#title').value = draft?.title ?? ''; $('#description').value = draft?.description ?? ''; $('#price').value = draft?.price ?? '';
  $('#editor-heading').textContent = draft ? 'Offer draft' : 'New offer draft';
  $('#save-state').textContent = draft ? 'Saved on this device' : 'Not saved yet';
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
async function run(operation) {
  if (busy) return;
  busy = true;
  for (const element of document.querySelectorAll('button, input, textarea')) element.disabled = true;
  try { await operation(); } catch (error) { message(error.message || 'Could not complete this action.', true); }
  finally { busy = false; for (const element of document.querySelectorAll('button, input, textarea')) element.disabled = false; }
}
$('#draft-form').addEventListener('input', edited);
$('#draft-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = { id: selected?.id, title: $('#title').value, description: $('#description').value, price: $('#price').value };
  void run(async () => {
    const saved = await saveDraft(input, selected?.revision ?? null);
    show(saved); await refresh(); message('Saved privately on this device.'); channel?.postMessage('changed');
  });
});
$('#new-draft').addEventListener('click', () => {
  if (busy || !mayLeave()) return;
  show(null); void refresh().catch(error => message(error.message, true)); $('#title').focus();
});
$('#export').addEventListener('click', () => void run(async () => {
  const text = await exportDrafts();
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `commerce-drafts-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  message(dirty ? 'Saved drafts exported. Unsaved editor text is not included.' : 'Draft backup exported. Keep it somewhere safe.');
}));
$('#import').addEventListener('change', event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  void run(async () => {
    if (file.size > LIMITS.transferBytes) throw Error('Import exceeds 8 MB.');
    const count = await importDrafts(await file.text()); await refresh();
    message(`Imported ${count} draft${count === 1 ? '' : 's'}. Existing drafts were preserved.`); channel?.postMessage('changed');
  });
});
if (channel) channel.onmessage = () => {
  void refresh().then(() => { if (selected) message('Saved drafts changed in another tab. Reopen a draft to load its latest version.'); })
    .catch(error => message(error.message, true));
};
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
function connection() { $('#connection').textContent = navigator.onLine ? 'Local workspace · Online' : 'Offline · Drafts available'; }
window.addEventListener('online', connection); window.addEventListener('offline', connection); connection();
void refresh().catch(error => message(error.message, true));
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => { $('#offline-ready').textContent = 'Offline access is ready. You can return to this workspace without a connection.'; })
    .catch(() => { $('#offline-ready').textContent = 'Offline page loading is unavailable in this browser. Saved drafts still stay on this device.'; });
} else $('#offline-ready').textContent = 'This browser needs a connection to open the page. Your saved drafts stay on this device.';
