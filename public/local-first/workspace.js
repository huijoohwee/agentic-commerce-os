import { listDrafts } from './drafts.js';

const $ = selector => document.querySelector(selector);
const views = new Set(['shop', 'vendor', 'vendor-editor', 'vendor-preview', 'admin', 'admin-reviews', 'admin-data']);
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
  renderCurrent();
}
function renderCurrent() {
  if (!$('#shop').hidden) renderShop();
  if (!$('#vendor').hidden) renderTable('vendor');
  if (!$('#admin').hidden) renderTable('admin');
}
async function route() {
  const revision = ++navigation, hash = location.hash.slice(1), view = views.has(hash) ? hash : 'shop', role = view.split('-')[0];
  document.querySelectorAll('[data-role-panel]').forEach(panel => { panel.hidden = panel.dataset.rolePanel !== role; });
  document.querySelectorAll('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  document.querySelectorAll('[data-role]').forEach(link => { if (link.dataset.role === role) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-view]').forEach(link => { if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.title = `${role === 'shop' ? 'Shopper preview' : role === 'vendor' ? 'Vendor workspace' : 'Admin workspace'} · Airvio`;
  if (view === 'vendor-editor' || view === 'admin-data') await loadEditor();
  if (revision !== navigation) return;
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
void Promise.all([refresh(), route()]).catch(message);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => { $('#offline-ready').textContent = 'Offline access is ready. You can return to this workspace without a connection.'; })
    .catch(() => { $('#offline-ready').textContent = 'Offline page loading is unavailable in this browser. Saved drafts still stay on this device.'; });
} else $('#offline-ready').textContent = 'This browser needs a connection to open the page. Your saved drafts stay on this device.';
