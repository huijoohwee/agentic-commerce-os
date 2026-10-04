import { listDrafts } from './drafts.js';

const $ = selector => document.querySelector(selector);
const views = new Set(['shop', 'checkout', 'vendor', 'vendor-editor', 'vendor-preview', 'admin', 'admin-reviews', 'admin-data', 'admin-runtime']);
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('commerce-local-drafts') : null;
let drafts = [], launch, editor, editorPromise, generation = 0, navigation = 0, shopPage = 0, detailId = null;
const tablePages = { vendor: 0, admin: 0 };
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function message(error) { $('#status').textContent = error.message || 'Could not open this workspace.'; $('#status').dataset.error = 'true'; }
async function loadEditor() {
  editorPromise ??= import('./app.js').catch(error => { editorPromise = null; throw error; });
  editor = await editorPromise; return editor;
}
function stateOf(draft) {
  return !draft.launch ? 'draft' : launch.evaluateLaunch(draft.launch).constraints.length ? 'revise' : 'reviewable';
}
const stateLabel = state => ({ draft: 'Draft', revise: 'Revise costs', reviewable: 'Ready for review' })[state];
function art(draft) {
  const visual = node('div', undefined, 'product-art'); visual.setAttribute('aria-hidden', 'true');
  visual.append(node('span', [...draft.title].slice(0, 2).join('').toUpperCase(), 'product-monogram')); return visual;
}
function price(draft) { return draft.launch ? launch.formatMoney(draft.launch.priceMinor, draft.launch.currency) : 'Not set'; }
function matches(draft, query) { return [draft.title, draft.launch?.merchantId, draft.launch?.outcome, draft.launch?.audience].join(' ').toLowerCase().includes(query); }
function showDetail(draft) {
  const current = drafts.find(item => item.id === draft.id && item.revision === draft.revision);
  if (!current?.launch) return;
  detailId = current.id;
  const heading = node('h2', current.title); heading.id = 'detail-heading';
  const body = $('#detail-content');
  body.replaceChildren(art(current), node('small', current.launch.merchantId), heading,
    node('p', current.launch.outcome), node('p', current.launch.audience, 'muted'),
    node('p', price(current), 'preview-price'), node('p', 'Planned price · Preview only', 'footnote'),
    node('p', 'This offer is a private draft. Orders and payments are not available in this preview.', 'muted'));
  $('#offer-detail').showModal();
}
$('#close-detail').addEventListener('click', () => $('#offer-detail').close());
$('#offer-detail').addEventListener('close', () => { detailId = null; });
function renderShop() {
  const query = $('#shop-query').value.trim().toLowerCase(), store = $('#shop-store').value;
  const offered = drafts.filter(draft => draft.launch);
  const filtered = offered.filter(draft => matches(draft, query) && (!store || draft.launch.merchantId === store));
  if ($('#shop-sort').value === 'name') filtered.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(filtered.length / 12)); shopPage = Math.min(shopPage, pages - 1);
  $('#shop-grid').replaceChildren();
  for (const draft of filtered.slice(shopPage * 12, shopPage * 12 + 12)) {
    const card = node('article', undefined, 'product-card'), button = node('button', 'View offer ↗'); button.type = 'button';
    button.setAttribute('aria-label', 'View ' + draft.title); button.addEventListener('click', () => showDetail(draft));
    card.append(art(draft), node('small', draft.launch.merchantId), node('h3', draft.title),
      node('p', price(draft) + ' · Planned price', 'preview-price'), button);
    $('#shop-grid').append(card);
  }
  $('#shop-count').textContent = `${filtered.length} preview offer${filtered.length === 1 ? '' : 's'}`;
  $('#shop-empty').hidden = filtered.length > 0;
  $('#shop-empty h3').textContent = offered.length ? 'No offers match your search.' : 'Your collection starts with one offer.';
  $('#shop-empty p').textContent = offered.length ? 'Try another search or choose a different store.' : 'Create an offer and complete its launch terms to see your storefront take shape.';
  $('#shop-empty a').hidden = offered.length > 0;
  $('#shop-pagination').hidden = pages <= 1; $('#shop-page').textContent = `Page ${shopPage + 1} of ${pages}`;
  $('#shop-previous').disabled = shopPage === 0; $('#shop-next').disabled = shopPage + 1 >= pages;
}
function offerLink(draft, text) {
  const link = node('a', text); link.href = '#vendor-editor';
  link.addEventListener('click', event => {
    event.preventDefault();
    void openOffer(draft.id).catch(message);
  }); return link;
}
async function openOffer(id) {
  const app = await loadEditor();
  if (!await app.openSavedDraft(id)) return;
  location.hash = 'vendor-editor'; await route(); $('#title').focus();
}
function renderTable(role) {
  const query = $('#' + role + '-query').value.trim().toLowerCase(), state = $('#' + role + '-state').value;
  const filtered = drafts.filter(draft => matches(draft, query) && (!state || stateOf(draft) === state));
  const pages = Math.max(1, Math.ceil(filtered.length / 10)); tablePages[role] = Math.min(tablePages[role], pages - 1);
  const container = $('#' + role + '-table'); container.replaceChildren();
  if (!filtered.length) {
    const empty = node('div', undefined, 'empty-state'); empty.append(node('h3', drafts.length ? 'No matching offers' : 'No offers yet'),
      node('p', drafts.length ? 'Change the search or status filter.' : 'Create an offer in the vendor workspace to begin.'));
    const link = node('a', 'Create an offer', 'button secondary'); link.href = '#vendor-editor'; empty.append(link); container.append(empty);
  } else {
    const table = node('table', undefined, 'data-table'), head = node('thead'), heading = node('tr'), body = node('tbody');
    table.setAttribute('aria-label', role === 'vendor' ? 'Vendor offers' : 'Launch review queue');
    const columns = ['Offer', 'Status', 'Planned price', 'Updated', 'Action'];
    for (const label of columns) { const th = node('th', label); th.scope = 'col'; heading.append(th); } head.append(heading);
    for (const draft of filtered.slice(tablePages[role] * 10, tablePages[role] * 10 + 10)) {
      const row = node('tr'), title = node('td'), state = stateOf(draft), status = node('td');
      title.append(offerLink(draft, draft.title), node('small', draft.launch?.merchantId || 'Store not set'));
      status.append(node('span', stateLabel(state), 'state-badge state-' + state));
      const action = node('td'); action.append(offerLink(draft, role === 'admin' && state === 'reviewable' ? 'Review offer ↗' : 'Edit offer ↗'));
      const cells = [title, status, node('td', price(draft)), node('td', new Date(draft.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), action];
      cells.forEach((cell, index) => { cell.dataset.label = columns[index]; row.append(cell); }); body.append(row);
    }
    table.append(head, body); container.append(table);
    if (pages > 1) {
      const pager = node('nav', undefined, 'pagination'); pager.setAttribute('aria-label', role + ' pagination');
      for (const [label, offset] of [['Previous', -1], ['Next', 1]]) {
        const button = node('button', label, 'secondary'); button.type = 'button';
        button.disabled = offset < 0 ? tablePages[role] === 0 : tablePages[role] + 1 >= pages;
        button.addEventListener('click', () => { tablePages[role] += offset; renderTable(role); });
        if (offset > 0) pager.append(node('span', `Page ${tablePages[role] + 1} of ${pages}`)); pager.append(button);
      }
      container.append(pager);
    }
  }
  $('#' + role + '-count').textContent = `${filtered.length} offer${filtered.length === 1 ? '' : 's'} · Saved on this device`;
}
async function refresh() {
  const revision = ++generation, next = await listDrafts();
  if (next.some(draft => draft.launch)) launch ??= await import('./launch.js');
  if (revision !== generation) return;
  drafts = next;
  if (detailId) $('#offer-detail').close();
  const selectedStore = $('#shop-store').value;
  $('#shop-store').replaceChildren(new Option('All stores', ''), ...[...new Set(drafts.filter(d => d.launch).map(d => d.launch.merchantId))].sort().map(store => new Option(store, store)));
  if ([...$('#shop-store').options].some(option => option.value === selectedStore)) $('#shop-store').value = selectedStore;
  const complete = drafts.filter(draft => draft.launch), reviewable = complete.filter(draft => stateOf(draft) === 'reviewable');
  $('#vendor-total').textContent = String(drafts.length); $('#vendor-complete').textContent = String(complete.length);
  $('#admin-stores').textContent = String(new Set(complete.map(d => d.launch.merchantId)).size);
  $('#admin-reviewable').textContent = String(reviewable.length); $('#admin-attention').textContent = String(drafts.length - reviewable.length);
  renderScope();
  renderCurrent();
}
function renderCurrent() {
  if (!$('#shop').hidden) renderShop();
  if (!$('#vendor').hidden) renderTable('vendor');
  if (!$('#admin').hidden) renderTable('admin');
  renderEnvironment();
}
async function route() {
  const revision = ++navigation, hash = location.hash.slice(1), view = views.has(hash) ? hash : 'shop', role = view.split('-')[0];
  document.querySelectorAll('[data-role-panel]').forEach(panel => { panel.hidden = panel.dataset.rolePanel !== role; });
  document.querySelectorAll('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  document.querySelectorAll('[data-role]').forEach(link => { if (link.dataset.role === (role === 'checkout' ? 'shop' : role)) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-view]').forEach(link => { if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#workspace-context').hidden = !['vendor', 'admin'].includes(role);
  document.title = `${role === 'checkout' ? 'Checkout' : role === 'shop' ? 'Shopper' : role === 'vendor' ? 'Vendor workspace' : 'Admin workspace'} · Airvio`;
  if (view === 'vendor-editor' || view === 'admin-data') await loadEditor();
  if (revision !== navigation) return;
  if (view === 'checkout') await (await import('./checkout.js')).openCheckout();
  renderCurrent();
  if (hash !== 'collection' && hash !== 'main') document.querySelector(`#${role} [data-view-panel="${view}"] h1, #${role}-heading`)?.focus({ preventScroll: true });
}
$('#shop-search').addEventListener('submit', event => event.preventDefault());
for (const id of ['shop-query', 'shop-store', 'shop-sort']) $('#' + id).addEventListener('input', () => { shopPage = 0; renderShop(); });
$('#shop-previous').addEventListener('click', () => { shopPage--; renderShop(); });
$('#shop-next').addEventListener('click', () => { shopPage++; renderShop(); });
for (const role of ['vendor', 'admin']) for (const field of ['query', 'state']) $('#' + role + '-' + field).addEventListener('input', () => { tablePages[role] = 0; renderTable(role); });
$('#create-offer').addEventListener('click', event => { event.preventDefault(); void loadEditor().then(app => { if (app.newDraft()) location.hash = 'vendor-editor'; }).catch(message); });
window.addEventListener('hashchange', () => { if ($('#offer-detail').open) $('#offer-detail').close(); void route().catch(message); });
document.addEventListener('commerce:drafts-updated', () => { channel?.postMessage('changed'); void refresh().catch(message); });
if (channel) channel.onmessage = () => { void refresh().catch(message); void editor?.externalChange().catch(message); };
function connection() { $('#connection').textContent = navigator.onLine ? 'Local workspace · Online' : 'Offline · Drafts available'; }
window.addEventListener('online', connection); window.addEventListener('offline', connection); connection();
const sourceRevision = document.querySelector('meta[name="commerce-source"]').content;
let environmentController = null, environmentGeneration = 0, environmentObservation = null, environmentExpiry;
const environmentHistory = [];
function renderScope() {
  const stores = [...new Set(drafts.filter(draft => draft.launch).map(draft => draft.launch.merchantId))];
  const scope = stores.length === 1 ? stores[0] : stores.length ? `${stores.length} stores in local drafts` : 'No saved merchant';
  $('#workspace-scope').textContent = scope + ' · This device';
  $('#environment-scope').textContent = scope;
}
function renderEnvironment() {
  const observation = environmentObservation;
  const stale = observation && (observation.stale || !navigator.onLine || Date.now() - observation.time > 60000);
  clearTimeout(environmentExpiry);
  if (observation && !stale) environmentExpiry = setTimeout(renderEnvironment, Math.max(1, 60001 - (Date.now() - observation.time)));
  $('#environment-source').textContent = sourceRevision === 'local-unreleased' ? 'Local development · Unreleased changes' : sourceRevision;
  $('#environment-badge').textContent = !navigator.onLine ? 'Offline' : stale ? 'Stale · Check again' : observation?.label || 'Not checked';
  $('#environment-checkout').textContent = stale ? 'Unknown · Observation is stale' : observation?.checkout || 'Unknown · Check environment';
  $('#environment-observed').textContent = observation ? new Date(observation.time).toLocaleString() + (stale ? ' · stale' : '') : 'Not checked';
  $('#environment-version').textContent = observation?.version || 'Unknown';
  $('#environment-refresh').disabled = !navigator.onLine || !!environmentController;
  $('#environment-cancel').hidden = !environmentController;
  if (!navigator.onLine) $('#environment-status').textContent = 'Offline. Drafts remain available; reconnect and explicitly check the environment.';
  else if (stale) $('#environment-status').textContent = 'This observation is stale. Check again before relying on it; no action is authorized by a previous result.';
  else $('#environment-status').textContent = environmentController ? 'Checking this environment…' : observation?.message || 'Check the current environment. Opening this page grants no publishing or payment access.';
}
async function readEnvironment(response) {
  if (![200, 503].includes(response.status) || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw Error('Environment response is unavailable or invalid.');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Environment response is empty.');
  let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 32768) throw Error('Environment response exceeded its limit.');
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel(); }
}
async function checkEnvironment() {
  if (environmentController || !navigator.onLine) return;
  const generation = ++environmentGeneration, controller = new AbortController(); environmentController = controller;
  clearTimeout(environmentExpiry); environmentObservation = null;
  const timer = setTimeout(() => controller.abort(), 5000);
  $('#environment-status').textContent = 'Checking this environment…'; renderEnvironment();
  let observation;
  try {
    const url = new URL('./readyz', location.href); url.hash = ''; url.search = '';
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
    const value = await readEnvironment(response);
    if (controller.signal.aborted) throw Error('cancelled');
    if (value.profile !== 'local-first' || value.sourceRevision !== sourceRevision || value.storage !== 'browser-only'
      || value.realMoney !== false || !['sandbox', 'unavailable'].includes(value.checkout) || typeof value.ok !== 'boolean'
      || value.ok !== (response.status === 200) || value.ok !== (value.checkout === 'sandbox')
      || (sourceRevision !== 'local-unreleased' && !/^[a-f0-9]{40}$/.test(sourceRevision))
      || (value.ok && (value.paymentProvider !== 'stripe' || value.paymentStorage !== 'stripe-test'))
      || (value.workerVersionId !== null && (typeof value.workerVersionId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.workerVersionId)))) {
      throw Error('Evidence does not match this page and profile. Reload the page, then check again.');
    }
    observation = { time: Date.now(), label: value.ok ? 'Sandbox configured' : 'Unavailable',
      checkout: value.ok ? 'Configured · Test mode only' : 'Unavailable · Drafts still work', version: value.workerVersionId,
      message: value.ok ? 'Sandbox configuration observed. No real payment, offer publication or fulfillment is proved by this check.'
        : 'The sandbox is unavailable here. Continue preparing drafts; the runtime owner must resolve its configuration.' };
  } catch (error) {
    observation = { time: Date.now(), label: 'Unknown', checkout: 'Unknown · Check again',
      message: controller.signal.aborted ? 'Check cancelled or timed out. The outcome is unknown; you can explicitly check again.'
        : ['SyntaxError', 'TypeError'].includes(error.name) ? 'Could not verify the environment. Keep working locally and check again when available.' : error.message };
  } finally { clearTimeout(timer); }
  if (generation !== environmentGeneration) return;
  environmentController = null; environmentObservation = observation;
  $('#environment-status').textContent = observation.message;
  environmentHistory.unshift(observation); environmentHistory.length = Math.min(20, environmentHistory.length);
  $('#environment-history').replaceChildren(...environmentHistory.map(item => node('li', new Date(item.time).toLocaleTimeString() + ' · ' + item.label + ' — ' + item.message)));
  renderEnvironment();
}
$('#environment-refresh').addEventListener('click', () => void checkEnvironment());
$('#environment-cancel').addEventListener('click', () => environmentController?.abort());
window.addEventListener('offline', () => { if (environmentObservation) environmentObservation.stale = true; environmentController?.abort(); renderEnvironment(); });
window.addEventListener('online', renderEnvironment);
window.addEventListener('focus', renderEnvironment);
window.addEventListener('pagehide', () => { environmentGeneration++; environmentController?.abort(); environmentController = null; clearTimeout(environmentExpiry); });
window.addEventListener('pageshow', renderEnvironment);
void Promise.all([refresh(), route()]).catch(message);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => { $('#offline-ready').textContent = 'Offline access is ready. You can return to this workspace without a connection.'; })
    .catch(() => { $('#offline-ready').textContent = 'Offline page loading is unavailable in this browser. Saved drafts still stay on this device.'; });
} else $('#offline-ready').textContent = 'This browser needs a connection to open the page. Your saved drafts stay on this device.';
