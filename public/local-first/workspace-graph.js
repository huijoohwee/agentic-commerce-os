// Commerce owns record projection and actions; Agentic Base owns the portable table.
const mounts = new WeakMap();
const baseCssUrl = new URL('./agentic-base-data-view.css', import.meta.url).href;
const graphCssUrl = new URL('./graph-data-view.css', import.meta.url).href;
const displayLocale = globalThis.document?.documentElement?.lang || 'en';
let baseAdapter;
let graphAdapter;
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
    presentation.status(offer), presentation.price(offer), new Date(offer.updatedAt).toLocaleDateString(displayLocale)] }));
}
function responsiveOfferView(offers, presentation, width) {
  if (width >= 920) return { columns: OFFER_COLUMNS, rows: projectOfferRows(offers, presentation) };
  const count = width >= 740 ? 4 : width >= 560 ? 3 : width >= 400 ? 2 : 1;
  const columns = count === 1 ? [{ id: 'offer-summary', name: 'Offer' }]
    : count === 2 ? [OFFER_COLUMNS[0], { id: 'offer-launch', name: 'Launch' }]
      : count === 3 ? [OFFER_COLUMNS[0], OFFER_COLUMNS[1], { id: 'offer-review', name: 'Review' }]
        : OFFER_COLUMNS.slice(0, 4);
  const rows = offers.map(offer => {
    const merchant = offer.launch?.merchantId || 'Store not set', status = presentation.status(offer), price = presentation.price(offer);
    const cells = count === 1 ? [`${offer.title}\n${merchant} · ${status} · ${price}`]
      : count === 2 ? [offer.title, `${merchant}\n${status}\n${price}`]
        : count === 3 ? [offer.title, merchant, `${status}\n${price}`] : [offer.title, merchant, status, price];
    return { id: offer.id, cells };
  });
  return { columns, rows };
}
export function projectOfferDetail(offer, presentation) {
  const labels = ['Offer', 'Merchant', 'Review status', 'Planned price', 'Buyer', 'Outcome', 'Review guidance', 'Saved revision'];
  return { columns: labels.map((name, i) => ({ id: 'detail-' + i, name })), rows: [{ id: offer.id,
    cells: [offer.title, offer.launch?.merchantId || 'Store not set', presentation.status(offer), presentation.price(offer),
      offer.launch?.audience || 'Not set', offer.launch?.outcome || 'Not set', presentation.reason(offer), String(offer.revision)] }] };
}
function mountOfferDetail(target, native, offer, presentation) {
  const data = projectOfferDetail(offer, presentation);
  if (target.clientWidth >= 360) return native.mountDataView(target, { ...data, orientation: 'columns', ariaLabel: 'Offer fields' });
  target.classList.add('offer-detail-list');
  const list = el('dl'), values = data.rows[0].cells;
  data.columns.forEach((column, index) => {
    const pair = el('div', undefined, 'offer-detail-pair');
    pair.append(el('dt', column.name), el('dd', values[index])); list.append(pair);
  });
  target.append(list);
  return { destroy: () => list.remove() };
}
function applyBaseTheme(host) {
  const slots = {
    '--agentic-base-text': 'var(--kg-text-primary, #172033)',
    '--agentic-base-surface': 'var(--kg-panel-bg, #fff)',
    '--agentic-base-border': 'var(--kg-border, #d9dee8)',
    '--agentic-base-muted': 'var(--kg-text-secondary, #64748b)',
    '--agentic-base-header': 'var(--kg-panel-bg, #f7f8fa)',
    '--agentic-base-selected': 'color-mix(in srgb, var(--kg-accent, #2563eb) 12%, var(--kg-panel-bg, #fff))',
    '--agentic-base-hover': 'color-mix(in srgb, var(--kg-accent, #2563eb) 7%, var(--kg-panel-bg, #fff))',
    '--agentic-base-focus': 'var(--kg-accent, #2563eb)',
  };
  for (const [name, value] of Object.entries(slots)) host.style.setProperty(name, value);
}
function mountOfferCards(target, offers, presentation, selectedId, activate) {
  const list = el('ul', undefined, 'vendor-offer-card-grid');
  for (const offer of offers) {
    const item = el('li', undefined, 'vendor-offer-card-item'), button = el('button', undefined, 'vendor-offer-card-open');
    button.type = 'button'; button.setAttribute('aria-label', 'Open details for ' + offer.title);
    button.setAttribute('aria-pressed', String(selectedId === offer.id)); button.addEventListener('click', () => activate(offer.id));
    const cover = el('span', presentation.monogram(offer.title), 'product-monogram vendor-offer-cover'); cover.setAttribute('aria-hidden', 'true'); button.dataset.offerId = offer.id;
    const meta = el('span', undefined, 'vendor-offer-card-meta'), merchant = el('span', presentation.merchantName?.(offer.launch?.merchantId) || offer.launch?.merchantId || 'Store not set', 'vendor-offer-merchant');
    const state = el('span', presentation.status(offer), 'vendor-offer-state'); state.dataset.state = offer.launch ? presentation.state(offer) : 'draft'; meta.append(merchant, state);
    const title = el('span', offer.title, 'vendor-offer-title');
    const outcome = el('span', offer.launch?.outcome || 'Add a buyer and outcome to complete setup.', 'vendor-offer-outcome');
    const updatedAt = new Date(offer.updatedAt), updated = Number.isNaN(updatedAt.valueOf()) ? 'Recently saved' : 'Updated ' + updatedAt.toLocaleDateString(displayLocale, { month: 'short', day: 'numeric' });
    const footer = el('span', undefined, 'vendor-offer-card-footer'); footer.append(el('span', presentation.price(offer), 'vendor-offer-price'), el('span', updated, 'vendor-offer-updated'));
    button.append(cover, meta, title, outcome, footer); item.append(button); list.append(item);
  }
  target.replaceChildren(list);
}
function loadBaseAdapter() {
  baseAdapter ??= import('./agentic-base-data-view.js').catch(error => { baseAdapter = null; throw error; });
  return baseAdapter;
}
function loadGraphAdapter() {
  graphAdapter ??= import('./graph-data-view.js').catch(error => { graphAdapter = null; throw error; });
  return graphAdapter;
}
export function disposeTable(container) {
  const state = mounts.get(container);
  if (!state) return;
  state.disposed = true; state.observer?.disconnect();
  if (state.resizeListener) window.removeEventListener('resize', state.resizeListener);
  state.grid?.destroy(); state.detail?.destroy(); mounts.delete(container);
}
async function surface(host, signal, stylesheetUrl) {
  const shadow = host.attachShadow({ mode: 'open' }), stylesheet = el('link'), target = el('div');
  stylesheet.rel = 'stylesheet'; stylesheet.href = stylesheetUrl;
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
  const state = { disposed: false, grid: null, detail: null, observer: null, resizeListener: null }; mounts.set(container, state);
  const layout = el('div', undefined, 'graph-record-layout'), gridHost = el('div', undefined, 'graph-record-grid');
  const cards = actions.display === 'cards';
  if (cards) { gridHost.classList.add('vendor-offer-card-host'); gridHost.style.overflow = 'visible'; }
  else applyBaseTheme(gridHost);
  const details = el('section', undefined, 'graph-record-detail'); details.hidden = true;
  details.setAttribute('aria-label', 'Selected offer');
  layout.append(gridHost, details); container.replaceChildren(layout);
  try {
    const native = cards ? null : await loadBaseAdapter();
    if (state.disposed || mounts.get(container) !== state) return;
    let selection = 0, selectedId = null;
    let view = responsiveOfferView(offers, presentation, gridHost.clientWidth);
    let viewKey = view.columns.map(column => column.id).join(':');
    let refreshGrid;
    const updateGrid = () => {
      if (cards) mountOfferCards(gridHost, offers, presentation, selectedId, select);
      else state.grid?.update({ ...view, selectedRowId: selectedId || undefined, ariaLabel: actions.label, onActivateRow: select });
    };
    const select = async id => {
      const offer = offers.find(value => value.id === id);
      if (!offer || state.disposed) return;
      const revision = ++selection; selectedId = id;
      if (!cards) { view = responsiveOfferView(offers, presentation, gridHost.clientWidth); viewKey = view.columns.map(column => column.id).join(':'); }
      updateGrid();
      state.detail?.destroy(); state.detail = null;
      const heading = el('h3', offer.title), note = el('p', 'Saved on this device · revision ' + offer.revision, 'footnote');
      heading.tabIndex = -1;
      const header = el('div', undefined, 'records-heading'), close = el('button', 'Close details', 'secondary'); close.type = 'button';
      close.addEventListener('click', () => { selection++; selectedId = null; state.detail?.destroy(); state.detail = null; details.hidden = true; layout.classList.remove('has-selection'); if (cards) { updateGrid(); [...gridHost.querySelectorAll('button')].find(button => button.dataset.offerId === id)?.focus(); } else { refreshGrid(true); gridHost.shadowRoot.querySelectorAll('tr[tabindex="0"]')[view.rows.findIndex(row => row.id === id)]?.focus(); } });
      header.append(heading, close);
      const detailHost = el('div', undefined, 'graph-record-fields'), controls = el('div', undefined, 'record-actions');
      applyBaseTheme(detailHost);
      const edit = el('a', actions.editLabel, 'button secondary'); edit.href = '#vendor-editor';
      edit.addEventListener('click', event => { event.preventDefault(); actions.open(offer); }); controls.append(edit);
      if (actions.inspect) { const inspect = el('button', 'Inspect with tools', 'secondary'); inspect.type = 'button'; inspect.setAttribute('aria-label', 'Inspect ' + offer.title + ' with agent tools'); inspect.addEventListener('click', () => actions.inspect(offer)); controls.append(inspect); }
      details.replaceChildren(header, note, detailHost, controls); details.hidden = false; layout.classList.add('has-selection');
      try {
        const adapter = native || await loadBaseAdapter();
        if (state.disposed || selection !== revision) return;
        const detailTarget = await surface(detailHost, undefined, baseCssUrl);
        if (state.disposed || selection !== revision) return;
        state.detail = mountOfferDetail(detailTarget, adapter, offer, presentation);
        if (matchMedia('(max-width:680px)').matches) details.scrollIntoView({ block: 'start',
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        heading.focus({ preventScroll: true });
      } catch (error) { if (!state.disposed && selection === revision) detailHost.replaceChildren(el('p', error.message, 'muted')); }
    };
    const refresh = () => {
      if (cards) return;
      const next = responsiveOfferView(offers, presentation, gridHost.clientWidth), key = next.columns.map(column => column.id).join(':');
      if (key === viewKey) return;
      view = next; viewKey = key;
      state.grid?.update({ ...view, selectedRowId: selectedId || undefined, ariaLabel: actions.label, onActivateRow: select });
    };
    refreshGrid = force => { if (force) viewKey = ''; refresh(); };
    if (cards) {
      state.grid = { update: next => { selectedId = next.selectedRowId || null; mountOfferCards(gridHost, offers, presentation, selectedId, select); }, destroy: () => gridHost.replaceChildren() };
      mountOfferCards(gridHost, offers, presentation, selectedId, select);
    } else {
      const target = await surface(gridHost, undefined, baseCssUrl);
      if (state.disposed || mounts.get(container) !== state) return;
      state.grid = native.mountDataView(target, { ...view, ariaLabel: actions.label, onActivateRow: select });
      if (typeof ResizeObserver === 'function') { state.observer = new ResizeObserver(refresh); state.observer.observe(gridHost); }
      else { state.resizeListener = refresh; window.addEventListener('resize', refresh); }
    }
  } catch (error) { if (!state.disposed && mounts.get(container) === state) { disposeTable(container); throw error; } }
}

/** Host lifecycle only; the native adapter owns the panel and sequence presentation. */
export function createCommerceSetupGuide({ launcher }) {
  let generation = 0, host, handle, latest, loading, resizeHeader, requested = false;
  const close = (restoreFocus = true) => {
    generation++; requested = false; loading?.abort(); loading = null;
    if (resizeHeader) window.removeEventListener('resize', resizeHeader);
    resizeHeader = null;
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
      resizeHeader = () => host?.style.setProperty('--kg-safe-top', `${Math.ceil(document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0)}px`);
      resizeHeader(); window.addEventListener('resize', resizeHeader, { passive: true });
      launcher.setAttribute('aria-expanded', 'true');
      try {
        const [native, target] = await Promise.all([loadGraphAdapter(), surface(host, loading.signal, graphCssUrl)]);
        if (!requested || generation !== ticket) return;
        handle = native.mountSequenceGuide(target, latest);
      } catch (error) {
        if (!requested || generation !== ticket) return;
        close(); throw error;
      }
    },
  };
}
