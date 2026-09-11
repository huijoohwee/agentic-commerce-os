let catalogPage = 1;
let catalogViewSource = null;
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
    const prior = categoryFilter.value;
    categoryFilter.replaceChildren(new Option('All categories', ''));
    for (const category of [...new Set(listings.map(listing => listing.category))].sort()) categoryFilter.add(new Option(category, category));
    categoryFilter.value = [...categoryFilter.options].some(option => option.value === prior) ? prior : '';
  }
  let filtered = listings.filter(listing => (!categoryFilter.value || listing.category === categoryFilter.value)
    && (!availabilityFilter.value || listing.offers.length));
  if (sortFilter.value === 'title') filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 12));
  catalogPage = Math.min(totalPages, Math.max(1, catalogPage));
  document.querySelector('#catalog-count').textContent = filtered.length + (filtered.length === 1 ? ' listing' : ' listings') + (navigator.onLine ? '' : ' · saved on this device');
  document.querySelector('#catalog-page').textContent = 'Page ' + catalogPage + ' of ' + totalPages;
  document.querySelector('#catalog-previous').disabled = catalogPage <= 1;
  document.querySelector('#catalog-next').disabled = catalogPage >= totalPages;
  resultsRegion.setAttribute('aria-busy', 'false');
  resultsRegion.replaceChildren();
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
document.querySelector('#catalog-reset').addEventListener('click', () => {
  categoryFilter.value = ''; availabilityFilter.value = ''; sortFilter.value = 'relevance'; catalogPage = 1; renderCatalog(catalog);
});
for (const [id, direction] of [['catalog-previous', -1], ['catalog-next', 1]]) document.getElementById(id).addEventListener('click', () => {
  catalogPage += direction; renderCatalog(catalog); document.querySelector('#catalog-heading').scrollIntoView({ block: 'start' });
});
