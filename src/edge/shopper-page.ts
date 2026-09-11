export const SHOPPER_PAGE = `<section aria-labelledby="catalog-heading" id="catalog">
  <div class="catalog-heading"><h2 id="catalog-heading">Explore the marketplace</h2>
    <form id="catalog-search" role="search"><label class="sr-only" for="catalog-query">Search catalog</label><input id="catalog-query" name="query" type="search" maxlength="280" placeholder="What do you need help with?" aria-label="Search catalog"><button type="submit" aria-label="Search catalog">Search</button></form>
  </div>
  <div class="catalog-layout">
    <details class="filters" open><summary>Filter listings</summary><div>
      <p class="eyebrow">Find your next outcome</p>
      <label>Category <select id="catalog-category" aria-label="Category"><option value="">All categories</option></select></label>
      <label>Availability <select id="catalog-availability" aria-label="Availability"><option value="">All listings</option><option value="ready">Offers available</option></select></label>
      <button class="secondary" id="catalog-reset" type="button">Reset filters</button>
    </div></details>
    <div><div class="toolbar"><span id="catalog-count" role="status">Loading listings…</span><label class="sr-only" for="catalog-sort">Sort listings</label><select id="catalog-sort" aria-label="Sort listings"><option value="relevance">Recommended order</option><option value="title">Name: A to Z</option></select></div>
      <div id="catalog-results" aria-live="polite" aria-busy="true"><div class="empty-state"><h3>Finding useful offers</h3><p class="hint">Your marketplace will appear here.</p></div></div>
      <div class="pagination"><button id="catalog-previous" type="button" class="secondary" disabled>Previous</button><span id="catalog-page">Page 1</span><button id="catalog-next" type="button" class="secondary" disabled>Next</button></div>
    </div>
  </div>
  <aside class="checkout-bar" aria-label="Your selection"><div><p class="eyebrow">Your selection</p><h3>One clear total, before you pay</h3><p id="offer-selection" class="hint" role="status">Choose an offer to review its total.</p></div><button id="initiate-checkout" type="button" disabled aria-label="Review checkout">Review checkout</button></aside>
  <section id="checkout-confirmation" class="confirmation" aria-labelledby="checkout-confirmation-heading" tabindex="-1" hidden>
    <p class="eyebrow">Checkout · Final review</p><h2 id="checkout-confirmation-heading">Review and confirm</h2>
    <p id="checkout-confirmation-summary" class="hint" aria-live="polite"></p><p id="confirmation-reference" class="hint" hidden></p>
    <dl><dt>Offer</dt><dd id="confirmation-offer"></dd><dt>Total</dt><dd id="confirmation-total"></dd><dt id="confirmation-expiry-label">Review expires</dt><dd id="confirmation-expiry"></dd></dl>
    <button id="confirm-checkout" type="button" aria-label="Confirm checkout after reviewing the total">Confirm checkout</button>
  </section>
  <dialog id="listing-detail" aria-labelledby="listing-detail-heading"><div class="section-head"><h2 id="listing-detail-heading">Offer details</h2><button type="button" class="secondary" data-close-dialog>Close</button></div><div id="listing-detail-body" class="panel-body"></div></dialog>
</section>`
