import { prepareViewStylesheet } from './workspace-view-styles.js'
import { assessListing, parseComparison, SAMPLE_PROFILE, serializeComparison, validateListing, validatePhotoBatch, validateProfile, validateSelection } from './housing-engine.js'
import { SAMPLE_LISTINGS } from './housing-sample.js'

const FAVOURITES_KEY = 'commerce.housing.saved-ids/v1'
const root = document.querySelector('#housing-root')
const offlineStatus = document.querySelector('#offline-ready')
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const money = (value, currency) => value === null ? 'Unknown' : new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
const localStore = () => { try { return window.localStorage } catch { return null } }
const readSaved = () => { try { const value = JSON.parse(localStore()?.getItem(FAVOURITES_KEY) || '[]'); return Array.isArray(value) ? value.filter(id => typeof id === 'string' && /^[a-z0-9-]{1,48}$/u.test(id)) : [] } catch { return [] } }
let offlineAssetWarm, offlineAssetsReady = false
const housingOfflineUrls = () => {
  const moduleUrl = new URL(import.meta.url); moduleUrl.search = ''
  return [moduleUrl.href, ...['housing-engine.js', 'housing-sample.js', 'housing-comparison.css'].map(file => new URL(file, moduleUrl).href)]
}
function setHousingOfflineStatus(state, text) {
  if (!offlineStatus) return
  offlineStatus.dataset.housingOfflineState = state; offlineStatus.textContent = text
}
function warmHousingOfflineAssets() {
  if (!('serviceWorker' in navigator)) return
  if (!navigator.serviceWorker.controller) {
    setHousingOfflineStatus('pending', navigator.onLine ? 'Preparing Housing offline files.' : 'Connect while online to prepare Housing offline files.')
    return
  }
  const urls = housingOfflineUrls()
  if (!navigator.onLine) {
    if (!('caches' in globalThis)) { setHousingOfflineStatus('missing', 'This browser cannot verify Housing offline files.'); return }
    setHousingOfflineStatus('checking', 'Checking saved Housing offline files.')
    offlineAssetWarm = Promise.all(urls.map(url => caches.match(url)))
      .then(responses => { if (responses.some(response => !response)) throw Error(); offlineAssetsReady = true; setHousingOfflineStatus('ready', 'Housing comparison is ready for offline use.') })
      .catch(() => { offlineAssetWarm = null; offlineAssetsReady = false; setHousingOfflineStatus('missing', 'Connect while online to prepare Housing offline files.') })
    return
  }
  if (offlineAssetsReady) { setHousingOfflineStatus('ready', 'Housing comparison is ready for offline use.'); return }
  if (offlineAssetWarm) return
  setHousingOfflineStatus('loading', 'Housing offline files are loading.')
  offlineAssetWarm = Promise.all(urls.map(url => fetch(url, { cache: 'reload', credentials: 'omit' })))
    .then(responses => { if (responses.some(response => !response.ok)) throw Error(); offlineAssetsReady = true; setHousingOfflineStatus('ready', 'Housing comparison is ready for offline use.') })
    .catch(() => { offlineAssetWarm = null; offlineAssetsReady = false; setHousingOfflineStatus('missing', 'Stay online until Housing offline access is ready.') })
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', warmHousingOfflineAssets, { once: true })
  warmHousingOfflineAssets()
}
const baseViewCss = new URL('./agentic-base-data-view.css?v=base-0cd7602-multi-dimensional-table-v1', import.meta.url).href
let state, live = false, saved = readSaved(), activeHash = 'housing', importTicket = 0, photoAssets = new Map(), photoIndexes = new Map(), tableAdapter, tableHandle, tableViewState, tableGeneration = 0
const freshState = () => ({ profile: null, listings: SAMPLE_LISTINGS.map(item => structuredClone(item)), selected: SAMPLE_LISTINGS.slice(0, 3).map(item => item.id), priorities: [], manualIds: new Set(), query: '', dimensionQuery: '', savedOnly: false, editingId: null, inputsOpen: false, orientation: 'columns' })
const orientationStatus = orientation => orientation === 'columns'
  ? 'Each listing is a column. Scroll horizontally to compare all options.'
  : 'Each listing is a row. Scroll horizontally to compare every fact.'
const statusLine = text => `<p class="housing-status" data-housing-global-status role="status" aria-live="polite">${escapeHtml(text)}</p>`
function currentListing(id) { return state.listings.find(item => item.id === id) }
export const prepareHousingStyles = prepareViewStylesheet(new URL('./housing-comparison.css', import.meta.url))
function loadTableAdapter() {
  tableAdapter ??= import('./agentic-base-data-view.js?v=base-0cd7602-multi-dimensional-table-v1').catch(error => { tableAdapter = null; throw error })
  return tableAdapter
}
function comparisonScroller(region = root.querySelector('.housing-comparison-table-scroll')) {
  return region?.querySelector('[data-housing-table-host]')?.shadowRoot?.querySelector('.agentic-base-data-view') || null
}
let comparisonReports = null
function disposeComparisonTable() { tableGeneration++; tableHandle?.destroy(); tableHandle = null; tableViewState = null; comparisonReports = null }
function comparisonSurface(host) {
  const shadow = host.attachShadow({ mode: 'open' }), stylesheet = document.createElement('link'), target = document.createElement('div')
  host.style.width = '100%'; host.style.height = '100%'
  stylesheet.rel = 'stylesheet'; stylesheet.href = baseViewCss; target.style.cssText = 'width:100%;height:100%'
  const ready = new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); stylesheet.onload = null; stylesheet.onerror = null; error ? reject(error) : resolve() }
    const timer = setTimeout(() => finish(Error('Shared table styles could not load.')), 8000)
    stylesheet.onload = () => finish(); stylesheet.onerror = () => finish(Error('Shared table styles could not load.'))
  })
  for (const [name, value] of Object.entries({
    '--agentic-base-text': 'var(--commerce-ink)', '--agentic-base-surface': 'var(--commerce-surface)',
    '--agentic-base-border': 'var(--commerce-border)', '--agentic-base-muted': 'var(--commerce-text-muted)',
    '--agentic-base-header': 'var(--commerce-surface-subtle)', '--agentic-base-selected': 'var(--commerce-accent-soft)',
    '--agentic-base-hover': 'var(--commerce-accent-soft)',
    '--agentic-base-focus': 'var(--commerce-focus)',
  })) host.style.setProperty(name, value)
  shadow.append(stylesheet, target)
  return { target, ready }
}
const yesNo = value => value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'Unknown'
function comparisonFields() {
  const evidence = value => value === 'unknown' ? 'Unknown' : `${yesNo(value)} · Confirmed`
  const requirement = value => value === 'unknown' ? 'Unknown' : value === 'yes' ? 'Required · Confirmed' : 'Not required · Confirmed'
  const contextValue = () => {
    if (!state.profile) return 'Not entered · add context to evaluate fit'
    const profile = state.profile
    const labels = { student: 'Student', employed: 'Employed', other: 'Other', 'no-local-history': 'No local history', 'has-local-history': 'Some local history', yes: 'Yes', no: 'No', public: 'Public transit', walk: 'Walk', bike: 'Bike', car: 'Car', quiet: 'Quiet hours', furnished: 'Furnished space', privacy: 'Private room' }
    const priorities = profile.priorities?.length ? profile.priorities.map(value => labels[value] || value).join(', ') : 'No priorities selected'
    const campus = profile.campus ? ` · campus: ${profile.campus}` : ''
    const credit = profile.credit === 'unknown' ? 'Not sure' : labels[profile.credit]
    const guarantor = profile.guarantor === 'unknown' ? 'Not sure' : labels[profile.guarantor]
    const transport = profile.transport === 'unknown' ? 'Not set' : labels[profile.transport]
    return `${profile.start} to ${profile.end} · ${labels[profile.application] || profile.application} · ${money(profile.budget, profile.currency)}/month · local credit: ${credit} · guarantor available: ${guarantor} · transport: ${transport} · priorities: ${priorities}${campus}`
  }
  return [
    { id: 'listing', name: 'Listing', value: report => report.label },
    { id: 'headline', name: 'Headline status', value: report => `${report.status}` },
    { id: 'context', name: 'Stay & application context', value: contextValue },
    { id: 'budget-fit', name: 'Known monthly vs budget', value: report => {
      if (!state.profile) return 'Enter stay context to compare'
      if (report.currency !== state.profile.currency) return `${money(state.profile.budget, state.profile.currency)} budget · currency differs`
      const position = report.knownMonthly > state.profile.budget ? 'known amount above budget' : 'known subtotal within budget'
      return `${money(report.knownMonthly, report.currency)} known / ${money(state.profile.budget, report.currency)} budget · ${position}${report.monthlyComplete ? '' : ' · additional recurring charges unknown'}`
    } },
    { id: 'rent', name: 'Advertised rent', value: report => `${money(report.rent, report.currency)} · Confirmed` },
    { id: 'monthly', name: 'Known monthly subtotal', value: report => report.monthlyComplete ? `${money(report.knownMonthly, report.currency)} · Inferred` : `${money(report.knownMonthly, report.currency)} known; recurring charges unknown` },
    { id: 'recurring', name: 'Recurring charges', value: report => report.recurring === null ? 'Unknown' : `${money(report.recurring, report.currency)} · Confirmed` },
    { id: 'move-in', name: 'Known move-in cash', value: report => report.upfrontComplete ? `${money(report.moveInKnown, report.currency)} · Inferred` : `${money(report.moveInKnown, report.currency)} known; deposit or fees incomplete` },
    { id: 'guarantor', name: 'Guarantor required', value: report => requirement(report.guarantorRequired) },
    { id: 'credit', name: 'Local credit history required', value: report => report.creditAccepted === 'yes' ? 'Not required · Confirmed' : report.creditAccepted === 'no' ? 'Required · Confirmed' : 'Unknown' },
    { id: 'lease', name: 'Lease dates / fit', value: report => { const listing = currentListing(report.id); return !state.profile ? `${listing.leaseStart || 'Start unknown'} to ${listing.leaseEnd || 'end unknown'} · enter stay dates to compare` : `${listing.leaseStart || 'Start unknown'} to ${listing.leaseEnd || 'end unknown'} · dates Confirmed · ${report.leaseMonths ?? 'Unknown'} lease months / ${report.stayMonths} planned · Inferred` } },
    { id: 'overhang', name: 'Rent after planned stay', value: report => !state.profile ? 'Enter stay dates to calculate' : report.leaseMonths === null ? 'Unknown' : report.overhangMonths ? `${report.overhangMonths} extra month(s) · about ${money(report.overhangCost, report.currency)} · Inferred` : 'No extra month found by month count · Inferred' },
    { id: 'commute', name: 'Commute estimate', value: report => report.commute === null ? 'Unknown' : `${report.commute} minutes · ${report.commuteBasis} · Inferred` },
    { id: 'furnished', name: 'Furnished', value: report => evidence(report.furnished) },
    { id: 'quiet', name: 'Quiet hours', value: report => evidence(report.quiet) },
    { id: 'private', name: 'Private room', value: report => evidence(report.privateRoom) },
    { id: 'photos', name: 'Selected local images', value: report => `${photoSummary(report.id)} · Confirmed` },
    { id: 'checked', name: 'Last checked', value: report => currentListing(report.id)?.sourceDate ? `${currentListing(report.id).sourceDate} · Confirmed` : 'Unknown' },
    { id: 'questions', name: 'Questions to resolve', value: report => [...report.mismatch, ...report.unknowns].join(' · ') || 'No explicit mismatch found; confirm source details.' },
  ]
}
function matchingComparisonFields(reports) {
  const all = comparisonFields(), query = state.dimensionQuery.trim().toLowerCase()
  const matched = query ? all.filter(field => field.name.toLowerCase().includes(query)
    || reports.some(report => String(field.value(report)).toLowerCase().includes(query))) : all
  return { all, matched }
}
function displayedComparisonFields(matched, all) {
  const listing = all.find(field => field.id === 'listing')
  return state.orientation === 'rows' && matched.length && !matched.some(field => field.id === 'listing') && listing
    ? [listing, ...matched] : matched
}
function dimensionCountText(matched, all) {
  const keepsListing = state.orientation === 'rows' && matched.length > 0 && !matched.some(field => field.id === 'listing')
  return `Showing ${matched.length} of ${all.length} dimensions.${keepsListing ? ' Listing names remain visible in this pivot.' : ''}`
}
function updateComparisonDimensions() {
  if (!comparisonReports) return
  const { all, matched } = matchingComparisonFields(comparisonReports)
  const count = root.querySelector('[data-housing-dimension-count]')
  if (count) count.textContent = dimensionCountText(matched, all)
  const clear = root.querySelector('[data-action="clear-dimension-query"]')
  if (clear) clear.hidden = !state.dimensionQuery.trim()
  const region = root.querySelector('.housing-comparison-table-scroll')
  const empty = root.querySelector('[data-housing-table-empty]')
  if (!matched.length) {
    if (region) region.hidden = true
    if (empty) { empty.hidden = false; empty.textContent = `No dimensions match “${state.dimensionQuery.trim()}”. Clear the search to view every dimension.` }
    return
  }
  if (empty) empty.hidden = true
  if (region) region.hidden = false
  if (!tableHandle || !tableViewState) return
  const fields = displayedComparisonFields(matched, all)
  tableViewState = {
    ...tableViewState,
    columns: fields.map(({ id, name }) => ({ id, name })),
    rows: comparisonReports.map((report, index) => ({ id: `${String.fromCharCode(65 + index)}. ${report.label}`, cells: fields.map(field => field.value(report)) })),
  }
  tableHandle.update(tableViewState)
  syncComparisonOrientation()
}
async function mountComparisonTable(reports, generation) {
  comparisonReports = reports
  updateComparisonDimensions()
  const host = root.querySelector('[data-housing-table-host]'), status = root.querySelector('[data-housing-table-status]')
  if (!host || !status) return
  try {
    const adapter = await loadTableAdapter()
    if (!live || generation !== tableGeneration || activeHash !== 'housing' || !host.isConnected) return
    const { target, ready } = comparisonSurface(host)
    await ready
    if (!live || generation !== tableGeneration || activeHash !== 'housing' || !host.isConnected) return
    const { all, matched } = matchingComparisonFields(reports), fields = matched.length ? displayedComparisonFields(matched, all) : all
    tableViewState = {
      columns: fields.map(({ id, name }) => ({ id, name })),
      rows: reports.map((report, index) => ({ id: `${String.fromCharCode(65 + index)}. ${report.label}`, cells: fields.map(field => field.value(report)) })),
      layout: 'multiDimensional', orientation: state.orientation, ariaLabel: 'Housing comparison across listing options',
      onOrientationChange: orientation => {
        if (!live || generation !== tableGeneration || activeHash !== 'housing' || !host.isConnected || !tableHandle) return
        state.orientation = orientation
        tableViewState = { ...tableViewState, orientation }
        updateComparisonDimensions()
        const scroller = comparisonScroller()
        if (scroller) { scroller.scrollLeft = 0; scroller.scrollTop = 0 }
      },
    }
    tableHandle = adapter.mountDataView(target, tableViewState)
    syncComparisonOrientation()
  } catch (error) {
    if (live && generation === tableGeneration && host.isConnected) status.textContent = `Comparison table unavailable: ${error.message}`
  }
}
function profilePanel() {
  const profile = state.profile || { start: '', end: '', budget: '', currency: 'SGD', application: 'student', credit: 'unknown', guarantor: 'unknown', transport: 'unknown', campus: '', priorities: state.priorities }
  const selected = new Set(profile.priorities || [])
  const summary = state.profile ? 'Set for this visit' : 'Not set'
  return `<section class="agentic-dashboard-card housing-context" aria-labelledby="housing-context-title"><header><h3 id="housing-context-title">Stay &amp; application context</h3><p class="housing-context-summary">${escapeHtml(summary)} · used for every selected listing</p></header>
    <form class="housing-form" data-form="profile"><div class="housing-field-grid">
      <label>Arrival date<input name="start" type="date" required value="${escapeHtml(profile.start)}"></label><label>Departure date<input name="end" type="date" required value="${escapeHtml(profile.end)}"></label>
      <label>Monthly budget<input name="budget" type="number" min="1" max="10000000" step="1" required value="${escapeHtml(profile.budget)}"></label><label>Currency<select name="currency">${['SGD', 'USD', 'MYR'].map(code => `<option${profile.currency === code ? ' selected' : ''}>${code}</option>`).join('')}</select></label>
      <label>Application context<select name="application"><option value="student"${profile.application === 'student' ? ' selected' : ''}>Student</option><option value="employed"${profile.application === 'employed' ? ' selected' : ''}>Employed</option><option value="other"${profile.application === 'other' ? ' selected' : ''}>Other</option></select></label>
      <label>Local credit history<select name="credit"><option value="no-local-history"${profile.credit === 'no-local-history' ? ' selected' : ''}>No local history</option><option value="has-local-history"${profile.credit === 'has-local-history' ? ' selected' : ''}>Some local history</option><option value="unknown"${profile.credit === 'unknown' ? ' selected' : ''}>Not sure</option></select></label>
      <label>Guarantor available?<select name="guarantor"><option value="unknown"${profile.guarantor === 'unknown' ? ' selected' : ''}>Not sure</option><option value="yes"${profile.guarantor === 'yes' ? ' selected' : ''}>Yes</option><option value="no"${profile.guarantor === 'no' ? ' selected' : ''}>No</option></select></label>
      <label>Typical transport<select name="transport">${[['unknown','Not set'],['public','Public transit'],['walk','Walk'],['bike','Bike'],['car','Car']].map(([value,label]) => `<option value="${value}"${profile.transport === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="housing-field-wide">Optional campus label<input name="campus" maxlength="60" value="${escapeHtml(profile.campus)}" placeholder="Example: North campus"><small>Do not enter a street address.</small></label>
      <fieldset class="agentic-checkbox-group housing-field-wide"><legend>Priorities</legend>${[['quiet','Quiet hours'],['furnished','Furnished space'],['privacy','Private room']].map(([value,label]) => `<label><input type="checkbox" name="priority" value="${value}"${selected.has(value) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</fieldset>
    </div><div class="housing-actions"><button type="submit">Apply context</button><button type="button" class="secondary" data-action="sample-profile">Use sample profile</button>${state.profile ? '<button type="button" class="secondary" data-action="clear-context">Clear context</button>' : ''}</div><p>Context stays in memory for this visit. No name, exact address, or document is collected.</p></form>
  </section>`
}
function listingChoice(listing) {
  const checked = state.selected.includes(listing.id), favourite = saved.includes(listing.id), manual = state.manualIds.has(listing.id)
  return `<article class="housing-option" data-listing-item data-id="${escapeHtml(listing.id)}"><label class="housing-option-select"><input type="checkbox" name="listing" value="${escapeHtml(listing.id)}"${checked ? ' checked' : ''}><span><strong>${escapeHtml(listing.label)}</strong><small>${manual ? 'Entered here' : 'Fictional sample'}</small></span></label><div class="housing-option-actions"><button type="button" class="secondary housing-save" data-action="favorite" data-id="${escapeHtml(listing.id)}" aria-pressed="${favourite}" aria-label="${favourite ? 'Remove saved listing' : 'Save listing'}: ${escapeHtml(listing.label)}">${favourite ? 'Saved ID' : 'Save ID'}</button>${manual ? `<button type="button" class="secondary" data-action="edit-listing" data-id="${escapeHtml(listing.id)}">Edit facts</button><button type="button" class="secondary" data-action="remove-listing" data-id="${escapeHtml(listing.id)}">Remove</button>` : ''}</div></article>`
}
const unknownYesNo = [['unknown','Unknown'],['yes','Yes'],['no','No']]
const listingFields = [
  ['Local label','label','type="text" maxlength="60" required placeholder="Listing note"'], ['Currency','currency',[['SGD','SGD'],['USD','USD'],['MYR','MYR']]],
  ['Monthly rent','rent','type="number" min="1" max="10000000" step="1" required'], ['Other recurring charges','recurring','type="number" min="0" max="10000000" step="1" placeholder="Unknown if blank"'],
  ['Deposit','deposit','type="number" min="0" max="10000000" step="1" placeholder="Unknown"'], ['Other upfront fees','upfrontFee','type="number" min="0" max="10000000" step="1" placeholder="Unknown"'],
  ['Lease begins','leaseStart','type="date"'], ['Lease ends','leaseEnd','type="date"'], ['Commute minutes','commute','type="number" min="0" max="1440" step="1" placeholder="Unknown"'],
  ['Commute basis','commuteBasis','maxlength="120" placeholder="Check basis"'], ['Guarantor required?','guarantorRequired',unknownYesNo],
  ['Local credit-history requirement','creditAccepted',[['unknown','Unknown'],['yes','Not required'],['no','Required']]], ['Furnished?','furnished',unknownYesNo],
  ['Quiet-hours fit','quiet',[['unknown','Unknown'],['yes','Stated yes'],['no','Stated no']]], ['Private room?','privateRoom',unknownYesNo], ['Facts last checked','sourceDate','type="date"'],
]
function listingForm() {
  const editing = currentListing(state.editingId)
  const fields = listingFields.map(([label, name, control]) => {
    const value = editing?.[name] ?? ''
    const input = Array.isArray(control)
      ? `<select name="${name}">${control.map(([option, text]) => `<option value="${option}"${value === option ? ' selected' : ''}>${text}</option>`).join('')}</select>`
      : `<input name="${name}" ${control} value="${escapeHtml(value)}">`
    return `<label>${label}${input}</label>`
  }).join('')
  const photos = editing ? '<p>Existing local photos stay attached when you update facts.</p>' : '<label class="housing-field-wide">Optional local images<input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><small>5 images, 5 MiB per comparison.</small></label>'
  return `<details class="housing-listing-editor"${editing ? ' open' : ''}><summary>${editing ? 'Edit listing facts' : 'Add a listing manually'}</summary><form class="housing-form" data-form="listing"><div class="housing-field-grid">${fields}</div>${photos}<div class="housing-actions"><button type="submit">${editing ? 'Update listing facts' : 'Add this listing'}</button>${editing ? '<button type="button" class="secondary" data-action="cancel-edit">Cancel</button>' : ''}</div></form></details>`
}
function portableTools(canExport) {
  return `<details class="housing-portable-tools"><summary>Import or export comparison data</summary><p>Exports listing facts only. Re-enter stay details after import.</p><div class="housing-actions"><button type="button" data-action="export"${canExport ? '' : ' disabled'}>Export JSON</button><label class="housing-file-button button secondary">Import JSON<input type="file" data-action="import" accept="application/json,.json"></label></div></details>`
}
function listingPanel() {
  const selected = state.selected.filter(id => state.listings.some(item => item.id === id))
  return `<section class="agentic-dashboard-card housing-listings-panel" aria-labelledby="housing-listings-title"><header><h3 id="housing-listings-title">Local listings</h3><p>Choose up to three options. Selection order matches the table.</p></header><div class="housing-listing-filter"><label>Find an option<input type="search" name="listing-query" value="${escapeHtml(state.query)}" placeholder="Search local labels"></label><label class="housing-filter-toggle"><input type="checkbox" name="saved-only"${state.savedOnly ? ' checked' : ''}>Saved only</label><p data-listing-count aria-live="polite"></p></div><div class="housing-listing-grid">${state.listings.map(listingChoice).join('')}</div><p>Selected ${selected.length} of 3 listings.</p>${listingForm()}${portableTools(selected.length > 0)}</section>`
}
function filterChoices() {
  const query = state.query.trim().toLowerCase()
  let shown = 0
  for (const card of root.querySelectorAll('[data-listing-item]')) {
    const item = currentListing(card.dataset.id)
    const text = [item.label, item.id, item.currency, item.commuteBasis, item.sourceDate].join(' ').toLowerCase()
    card.hidden = (!!query && !text.includes(query)) || (state.savedOnly && !saved.includes(item.id))
    if (!card.hidden) shown++
  }
  const count = root.querySelector('[data-listing-count]')
  if (count) count.textContent = `Showing ${shown} of ${state.listings.length} local listings.`
}
function photoSummary(id) {
  const photos = photoAssets.get(id) || []
  const repeated = photos.some(photo => [...photoAssets].some(([otherId, other]) => otherId !== id && state.selected.includes(otherId) && other.some(item => item.hash === photo.hash)))
  return `${photos.length} selected${repeated ? ' · exact file also selected for another option' : ''}`
}
function photoGallery(id) {
  const photos = photoAssets.get(id) || [], label = escapeHtml(currentListing(id)?.label)
  if (!photos.length) return ''
  return `<button type="button" class="secondary" data-action="photo-open" data-id="${id}">View ${photos.length} local photo${photos.length === 1 ? '' : 's'}</button><dialog class="housing-photo-dialog" data-photo-dialog="${id}" aria-label="Photos for ${label}"><canvas width="720" height="480" data-photo="${id}" role="img"></canvas><p data-photo-count="${id}" aria-live="polite"></p><div class="housing-actions"><button type="button" class="secondary" data-action="photo-close">Close photos</button><button type="button" class="secondary" data-action="photo-prev" data-id="${id}">Previous</button><button type="button" class="secondary" data-action="photo-next" data-id="${id}">Next</button></div></dialog>`
}
function paintPhotos() {
  for (const canvas of root.querySelectorAll('canvas[data-photo]')) {
    const id = canvas.dataset.photo, photos = photoAssets.get(id) || [], index = photoIndexes.get(id) || 0, photo = photos[index]
    if (!photo) continue
    canvas.setAttribute('aria-label', `Photo ${index + 1} of ${photos.length} for ${currentListing(id)?.label}`)
    const context = canvas.getContext('2d'), scale = Math.min(canvas.width / photo.bitmap.width, canvas.height / photo.bitmap.height)
    const width = photo.bitmap.width * scale, height = photo.bitmap.height * scale
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(photo.bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
  }
  for (const counter of root.querySelectorAll('[data-photo-count]')) { const id = counter.closest('dialog').dataset.photoDialog, count = photoAssets.get(id)?.length || 0; counter.textContent = `Photo ${(photoIndexes.get(id) || 0) + 1} of ${count}` }
}
function stepPhoto(id, amount) {
  const count = photoAssets.get(id)?.length || 0
  if (count) photoIndexes.set(id, ((photoIndexes.get(id) || 0) + amount + count) % count)
  paintPhotos()
}
function reportFor(listing) {
  if (state.profile) return assessListing(state.profile, listing)
  const monthlyComplete = listing.recurring !== null, upfrontComplete = listing.deposit !== null && listing.upfrontFee !== null
  return { id: listing.id, label: listing.label, currency: listing.currency, rent: listing.rent, recurring: listing.recurring,
    knownMonthly: listing.rent + (listing.recurring ?? 0), monthlyComplete, deposit: listing.deposit, upfrontFee: listing.upfrontFee,
    moveInKnown: listing.rent + (listing.deposit ?? 0) + (listing.upfrontFee ?? 0), upfrontComplete, leaseMonths: null,
    stayMonths: null, overhangMonths: null, overhangCost: null, commute: listing.commute,
    commuteBasis: listing.commute === null ? 'Unknown' : listing.commuteBasis || 'Basis not stated', furnished: listing.furnished,
    quiet: listing.quiet, privateRoom: listing.privateRoom, guarantorRequired: listing.guarantorRequired,
    creditAccepted: listing.creditAccepted, status: 'Add stay context to evaluate fit', mismatch: [],
    unknowns: ['Stay and application context is not set.'] }
}
function planDialog(report) {
  if (!state.profile) return ''
  const listing = currentListing(report.id), id = escapeHtml(report.id)
  const questions = [
    report.recurring === null ? 'Which recurring charges are additional to advertised rent, and how are they billed?' : 'Can you confirm which utilities and recurring services are included?',
    report.deposit === null ? 'What deposit is due, and when is it refundable under the written terms?' : 'Can you confirm the deposit amount and written refund terms?',
    report.leaseMonths === null ? 'What are the exact written lease start and end dates?' : 'Can the written lease dates match the planned study period?',
  ]
  const draft = `Hello, I am comparing housing for a study period from ${state.profile.start} to ${state.profile.end}. Could you confirm the recurring charges, move-in amount, and written lease dates for ${listing.label}? Thank you.`
  const status = report.mismatch.length ? report.mismatch.join(' ') : report.unknowns.length ? report.unknowns.join(' ') : 'No explicit mismatch found from the entered details. Confirm with the source.'
  return `<dialog class="housing-plan-dialog" data-plan-dialog="${id}" aria-labelledby="housing-plan-title-${id}"><article class="housing-plan-content"><header><div><p class="eyebrow">Listing workflow · local draft</p><h2 id="housing-plan-title-${id}">${escapeHtml(listing.label)}</h2><p>${escapeHtml(report.status)} ${escapeHtml(status)}</p></div><button type="button" class="secondary" data-action="plan-close">Close</button></header><section><h3>Next steps</h3><ol><li>Confirm the source date and that the listing is still available.</li><li>Ask for written lease dates and a complete fee schedule.</li><li>Compare confirmed terms with your budget and stay dates.</li></ol><h3>Questions to ask</h3><ul>${questions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p>Do not upload identity or financial documents here.</p></section><section class="housing-form"><label for="housing-message-${id}">Editable message draft</label><textarea id="housing-message-${id}" data-plan-message="${id}" rows="6" maxlength="1200">${escapeHtml(draft)}</textarea><div class="housing-actions"><button type="button" data-action="copy-message" data-id="${id}">Copy message</button></div></section><p class="housing-status" data-plan-status role="status" aria-live="polite">This is a preparation aid, not a suitability or approval decision. Nothing is sent.</p></article></dialog>`
}
function listingActions(reports) {
  if (!reports.length) return ''
  return `<section class="housing-table-actions" aria-label="Actions for selected listings"><h3>Selected-listing actions</h3><p>Actions follow the selected listings shown in the table.</p><div class="housing-option-action-list">${reports.map(report => `<div class="housing-option-action"><strong>${escapeHtml(report.label)}</strong><div class="housing-actions">${photoGallery(report.id)}${state.profile ? `<button type="button" class="secondary" data-action="plan-open" data-id="${escapeHtml(report.id)}">Open plan</button>` : '<button type="button" class="secondary" data-action="show-inputs">Set stay context</button>'}</div></div>`).join('')}</div></section>`
}
function comparisonPanel(reports) {
  const selectedCount = reports.length
  const regionLabel = state.orientation === 'columns'
    ? 'Listing comparison; listings are columns and shared facts are rows.'
    : 'Listing comparison; listings are rows and shared facts are columns.'
  const dimensionControls = reports.length ? (() => {
    const { all, matched } = matchingComparisonFields(reports), query = state.dimensionQuery.trim()
    return `<div class="housing-table-toolbar"><label>Search table dimensions<input type="search" name="dimension-query" value="${escapeHtml(state.dimensionQuery)}" placeholder="Try rent, lease, or Unknown"></label><button type="button" class="secondary" data-action="clear-dimension-query" aria-label="Clear table dimension search"${query ? '' : ' hidden'}>Clear</button><p data-housing-dimension-count role="status" aria-live="polite">${dimensionCountText(matched, all)}</p></div><p class="housing-status" data-housing-table-empty role="status" aria-live="polite" hidden></p>`
  })() : ''
  const table = reports.length
    ? `<div class="housing-comparison-table-scroll" data-orientation="${state.orientation}" tabindex="0" role="region" aria-label="${regionLabel}"><div class="housing-comparison-table-host" data-housing-table-host></div></div><p class="housing-status" data-housing-table-status role="status" aria-live="polite">Loading the shared comparison table…</p>`
    : `<div class="housing-table-empty" role="status">Choose up to three options to add listings to the table.<button type="button" class="secondary" data-action="show-inputs">Choose listings</button></div>`
  return `<section class="agentic-dashboard-region" aria-labelledby="housing-table-title"><header class="agentic-dashboard-header"><p class="agentic-dashboard-observation">HOUSING · LOCAL WORKSPACE</p><h1 data-dashboard-primitive="heading" id="housing-table-title" tabindex="-1">Multi-dimensional Table</h1><p data-dashboard-primitive="text">Stay context and listing facts share one matrix. Pivot to place each listing in rows or columns; shared facts stay the same. Samples are fictional and unverified.</p></header><details data-dashboard-primitive="disclosure" data-housing-workflow${state.inputsOpen ? ' open' : ''}><summary>Workflow inputs &amp; listing actions <span>${selectedCount} of 3 listings selected</span></summary><div data-dashboard-primitive="container" data-columns="2" data-dashboard-columns-for="housing">${profilePanel()}${listingPanel()}</div>${listingActions(reports)}</details>${dimensionControls}${table}${reports.map(planDialog).join('')}<p>No listing is contacted, submitted, or saved remotely.</p>${statusLine('Local only · no listing search or contact.')}</section>`
}
function syncComparisonOrientation() {
  const orientation = state.orientation
  const region = root.querySelector('.housing-comparison-table-scroll')
  const status = root.querySelector('[data-housing-table-status]')
  if (region) {
    region.dataset.orientation = orientation
    region.setAttribute('aria-label', orientation === 'columns'
      ? 'Listing comparison; listings are columns and shared facts are rows.'
      : 'Listing comparison; listings are rows and shared facts are columns.')
  }
  if (status && tableHandle) status.textContent = orientationStatus(orientation)
}
function housingWorkspace() {
  const existingInputs = root.querySelector('[data-housing-workflow]')
  if (existingInputs) state.inputsOpen = existingInputs.open
  const reports = state.selected.map(currentListing).filter(Boolean).map(reportFor)
  root.innerHTML = comparisonPanel(reports)
  filterChoices()
  if (reports.length) mountComparisonTable(reports, tableGeneration)
}
function render() {
  if (activeHash !== 'housing') importTicket++
  disposeComparisonTable()
  activeHash = 'housing'
  housingWorkspace()
  paintPhotos()
}
function formValues(form) { return Object.fromEntries(new FormData(form).entries()) }
function valueOrNull(value) { return value === '' || value === undefined ? null : Number(value) }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 35) || 'local-listing' }
async function digestFiles(files) {
  validatePhotoBatch([...photoAssets.values()].flat(), files)
  const photos = []
  try {
    for (const file of files) {
      const bitmap = await createImageBitmap(file)
      if (bitmap.width * bitmap.height + photos.reduce((sum, photo) => sum + photo.bitmap.width * photo.bitmap.height, 0) > 12000000) { bitmap.close(); throw Error('Images exceed the 12 MP preview limit.') }
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      photos.push({ hash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), bitmap, size: file.size })
    }
    return photos
  } catch (error) { photos.forEach(photo => photo.bitmap.close()); throw error }
}
function persistSaved() {
  try { const storage = localStore(); if (!storage) return false; storage.setItem(FAVOURITES_KEY, JSON.stringify(saved)); return true } catch { return false }
}
function favorite(id) {
  saved = saved.includes(id) ? saved.filter(value => value !== id) : [...saved, id]
  const persisted = persistSaved()
  render(activeHash)
  if (!persisted) showError({ message: 'Saved ID is available only for this visit because browser storage is blocked.' })
}
function removeListing(id) {
  if (!state.manualIds.has(id)) return
  state.listings = state.listings.filter(item => item.id !== id)
  state.manualIds.delete(id); state.selected = state.selected.filter(value => value !== id)
  const wasSaved = saved.includes(id)
  if (wasSaved) saved = saved.filter(value => value !== id)
  const savedWritten = !wasSaved || persistSaved()
  photoAssets.get(id)?.forEach(photo => photo.bitmap.close()); photoAssets.delete(id); photoIndexes.delete(id)
  if (state.editingId === id) state.editingId = null
  render('housing')
  showError({ message: savedWritten ? 'Manual listing removed from this visit.' : 'Listing removed, but blocked browser storage may retain its saved ID.' })
}
function showError(error) { const line = root.querySelector('[data-housing-global-status]') || root.querySelector('.housing-status'); if (line) line.textContent = error.message || 'Could not update this comparison.' }
function clearPhotos() { for (const photos of photoAssets.values()) photos.forEach(photo => photo.bitmap.close()); photoAssets.clear(); photoIndexes.clear() }
function exportComparison() {
  const url = URL.createObjectURL(new Blob([serializeComparison(state.listings, state.selected)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'housing-comparison.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  showError({ message: 'Comparison exported. Re-enter stay details on the other device.' })
}
async function importComparison(input) {
  const file = input.files?.[0], ticket = ++importTicket, route = activeHash, session = state, selection = state?.selected
  input.value = ''
  if (!file) return
  try {
    if (file.size > 65536) throw Error('Choose a comparison JSON file under 64 KiB.')
    const listings = parseComparison(await file.text())
    if (!live || ticket !== importTicket || route !== activeHash || session !== state || selection !== state?.selected) return
    clearPhotos(); state.listings = listings; state.manualIds = new Set(listings.map(item => item.id)); state.selected = listings.map(item => item.id)
    state.profile = null; state.priorities = []; state.editingId = null; state.query = ''; state.dimensionQuery = ''; state.savedOnly = false
    const message = `Imported ${listings.length} listings. Enter stay details to compare.`
    render('housing')
    showError({ message })
  } catch (error) { if (live && ticket === importTicket && session === state) showError(error) }
}

export function mountHousingWorkspace(target = root) {
  if (!(target instanceof HTMLElement)) throw Error('housing_workspace_root_missing')
  if (live) { activate('housing'); return { activate, deactivate } }
  live = true; state = freshState(); photoAssets = new Map(); photoIndexes = new Map();
  target.addEventListener('submit', onSubmit); target.addEventListener('click', onClick); target.addEventListener('change', onChange); target.addEventListener('input', onInput); target.addEventListener('keydown', onKeyDown)
  function onSubmit(event) {
    const form = event.target.closest('form[data-form]'); if (!form) return
    event.preventDefault(); const values = formValues(form)
    try {
      if (form.dataset.form === 'profile') { state.priorities = [...form.querySelectorAll('[name="priority"]:checked')].map(item => item.value); state.profile = validateProfile({ ...values, budget: Number(values.budget), priorities: state.priorities }); render('housing'); showError({ message: 'Stay and application context updated.' }) }
      if (form.dataset.form === 'listing') void (async () => {
        const editing = currentListing(state.editingId), label = values.label.trim()
        let id = editing?.id
        if (!editing) do { id = `${slug(label)}-${crypto.randomUUID().slice(0, 8)}` } while (state.listings.some(item => item.id === id))
        const listing = validateListing({ id, label, currency: values.currency, rent: Number(values.rent), recurring: valueOrNull(values.recurring),
          deposit: valueOrNull(values.deposit), upfrontFee: valueOrNull(values.upfrontFee), leaseStart: values.leaseStart, leaseEnd: values.leaseEnd,
          commute: valueOrNull(values.commute), commuteBasis: values.commuteBasis || '', guarantorRequired: values.guarantorRequired, creditAccepted: values.creditAccepted,
          furnished: values.furnished, quiet: values.quiet, privateRoom: values.privateRoom, sourceDate: values.sourceDate })
        const photoInput = form.querySelector('[name="photos"]'), photos = !editing && photoInput?.files?.length ? await digestFiles([...photoInput.files]) : []
        if (!live) { photos.forEach(photo => photo.bitmap.close()); return }
        if (editing) { const index = state.listings.findIndex(item => item.id === id); if (index < 0) throw Error('The listing was removed before its update.'); state.listings[index] = listing; state.editingId = null }
        else { state.listings.push(listing); state.manualIds.add(id); if (state.selected.length < 3) state.selected.push(id); photoAssets.set(id, photos) }
        const duplicate = photos.some(photo => [...photoAssets].some(([otherId, other]) => otherId !== id && state.selected.includes(otherId) && other.some(item => item.hash === photo.hash)))
        render('housing')
        const line = root.querySelector('[data-housing-global-status]') || root.querySelector('.housing-status')
        line.textContent = editing ? 'Listing facts updated. Existing local photos remain attached.' : duplicate ? 'Listing added. An exact image file is also selected for another option.' : photos.length ? `Listing added. ${photos.length} local photo preview${photos.length === 1 ? '' : 's'} ready.` : 'Listing added to this tab.'
      })().catch(showError)
    } catch (error) { showError(error) }
  }
  function onClick(event) {
    const button = event.target.closest('[data-action]'); if (!button) return
    const action = button.dataset.action
    if (action === 'clear-dimension-query') { state.dimensionQuery = ''; const input = root.querySelector('[name="dimension-query"]'); if (input) { input.value = ''; input.focus() }; updateComparisonDimensions(); return }
    if (action === 'photo-open') { root.querySelector(`dialog[data-photo-dialog="${button.dataset.id}"]`).showModal(); return }
    if (action === 'photo-close') { button.closest('dialog').close(); return }
    if (action === 'plan-open') { root.querySelector(`dialog[data-plan-dialog="${button.dataset.id}"]`)?.showModal(); return }
    if (action === 'plan-close') { button.closest('dialog').close(); return }
    if (action === 'show-inputs') { const inputs = root.querySelector('[data-housing-workflow]'); if (inputs) { inputs.open = true; state.inputsOpen = true; inputs.scrollIntoView({ block: 'start' }) }; return }
    if (action === 'photo-next' || action === 'photo-prev') { stepPhoto(button.dataset.id, action === 'photo-next' ? 1 : -1); return }
    if (action === 'export') { try { exportComparison() } catch (error) { showError(error) }; return }
    if (action === 'edit-listing') { state.editingId = button.dataset.id; render('housing'); root.querySelector('[data-form="listing"]')?.scrollIntoView({ block: 'center' }); root.querySelector('[name="label"]')?.focus({ preventScroll: true }); return }
    if (action === 'cancel-edit') { state.editingId = null; render('housing'); return }
    if (action === 'remove-listing') { removeListing(button.dataset.id); return }
    if (action === 'sample-profile') { state.profile = structuredClone(SAMPLE_PROFILE); state.priorities = [...SAMPLE_PROFILE.priorities]; render('housing') }
    if (action === 'clear-context') { state.profile = null; state.priorities = []; render('housing') }
    if (action === 'favorite') favorite(button.dataset.id)
    if (action === 'copy-message') { const area = root.querySelector(`[data-plan-message="${button.dataset.id}"]`); if (!area || !navigator.clipboard?.writeText) { showError({ message: 'Clipboard unavailable. Select and copy the message manually.' }); return } const status = button.closest('dialog')?.querySelector('[data-plan-status]'); void navigator.clipboard.writeText(area.value).then(() => { if (status) status.textContent = 'Message copied after your request. Nothing was sent.' }).catch(() => { if (status) status.textContent = 'Clipboard unavailable. Select and copy the message manually.' }) }
  }
  function onInput(event) {
    if (event.target.matches('[name="dimension-query"]')) { state.dimensionQuery = event.target.value; updateComparisonDimensions(); return }
    if (event.target.matches('[name="listing-query"]')) { state.query = event.target.value; filterChoices() }
  }
  function onKeyDown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const region = event.target instanceof Element ? event.target.closest('.housing-comparison-table-scroll') : null
    const scroller = region ? comparisonScroller(region) : null
    const max = scroller ? scroller.scrollWidth - scroller.clientWidth : 0
    if (!scroller || max <= 0) return
    event.preventDefault()
    scroller.scrollLeft = Math.max(0, Math.min(max, scroller.scrollLeft + (event.key === 'ArrowRight' ? 40 : -40)))
  }
  function onChange(event) {
    if (event.target.matches('[data-action="import"]')) { void importComparison(event.target); return }
    if (event.target.matches('[name="saved-only"]')) { state.savedOnly = event.target.checked; filterChoices(); return }
    if (event.target.matches('[name="listing"]')) {
      const id = event.target.value
      if (event.target.checked && state.selected.length >= 3) { event.target.checked = false; showError({ message: 'Compare up to three listings at a time.' }); return }
      state.selected = event.target.checked ? [...state.selected, id] : state.selected.filter(value => value !== id)
      render('housing')
    }
  }
  function activate() { if (!live) return; warmHousingOfflineAssets(); state ??= freshState(); render() }
  function deactivate() { if (!live) return; live = false; importTicket++; disposeComparisonTable(); target.removeEventListener('submit', onSubmit); target.removeEventListener('click', onClick); target.removeEventListener('change', onChange); target.removeEventListener('input', onInput); target.removeEventListener('keydown', onKeyDown); target.replaceChildren(); clearPhotos(); state = null; if (offlineStatus) { delete offlineStatus.dataset.housingOfflineState; offlineStatus.textContent = 'Offline access is ready. Core workspace is cached; open Housing to prepare its offline files.' } }
  activate('housing')
  return { activate, deactivate }
}

export function activate() { warmHousingOfflineAssets(); if (!live) mountHousingWorkspace(); render() }
export function deactivate() { /* The shell owns the mounted controller lifecycle. */ }
