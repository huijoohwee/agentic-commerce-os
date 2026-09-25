let catalogPage = 1;
let catalogViewSource = null;
const shortlistKey = 'agentic-commerce-shortlist:v1:' + catalogPath;
const shortlistRegion = document.querySelector('#catalog-shortlist');
const savedOnlyButton = document.querySelector('#catalog-saved-only');
const readSaved = () => {
  try {
    const value = JSON.parse(localStorage.getItem(shortlistKey) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.length <= 256))].slice(0, 40) : [];
  } catch { return []; }
};
let savedListingIds = readSaved();
let comparedListingIds = [];
let savedOnly = false;
let shortlistNotice = '';
const toggleSaved = listing => {
  const next = savedListingIds.includes(listing.listingId)
    ? savedListingIds.filter(id => id !== listing.listingId)
    : [...savedListingIds, listing.listingId].slice(-40);
  try { localStorage.setItem(shortlistKey, JSON.stringify(next)); savedListingIds = next; shortlistNotice = ''; }
  catch { shortlistNotice = 'Device storage is unavailable. This listing was not saved.'; }
  renderCatalog(catalog);
  [...document.querySelectorAll('[data-save-listing]')].find(button => button.dataset.saveListing === listing.listingId)?.focus();
};
const toggleCompared = listing => {
  comparedListingIds = comparedListingIds.includes(listing.listingId)
    ? comparedListingIds.filter(id => id !== listing.listingId)
    : [...comparedListingIds, listing.listingId].slice(0, 3);
  renderCatalog(catalog);
  [...document.querySelectorAll('[data-compare-listing]')].find(button => button.dataset.compareListing === listing.listingId)?.focus();
};
const renderShortlist = () => {
  const loaded = new Map(catalog.map(listing => [listing.listingId, listing]));
  const saved = savedListingIds.filter(id => loaded.has(id));
  const compared = comparedListingIds.map(id => loaded.get(id)).filter(Boolean);
  shortlistRegion.replaceChildren();
  const head = node('div', undefined, 'shortlist-head');
  head.append(node('h3', 'Your shortlist'), node('span', saved.length + ' saved here · ' + compared.length + '/3 to compare', 'hint'));
  shortlistRegion.append(head);
  if (shortlistNotice) shortlistRegion.append(node('p', shortlistNotice, 'hint'));
  if (!compared.length) { shortlistRegion.append(node('p', 'Compare up to three current listings. Your saved IDs stay on this device.', 'hint')); return; }
  const list = node('ul', undefined, 'shortlist-list');
  for (const listing of compared) {
    const item = node('li');
    item.append(node('strong', listing.title), node('small', listing.category + ' · ' + listing.agentId),
      node('small', listing.summary || 'No summary provided'));
    const currencies = [...new Set(listing.offers.map(offer => offer.currency))];
    item.append(node('small', listing.offers.length && currencies.length === 1
      ? 'From ' + formatMinorCurrency(listing.offers.reduce((lowest, offer) => Math.min(lowest, offer.amountMinor), Infinity), currencies[0]) + ' · review current offer'
      : 'Current price unavailable or in multiple currencies'));
    const remove = node('button', 'Remove from comparison', 'secondary'); remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + listing.title + ' from comparison');
    remove.addEventListener('click', () => toggleCompared(listing)); item.append(remove); list.append(item);
  }
  shortlistRegion.append(list);
};
const categoryFilter = document.querySelector('#catalog-category');
const availabilityFilter = document.querySelector('#catalog-availability');
const sortFilter = document.querySelector('#catalog-sort');
const catalogDetail = document.querySelector('#listing-detail');
const catalogError = error => {
  resultsRegion.removeAttribute('aria-busy');
  if (error?.message === 'catalog_search_superseded') return;
  if (!navigator.onLine) return;
  document.querySelector('#catalog-count').textContent = 'Unable to refresh listings';
  const empty = node('div', undefined, 'empty-state');
  empty.append(node('h3', 'We couldn’t load the catalog'), node('p', 'Check your connection and search again. Your last completed catalog stays on this device.', 'hint'));
  renderShortlist();
  resultsRegion.replaceChildren(empty);
};
const selectListingOffer = async (listing, offer) => {
  try {
    const result = await actions.selectOffer({ listingId: listing.listingId, offerId: offer.offerId });
    if (!result.ok) throw new Error(result.code);
    checkoutButton.textContent = 'Review checkout';
    if (catalogDetail.open) catalogDetail.close();
    checkoutButton.focus();
  } catch (error) { document.querySelector('#offer-selection').textContent = 'Selection unavailable. ' + error.message; }
};
const offerButton = (listing, offer) => {
  const button = node('button', formatMinorCurrency(offer.amountMinor, offer.currency) + ' · Select');
  button.type = 'button'; button.dataset.offer = offer.offerId; button.dataset.listing = listing.listingId;
  button.setAttribute('aria-pressed', String(selectedOffer?.offerId === offer.offerId && selectedListingId === listing.listingId));
  button.setAttribute('aria-label', 'Select offer ' + offer.offerId + ' from ' + listing.title + ' · ' + button.textContent);
  button.disabled = checkoutPreparing;
  button.addEventListener('click', () => void selectListingOffer(listing, offer));
  return button;
};
const showListing = listing => {
  const body = document.querySelector('#listing-detail-body');
  document.querySelector('#listing-detail-heading').textContent = listing.title;
  body.replaceChildren(node('p', listing.summary || 'Explore available offers from this provider.', 'hint'));
  describe(body, [['Category', listing.category], ['Provider', listing.agentId], ['Listing', listing.listingId]]);
  const choices = node('div', undefined, 'stack');
  choices.append(node('h3', 'Choose an offer'));
  if (listing.offers.length) for (const offer of listing.offers) choices.append(offerButton(listing, offer));
  else {
    choices.append(node('p', 'No verified offer is loaded. Search this provider to request current availability and a price.', 'hint'));
    const discover = node('button', 'Find offers'); discover.type = 'button'; discover.disabled = !navigator.onLine || checkoutPreparing;
    discover.addEventListener('click', async () => {
      catalogDetail.close(); searchInput.value = listing.title;
      await runCatalogSearch();
    });
    choices.append(discover);
  }
  body.append(choices); catalogDetail.showModal();
};
const renderCatalog = listings => {
  if (catalogViewSource !== listings) {
    catalogViewSource = listings; catalogPage = 1;
    comparedListingIds = comparedListingIds.filter(id => listings.some(listing => listing.listingId === id));
    const prior = categoryFilter.value;
    categoryFilter.replaceChildren(new Option('All categories', ''));
    for (const category of [...new Set(listings.map(listing => listing.category))].sort()) categoryFilter.add(new Option(category, category));
    categoryFilter.value = [...categoryFilter.options].some(option => option.value === prior) ? prior : '';
  }
  let filtered = listings.filter(listing => (!categoryFilter.value || listing.category === categoryFilter.value)
    && (!availabilityFilter.value || listing.offers.length)
    && (!savedOnly || savedListingIds.includes(listing.listingId)));
  if (sortFilter.value === 'title') filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 12));
  catalogPage = Math.min(totalPages, Math.max(1, catalogPage));
  document.querySelector('#catalog-count').textContent = filtered.length + (filtered.length === 1 ? ' listing' : ' listings') + (navigator.onLine ? '' : ' · saved on this device');
  document.querySelector('#catalog-page').textContent = 'Page ' + catalogPage + ' of ' + totalPages;
  document.querySelector('#catalog-previous').disabled = catalogPage <= 1;
  document.querySelector('#catalog-next').disabled = catalogPage >= totalPages;
  resultsRegion.setAttribute('aria-busy', 'false');
  resultsRegion.replaceChildren();
  renderShortlist();
  if (!filtered.length) {
    const empty = node('div', undefined, 'empty-state');
    empty.append(node('h3', 'No matching listings.'), node('p', 'Try a different search or reset the filters to explore more offers.', 'hint'));
    resultsRegion.append(empty); return;
  }
  for (const listing of filtered.slice((catalogPage - 1) * 12, catalogPage * 12)) {
    const article = node('article', undefined, 'listing product-card');
    const art = node('div', undefined, 'product-art'); art.setAttribute('aria-hidden', 'true');
    art.append(node('small', listing.category), node('span', listing.title.slice(0, 2).toUpperCase()));
    const copy = node('div', undefined, 'product-copy');
    copy.append(node('h3', listing.title), node('p', listing.summary || 'Discover what this provider can do for you.', 'hint summary'));
    copy.append(node('p', listing.agentId, 'field-note'));
    if (!listing.offers.length) copy.append(node('p', 'Request current availability', 'hint'));
    const buttons = node('div', undefined, 'actions');
    const save = node('button', savedListingIds.includes(listing.listingId) ? 'Saved' : 'Save', 'secondary');
    save.type = 'button'; save.dataset.saveListing = listing.listingId;
    save.setAttribute('aria-label', (savedListingIds.includes(listing.listingId) ? 'Remove saved ' : 'Save ') + listing.title);
    save.setAttribute('aria-pressed', String(savedListingIds.includes(listing.listingId)));
    save.addEventListener('click', () => toggleSaved(listing)); buttons.append(save);
    const compare = node('button', comparedListingIds.includes(listing.listingId) ? 'Comparing' : 'Compare', 'secondary');
    compare.type = 'button'; compare.dataset.compareListing = listing.listingId;
    compare.setAttribute('aria-label', (comparedListingIds.includes(listing.listingId) ? 'Remove ' : 'Compare ') + listing.title);
    compare.setAttribute('aria-pressed', String(comparedListingIds.includes(listing.listingId)));
    compare.disabled = !comparedListingIds.includes(listing.listingId) && comparedListingIds.length >= 3;
    compare.addEventListener('click', () => toggleCompared(listing)); buttons.append(compare);
    const details = node('button', 'View details', 'secondary'); details.type = 'button';
    details.setAttribute('aria-label', 'View details for ' + listing.title);
    details.addEventListener('click', () => showListing(listing)); buttons.append(details);
    for (const offer of listing.offers) buttons.append(offerButton(listing, offer));
    copy.append(buttons); article.append(art, copy); resultsRegion.append(article);
  }
};
const runCatalogSearch = async () => {
  resultsRegion.setAttribute('aria-busy', 'true');
  document.querySelector('#catalog-count').textContent = 'Finding offers…';
  try { await actions.searchCatalog({ query: searchInput.value.trim(), limit: 100 }); }
  catch (error) { catalogError(error); }
};
searchForm.addEventListener('submit', event => { event.preventDefault(); void runCatalogSearch(); });
for (const control of [categoryFilter, availabilityFilter, sortFilter]) control.addEventListener('change', () => { catalogPage = 1; renderCatalog(catalog); });
savedOnlyButton.addEventListener('click', () => { savedOnly = !savedOnly; savedOnlyButton.setAttribute('aria-pressed', String(savedOnly)); catalogPage = 1; renderCatalog(catalog); });
document.querySelector('#catalog-reset').addEventListener('click', () => {
  categoryFilter.value = ''; availabilityFilter.value = ''; sortFilter.value = 'relevance'; savedOnly = false;
  savedOnlyButton.setAttribute('aria-pressed', 'false'); catalogPage = 1; renderCatalog(catalog);
});
for (const [id, direction] of [['catalog-previous', -1], ['catalog-next', 1]]) document.getElementById(id).addEventListener('click', () => {
  catalogPage += direction; renderCatalog(catalog); document.querySelector('#catalog-heading').scrollIntoView({ block: 'start' });
});
