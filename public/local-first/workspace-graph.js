// Commerce owns record projection and actions; Graph owns the table and field view.
const mounts = new WeakMap();
const cssUrl = new URL('./graph-data-view.css', import.meta.url).href;
let adapter;
const el = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
};
export const OFFER_COLUMNS = Object.freeze(['Offer', 'Merchant', 'Review status', 'Planned price', 'Updated'].map((name, i) => ({ id: 'offer-' + i, name })));
/** Only already-public launch fields enter the shared view. No draft notes or workflow output. */
export function projectOfferRows(offers, presentation) {
  return offers.map(offer => ({ id: offer.id, cells: [offer.title, offer.launch?.merchantId || 'Store not set',
    presentation.status(offer), presentation.price(offer), new Date(offer.updatedAt).toLocaleDateString()] }));
}
export function projectOfferDetail(offer, presentation) {
  const labels = ['Offer', 'Merchant', 'Review status', 'Planned price', 'Buyer', 'Outcome', 'Review guidance', 'Saved revision'];
  return { columns: labels.map((name, i) => ({ id: 'detail-' + i, name })), rows: [{ id: offer.id,
    cells: [offer.title, offer.launch?.merchantId || 'Store not set', presentation.status(offer), presentation.price(offer),
      offer.launch?.audience || 'Not set', offer.launch?.outcome || 'Not set', presentation.reason(offer), String(offer.revision)] }] };
}
export function disposeTable(container) {
  const state = mounts.get(container);
  if (!state) return;
  state.disposed = true; state.grid?.destroy(); state.detail?.destroy(); mounts.delete(container);
}
async function surface(host, signal) {
  const shadow = host.attachShadow({ mode: 'open' }), stylesheet = el('link'), target = el('div');
  stylesheet.rel = 'stylesheet'; stylesheet.href = cssUrl;
  const loaded = new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); stylesheet.onload = null; stylesheet.onerror = null;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException('Shared surface closed.', 'AbortError'));
    const timer = setTimeout(() => finish(Error('Shared view styles could not load.')), 8000);
    stylesheet.onload = () => finish();
    stylesheet.onerror = () => finish(Error('Shared view styles could not load.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  shadow.append(stylesheet, target);
  await loaded;
  return target;
}
export async function mountCommerceTable(container, offers, presentation, actions) {
  disposeTable(container);
  const state = { disposed: false, grid: null, detail: null }; mounts.set(container, state);
  const layout = el('div', undefined, 'graph-record-layout'), gridHost = el('div', undefined, 'graph-record-grid');
  const details = el('section', undefined, 'graph-record-detail'); details.hidden = true;
  details.setAttribute('aria-label', 'Selected offer');
  layout.append(gridHost, details); container.replaceChildren(layout);
  try {
    adapter ??= import('./graph-data-view.js').catch(error => { adapter = null; throw error; });
    const [native, target] = await Promise.all([adapter, surface(gridHost)]);
    if (state.disposed || mounts.get(container) !== state) return;
    const rows = projectOfferRows(offers, presentation);
    let selection = 0;
    const select = async id => {
      const offer = offers.find(value => value.id === id);
      if (!offer || state.disposed) return;
      const revision = ++selection;
      state.grid.update({ columns: OFFER_COLUMNS, rows, selectedRowId: id, ariaLabel: actions.label, onActivateRow: select });
      state.detail?.destroy(); state.detail = null;
      const heading = el('h3', offer.title), note = el('p', 'Saved on this device · revision ' + offer.revision, 'footnote');
      heading.tabIndex = -1;
      const header = el('div', undefined, 'records-heading'), close = el('button', 'Close details', 'secondary'); close.type = 'button';
      close.addEventListener('click', () => { selection++; state.detail?.destroy(); state.detail = null; details.hidden = true; layout.classList.remove('has-selection'); state.grid.update({ columns: OFFER_COLUMNS, rows, ariaLabel: actions.label, onActivateRow: select }); gridHost.shadowRoot.querySelectorAll('tr[tabindex="0"]')[rows.findIndex(row => row.id === id)]?.focus(); });
      header.append(heading, close);
      const detailHost = el('div', undefined, 'graph-record-fields'), controls = el('div', undefined, 'record-actions');
      const edit = el('a', actions.editLabel, 'button secondary'); edit.href = '#vendor-editor';
      edit.addEventListener('click', event => { event.preventDefault(); actions.open(offer); }); controls.append(edit);
      if (actions.inspect) { const inspect = el('button', 'Inspect with tools', 'secondary'); inspect.type = 'button'; inspect.setAttribute('aria-label', 'Inspect ' + offer.title + ' with agent tools'); inspect.addEventListener('click', () => actions.inspect(offer)); controls.append(inspect); }
      details.replaceChildren(header, note, detailHost, controls); details.hidden = false; layout.classList.add('has-selection');
      try {
        const detailTarget = await surface(detailHost);
        if (state.disposed || selection !== revision) return;
        state.detail = native.mountDataView(detailTarget, { ...projectOfferDetail(offer, presentation), orientation: 'columns', ariaLabel: 'Offer fields' });
        heading.focus({ preventScroll: true });
      } catch (error) { if (!state.disposed && selection === revision) detailHost.replaceChildren(el('p', error.message, 'muted')); }
    };
    state.grid = native.mountDataView(target, { columns: OFFER_COLUMNS, rows, ariaLabel: actions.label, onActivateRow: select });
  } catch (error) { if (!state.disposed && mounts.get(container) === state) { disposeTable(container); throw error; } }
}

/** Host lifecycle only; the native adapter owns the panel and sequence presentation. */
export function createCommerceSetupGuide({ launcher }) {
  let generation = 0, host, handle, latest, loading, requested = false;
  const close = (restoreFocus = true) => {
    generation++; requested = false; loading?.abort(); loading = null;
    handle?.destroy(); handle = null; host?.remove(); host = null;
    launcher.setAttribute('aria-expanded', 'false');
    if (restoreFocus && launcher.isConnected && !launcher.disabled) launcher.focus();
  };
  return {
    close,
    update(state) { latest = state; handle?.update(state); },
    async open(state) {
      latest = state;
      if (requested) { handle?.update(state); return; }
      requested = true;
      const ticket = ++generation;
      host = el('div'); host.id = 'setup-guide-panel'; loading = new AbortController();
      document.body.append(host);
      launcher.setAttribute('aria-expanded', 'true');
      try {
        adapter ??= import('./graph-data-view.js').catch(error => { adapter = null; throw error; });
        const [native, target] = await Promise.all([adapter, surface(host, loading.signal)]);
        if (!requested || generation !== ticket) return;
        handle = native.mountSequenceGuide(target, latest);
      } catch (error) {
        if (!requested || generation !== ticket) return;
        close(); throw error;
      }
    },
  };
}
