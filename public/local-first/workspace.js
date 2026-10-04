import { listDrafts, groupProjects } from './drafts.js';

const $ = selector => document.querySelector(selector);
const views = new Set(['shop', 'checkout', 'vendor', 'vendor-editor', 'vendor-preview', 'admin', 'admin-reviews', 'admin-data', 'admin-runtime', 'admin-project', 'admin-tools']);
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('commerce-local-drafts') : null;
let drafts = [], draftsLoaded = false, launch, editor, editorPromise, generation = 0, navigation = 0, shopPage = 0, detailId = null, searchRequested = null;
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
  drafts = next; draftsLoaded = true;
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
  if (!$('#admin').hidden) { renderTable('admin'); renderProjects(); }
  renderEnvironment();
}
async function route() {
  const revision = ++navigation, hash = location.hash.slice(1), requested = hash.split('?')[0], view = views.has(requested) ? requested : 'shop', role = view.split('-')[0];
  document.body.classList.toggle('console-mode', role !== 'checkout');
  document.body.dataset.workspaceRole = role;
  $('#console-breadcrumb').hidden = role === 'checkout';
  const root = $('#console-root'); root.href = '#' + role;
  root.textContent = ({ shop: 'Storefront', vendor: 'Catalog', admin: 'Projects' })[role] || 'Shopper';
  $('#console-location').textContent = ({ shop: 'Storefront preview', vendor: 'Offers', 'vendor-editor': 'Offer editor', 'vendor-preview': 'Storefront preview', admin: 'All projects', 'admin-project': 'Project', 'admin-runtime': 'Environment', 'admin-reviews': 'Launch reviews', 'admin-data': 'Data & portability', 'admin-tools': 'Tools & commands' })[view] || '';
  document.querySelectorAll('[data-role-panel]').forEach(panel => { panel.hidden = panel.dataset.rolePanel !== role; });
  document.querySelectorAll('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  document.querySelectorAll('[data-role]').forEach(link => { if (link.dataset.role === (role === 'checkout' ? 'shop' : role)) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-view]').forEach(link => { if (link.dataset.view === view || (view === 'admin-project' && link.dataset.view === 'admin')) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#workspace-context').hidden = role !== 'vendor';
  document.title = `${role === 'checkout' ? 'Checkout' : role === 'shop' ? 'Shopper' : role === 'vendor' ? 'Vendor workspace' : 'Admin workspace'} · Airvio`;
  if (view === 'vendor-editor' || view === 'admin-data') await loadEditor();
  if (revision !== navigation) return;
  if (view === 'admin-tools') await loadTools();
  if (revision !== navigation) return;
  if (view === 'checkout') await (await import('./checkout.js')).openCheckout();
  renderCurrent();
  if (hash === 'collection' || hash === 'shop-sandbox') document.getElementById(hash)?.scrollIntoView({ block: 'start' });
  else if (hash !== 'main') window.scrollTo({ top: 0, behavior: 'instant' });
  if (searchRequested && view === role) { const target = searchRequested; searchRequested = null; $(target).focus(); return; }
  if (hash !== 'collection' && hash !== 'main') document.querySelector(`#${role} [data-view-panel="${view}"] h1, #${role}-heading`)?.focus({ preventScroll: true });
}
$('#shop-search').addEventListener('submit', event => event.preventDefault());
for (const id of ['shop-query', 'shop-store', 'shop-sort']) $('#' + id).addEventListener('input', () => { shopPage = 0; renderShop(); });
$('#shop-previous').addEventListener('click', () => { shopPage--; renderShop(); });
$('#shop-next').addEventListener('click', () => { shopPage++; renderShop(); });
for (const role of ['vendor', 'admin']) for (const field of ['query', 'state']) $('#' + role + '-' + field).addEventListener('input', () => { tablePages[role] = 0; renderTable(role); });
for (const link of document.querySelectorAll('#create-offer, [data-create-offer]')) link.addEventListener('click', event => {
  event.preventDefault(); void loadEditor().then(app => { if (app.newDraft()) location.hash = 'vendor-editor'; }).catch(message);
});
window.addEventListener('hashchange', () => { if ($('#offer-detail').open) $('#offer-detail').close(); void route().catch(message); });
document.addEventListener('commerce:drafts-updated', () => { channel?.postMessage('changed'); void refresh().catch(message); });
if (channel) channel.onmessage = () => { void refresh().catch(message); void editor?.externalChange().catch(message); };
function connection() { $('#connection').textContent = navigator.onLine ? 'Local workspace · Online' : 'Offline · Drafts available'; }
window.addEventListener('online', connection); window.addEventListener('offline', connection); connection();
function projectPreview(project) {
  const preview = node('div', undefined, 'console-preview'); preview.setAttribute('aria-hidden', 'true');
  const frame = node('div', undefined, 'mini-storefront');
  const masthead = node('div', undefined, 'mini-masthead'); masthead.append(node('b', 'airvio'), node('span', 'LOCAL PREVIEW'));
  const hero = node('div', undefined, 'mini-hero');
  hero.append(node('span', project.name), node('strong', project.offers[0]?.launch?.outcome || 'Useful work. Thoughtfully prepared.'), node('i', 'Your collection'));
  const collection = node('div', undefined, 'mini-collection');
  for (const offer of project.offers.slice(0, 3)) {
    const tile = node('div'); tile.append(art(offer), node('small', offer.title)); collection.append(tile);
  }
  if (!project.offers.length) {
    for (const text of ['Plan', 'Prepare', 'Review']) { const tile = node('div'); tile.append(node('span', text.slice(0, 1), 'mini-placeholder'), node('small', text)); collection.append(tile); }
  }
  frame.append(masthead, hero, collection); preview.append(frame); return preview;
}
function projectLink(text, href, label) {
  const link = node('a', text, 'button secondary'); link.href = href;
  if (label) link.setAttribute('aria-label', label); return link;
}
function projectCard(project, detail = false) {
  const card = node('article', undefined, 'project-card'); card.dataset.project = project.id;
  const info = node('div', undefined, 'project-info'), content = node('div', undefined, 'project-copy');
  const title = node('h2', detail ? 'Device workspace' : project.name);
  const facts = node('dl', undefined, 'project-facts');
  const saved = project.offers.length, reviewed = project.offers.filter(offer => stateOf(offer) === 'reviewable').length;
  facts.append(node('dt', 'Draft storage'), node('dd', 'Available · This browser', 'project-available'),
    node('dt', 'Storefront'), node('dd', 'Private preview · Not published'),
    node('dt', 'Offers'), node('dd', saved + ' saved · ' + reviewed + ' ready for review'));
  const activity = node('div', undefined, 'project-activity'), latest = [...project.offers].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  activity.append(node('span', 'Latest local activity', 'muted'), node('p', latest ? latest.title : 'Create your first offer to begin.'),
    node('small', latest ? 'Saved ' + new Date(latest.updatedAt).toLocaleString() : 'No saved activity yet', 'muted'));
  content.append(title, facts, activity);
  const actions = node('div', undefined, 'project-actions');
  actions.append(projectLink(detail ? 'Open offer workspace' : 'Project details', detail ? '#vendor' : '#admin-project?project=' + encodeURIComponent(project.id)));
  actions.append(projectLink('▤', '#admin-reviews', 'Open all launch reviews'), projectLink('⇄', '#admin-data', 'Back up all drafts'));
  info.append(content, actions); card.append(projectPreview(project), info); return card;
}
function renderProjects() {
  if (!draftsLoaded) { $('#project-list').replaceChildren(node('p', 'Loading saved projects…', 'muted')); return; }
  const projects = groupProjects(drafts), query = $('#project-query').value.trim().toLowerCase();
  const filtered = projects.filter(project => [project.name, ...project.offers.map(offer => offer.title)].some(value => value.toLowerCase().includes(query)));
  $('#project-result-count').textContent = filtered.length + (filtered.length === 1 ? ' project' : ' projects');
  $('#project-list').replaceChildren(...filtered.map(project => projectCard(project)));
  if (!filtered.length) $('#project-list').append(node('div', 'No projects match. Try a merchant name or offer title.', 'empty-state'));
  if (!location.hash.startsWith('#admin-project')) return;
  const requested = new URLSearchParams(location.hash.split('?')[1] || '').get('project');
  const project = requested === null ? projects[0] : projects.find(item => item.id === requested);
  const detail = $('#project-detail'); detail.replaceChildren();
  $('#project-heading').textContent = project?.name || 'Project unavailable';
  $('#console-location').textContent = project?.name || 'Project unavailable';
  $('#project-description').textContent = project ? 'Local-first · ' + project.offers.length + ' saved offers · Private to this browser' : 'This project is not saved on this device. Return to your projects or import its backup.';
  if (!project) return;
  detail.append(node('p', 'Environments', 'console-section-label'), projectCard(project, true));
  const sandbox = node('article', undefined, 'console-sandbox');
  const summary = node('div'); summary.append(node('h2', 'Sandbox checkout'), node('p', 'Shared example offer · Test mode only · No real money', 'muted'));
  const observation = node('span', $('#environment-badge').textContent, 'state-badge'); observation.dataset.environmentObservation = '';
  const timestamp = node('small', '', 'muted'); timestamp.dataset.environmentTime = '';
  const evidence = node('div', undefined, 'sandbox-observation'); evidence.append(observation, timestamp);
  sandbox.append(summary, evidence, projectLink('Inspect environment', '#admin-runtime')); detail.append(sandbox);
  const activity = node('section', undefined, 'project-records'); activity.append(node('h2', 'Saved offers'));
  if (!project.offers.length) activity.append(node('p', 'No saved offers. Create one in the offer workspace.', 'muted'));
  else {
    const table = node('table', undefined, 'data-table'); table.setAttribute('aria-label', 'Project offers');
    const header = node('thead'), row = node('tr'), body = node('tbody');
    for (const label of ['Offer', 'Review status', 'Updated', 'Action']) { const th = node('th', label); th.scope = 'col'; row.append(th); } header.append(row);
    for (const offer of [...project.offers].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10)) {
      const row = node('tr'), action = node('td'); action.append(offerLink(offer, 'Open offer'));
      const cells = [node('td', offer.title), node('td', stateLabel(stateOf(offer))), node('td', new Date(offer.updatedAt).toLocaleDateString()), action];
      cells.forEach((cell, index) => { cell.dataset.label = ['Offer', 'Review status', 'Updated', 'Action'][index]; row.append(cell); }); body.append(row);
    }
    table.append(header, body); activity.append(table, node('p', 'Showing up to 10 most recently saved offers. Open the offer workspace for the full collection.', 'footnote'));
  }
  detail.append(activity);
}
$('#project-query').addEventListener('input', renderProjects);
async function focusWorkspaceSearch() {
  const role = document.body.dataset.workspaceRole;
  const target = ({ shop: '#shop-query', vendor: '#vendor-query', admin: '#project-query' })[role];
  if (!target) return;
  if (location.hash === '#' + role) { $(target).focus(); return; }
  searchRequested = target; location.hash = role;
}
for (const button of document.querySelectorAll('#project-search-shortcut, [data-workspace-search]')) {
  button.addEventListener('click', () => void focusWorkspaceSearch().catch(message));
}
window.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && document.body.classList.contains('console-mode')) {
    event.preventDefault(); void focusWorkspaceSearch().catch(message);
  }
});
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
  for (const label of document.querySelectorAll('[data-environment-observation]')) label.textContent = $('#environment-badge').textContent;
  for (const label of document.querySelectorAll('[data-environment-time]')) label.textContent = observation ? new Date(observation.time).toLocaleString() : 'No observation yet';
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
async function checkEnvironment(signal) {
  if (signal?.aborted) throw Error('workspace_cancelled');
  if (environmentController || !navigator.onLine) throw Error('workspace_environment_busy_or_offline');
  const generation = ++environmentGeneration, controller = new AbortController(); environmentController = controller;
  clearTimeout(environmentExpiry); environmentObservation = null;
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 5000);
  $('#environment-status').textContent = 'Checking this environment…'; renderEnvironment();
  let observation, evidence;
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
    evidence = value;
    observation = { time: Date.now(), label: value.ok ? 'Sandbox configured' : 'Unavailable',
      checkout: value.ok ? 'Configured · Test mode only' : 'Unavailable · Drafts still work', version: value.workerVersionId,
      message: value.ok ? 'Sandbox configuration observed. No real payment, offer publication or fulfillment is proved by this check.'
        : 'The sandbox is unavailable here. Continue preparing drafts; the runtime owner must resolve its configuration.' };
  } catch (error) {
    observation = { time: Date.now(), label: 'Unknown', checkout: 'Unknown · Check again',
      message: controller.signal.aborted ? 'Check cancelled or timed out. The outcome is unknown; you can explicitly check again.'
        : ['SyntaxError', 'TypeError'].includes(error.name) ? 'Could not verify the environment. Keep working locally and check again when available.' : error.message };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  if (generation !== environmentGeneration) return;
  environmentController = null; environmentObservation = observation;
  $('#environment-status').textContent = observation.message;
  environmentHistory.unshift(observation); environmentHistory.length = Math.min(20, environmentHistory.length);
  $('#environment-history').replaceChildren(...environmentHistory.map(item => node('li', new Date(item.time).toLocaleTimeString() + ' · ' + item.label + ' — ' + item.message)));
  renderEnvironment();
  if (!evidence || controller.signal.aborted) throw Error('workspace_environment_unverified');
  return evidence;
}
$('#environment-refresh').addEventListener('click', () => void checkEnvironment().catch(() => {}));
$('#environment-cancel').addEventListener('click', () => environmentController?.abort());
window.addEventListener('offline', () => { if (environmentObservation) environmentObservation.stale = true; environmentController?.abort(); renderEnvironment(); });
window.addEventListener('online', renderEnvironment);
window.addEventListener('focus', renderEnvironment);
window.addEventListener('pagehide', () => { environmentGeneration++; environmentController?.abort(); environmentController = null; clearTimeout(environmentExpiry); });
window.addEventListener('pageshow', renderEnvironment);
let toolsPromise;
function loadTools() {
  toolsPromise ??= import('./workspace-tools.js').then(module => module.mountWorkspaceTools({ checkEnvironment, sourceRevision })).catch(error => { toolsPromise = null; throw error; });
  return toolsPromise;
}
void Promise.all([refresh(), route()]).catch(message);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => { $('#offline-ready').textContent = 'Offline access is ready. You can return to this workspace without a connection.'; })
    .catch(() => { $('#offline-ready').textContent = 'Offline page loading is unavailable in this browser. Saved drafts still stay on this device.'; });
} else $('#offline-ready').textContent = 'This browser needs a connection to open the page. Your saved drafts stay on this device.';
