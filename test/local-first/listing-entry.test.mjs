import test from 'node:test';
import assert from 'node:assert/strict';
import { LISTING_FIELDS, validListing, listingFieldIssues, validDraft, parseImport,
  assertUniqueListingSources } from '../../public/local-first/drafts.js';
import { workspaceSnapshot } from '../../public/local-first/workspace-capabilities.js';
import { reviewLaunch, exportLaunchPack } from '../../public/local-first/launch.js';
import { checkListingEntry } from './listing-entry-browser.mjs';
const terms = { merchantId: 'listing-test', agentId: 'listing-agent', audience: 'Local operators', outcome: 'One prepared entry',
  currency: 'SGD', priceMinor: 200, deliveryCostMinor: 0, providerFeeMinor: 0, agentCostMinor: 0, acquisitionCostMinor: 0, fixedCostMinor: 0 };

export const listing = () => ({ schemaVersion: 1, status: 'draft', ...Object.fromEntries(LISTING_FIELDS.map(({ key, type }) =>
  [key, ['money', 'integer', 'number'].includes(type) ? null : ''])), currency: 'SGD', category: 'Design services',
  country: 'SG', region: 'East', askingPriceMinor: 8500000, monthlyProfitMinor: -50000,
  sourceUrl: 'https://example.invalid/business/studio', asOf: '2026-11-13' });
export const listingDraft = () => ({ id: '12345678-1234-1234-1234-123456789abc', title: 'Fictional studio',
  description: 'PRIVATE research', price: 'PRIVATE negotiation notes', launch: { ...terms }, workflow: null,
  listing: listing(), revision: 1, createdAt: 1, updatedAt: 1 });
const encode = drafts => JSON.stringify({ schema: 'commerce.local-drafts/v4', drafts });

test('reusable browser drill rejects unsafe targets and unbound delivered source before browser use', async () => {
  const browser = { newContext() { assert.fail('Invalid input reached the browser'); } };
  for (const [url, revision] of [['http://example.invalid/agentic-commerce-os/', 'a'.repeat(40)],
    ['https://user:secret@example.invalid/agentic-commerce-os/', 'a'.repeat(40)],
    ['https://example.invalid/agentic-commerce-os/?other=1', 'a'.repeat(40)],
    ['https://example.invalid/agentic-commerce-os/', 'local-unreleased']]) {
    await assert.rejects(checkListingEntry({ browser, url, revision, output: '/unused' }));
  }
});

test('listing contract distinguishes unknowns, zero and loss and refuses unsafe source/date/value claims', () => {
  const valid = listing(); assert.equal(validListing(valid), true); assert.equal(valid.monthlyRevenueMinor, null);
  assert.equal(validListing({ ...valid, monthlyRevenueMinor: 0, employees: 0 }), true);
  for (const change of [{ schemaVersion: 2 }, { status: 'published' }, { category: 'x'.repeat(121) }, { country: 'SGP' },
    { currency: '' }, { askingPriceMinor: 0 }, { askingPriceMinor: 0.1 }, { monthlyRevenueMinor: -1 },
    { monthlyRentMinor: Number.MAX_SAFE_INTEGER }, { employees: 0.5 }, { areaSqFt: Infinity },
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://user:secret@example.invalid/' },
    { asOf: '2026-02-30' }, { leaseEndsOn: '2025-02-29' }, { verified: true }]) {
    assert.equal(validListing({ ...valid, ...change }), false, JSON.stringify(change));
    assert(listingFieldIssues({ ...valid, ...change }).length > 0);
  }
  assert.equal(validListing({ ...valid, leaseEndsOn: '2028-02-29' }), true);
});

test('versioned listing backups preserve private facts and lifecycle while retaining strict record keys', () => {
  const draft = listingDraft(); assert(validDraft(draft));
  assert.deepEqual(parseImport(encode([draft])), [draft]);
  const archived = { ...draft, listing: { ...draft.listing, status: 'archived' } };
  assert.deepEqual(parseImport(encode([archived]))[0].listing, archived.listing);
  assert.throws(() => parseImport(encode([{ ...draft, listing: { ...draft.listing, approved: true } }])));
  assert.throws(() => parseImport(JSON.stringify({ schema: 'commerce.local-drafts/v3', drafts: [draft] })));
  const { listing: _listing, ...ordinary } = draft;
  assert.deepEqual(parseImport(encode([{ ...ordinary, listing: null }]))[0].listing, null);
});

test('duplicate source detection covers archived records and URL fragments without guessing business identity', () => {
  const a = listingDraft(), b = { ...a, id: '22345678-1234-1234-1234-123456789abc',
    listing: { ...a.listing, status: 'archived', sourceUrl: a.listing.sourceUrl + '#details' } };
  assert.throws(() => assertUniqueListingSources([a, b]), /already exists/);
  assert.throws(() => parseImport(encode([a, b])), /already exists/);
  assert.doesNotThrow(() => assertUniqueListingSources([a, { ...b, listing: { ...b.listing, sourceUrl: '' } }]));
});

test('launch and agent projections preserve existing privacy boundaries and refuse archived launch review', async () => {
  const draft = listingDraft(), review = await reviewLaunch(draft), pack = await exportLaunchPack(draft, review);
  assert.doesNotMatch(JSON.stringify(pack), /PRIVATE|example.invalid|monthlyProfit|"listing":|Design services/);
  const snapshot = workspaceSnapshot([draft]); assert.equal(snapshot.offers.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|example.invalid|monthlyProfit|"listing":|Design services/);
  draft.listing.status = 'archived';
  assert.deepEqual(workspaceSnapshot([draft]).offers, []);
  await assert.rejects(reviewLaunch(draft), /Restore/);
  await assert.rejects(exportLaunchPack(draft, review), /Restore/);
});
