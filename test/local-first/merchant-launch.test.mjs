import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLaunch, reviewLaunch, exportLaunchPack, parseMoney } from '../../public/local-first/launch.js';
import { validLaunchTerms, parseImport } from '../../public/local-first/drafts.js';

export const terms = Object.freeze({ merchantId: 'solo-pilot', agentId: 'dev-e2e-flight', audience: 'Solo operators with a manual travel task',
  outcome: 'One reviewed itinerary', currency: 'USD', priceMinor: 12500, deliveryCostMinor: 4000,
  providerFeeMinor: 500, agentCostMinor: 100, acquisitionCostMinor: 900, fixedCostMinor: 10000 });
const draft = () => ({ id: '12345678-1234-1234-1234-123456789abc', revision: 1, title: 'Solo pilot',
  description: 'PRIVATE buyer research', price: 'PRIVATE negotiation notes', createdAt: 1, updatedAt: 1, launch: { ...terms } });

test('exact estimated unit economics include acquisition, tokens and setup without claiming demand', () => {
  assert.deepEqual(evaluateLaunch(terms), {
    currency: 'USD', priceMinor: 12500, variableCostMinor: 5500, contributionMinor: 7000,
    firstSaleNetMinor: -3000, tenSalesNetMinor: 60000, breakEvenSales: 2, estimate: true,
    demandStatus: 'unvalidated', constraints: [], selection: 'reviewable',
    argument: 'Reuse the registered discovery agent, merchant theme and human-confirmed checkout. Provider quotes own live prices.',
  });
  const loss = { ...terms, deliveryCostMinor: 20000 };
  assert.equal(evaluateLaunch(loss).breakEvenSales, null);
  assert.equal(evaluateLaunch(loss).selection, 'revise_costs_or_price');
});

test('money parsing never rounds extra precision, accepts zero and three decimal currencies, rejects unsafe inputs', () => {
  assert.equal(parseMoney('0.29', 'USD'), 29);
  assert.equal(parseMoney('125', 'JPY'), 125);
  assert.equal(parseMoney('1.234', 'KWD'), 1234);
  for (const [text, currency] of [['1.001', 'USD'], ['1.0', 'JPY'], ['1e3', 'USD'], ['-1', 'USD'],
    ['', 'USD'], ['Infinity', 'USD'], ['99999999999999999999', 'USD'], ['1', 'bad']]) {
    assert.throws(() => parseMoney(text, currency));
  }
  for (const input of [{ ...terms, priceMinor: 0 }, { ...terms, agentCostMinor: -1 }, { ...terms, providerFeeMinor: 0.1 },
    { ...terms, fixedCostMinor: 1_000_000_001 }, { ...terms, merchantId: '../other' }, { ...terms, published: true }]) {
    assert.equal(Boolean(validLaunchTerms(input)), false);
  }
});

test('reviewed launch uses the native theme tool contract, excludes private notes and grants no authority', async () => {
  const saved = draft(), review = await reviewLaunch(saved), pack = await exportLaunchPack(saved, review);
  assert.deepEqual(pack.nextAction.arguments, { merchantId: 'solo-pilot', manifest: pack.themeManifest });
  assert.equal(pack.nextAction.tool, 'commerce.theme.deploy');
  assert.deepEqual(pack.themeManifest.catalogScope, ['dev-e2e-flight']);
  assert.equal(pack.checkout.path, '/s/solo-pilot');
  assert.equal(pack.review.grantsPublishAuthority, false);
  assert.equal(pack.review.grantsPaymentAuthority, false);
  assert.equal(JSON.stringify(pack).includes('PRIVATE'), false);
  assert.equal(pack.demandStatus, 'unvalidated');
  assert.equal((await exportLaunchPack(saved, review)).source.contentDigest, pack.source.contentDigest);
});

test('missing, stale, altered or unprofitable reviews never export; mutable input cannot alter a pending review', async () => {
  const saved = draft(), review = await reviewLaunch(saved);
  await assert.rejects(exportLaunchPack(saved, null), /changed/);
  for (const changed of [{ ...saved, revision: 2 }, { ...saved, title: 'Changed' },
    { ...saved, launch: { ...terms, priceMinor: 10000 } }]) {
    await assert.rejects(exportLaunchPack(changed, review), /changed/);
  }
  await assert.rejects(reviewLaunch({ ...saved, launch: { ...terms, deliveryCostMinor: 20000 } }), /exceed/);
  const pending = reviewLaunch(saved);
  saved.launch.priceMinor = 1;
  assert.equal((await pending).terms.priceMinor, 12500);
});

test('legacy draft backups normalize to v2 while reordered terms roundtrip without trusting review flags', () => {
  const { launch, ...legacy } = draft();
  const encode = (schema, drafts) => JSON.stringify({ schema, drafts });
  assert.equal(parseImport(encode('commerce.local-drafts/v1', [legacy]))[0].launch, null);
  const saved = draft(); saved.launch = Object.fromEntries(Object.entries(launch).reverse());
  assert.deepEqual(parseImport(encode('commerce.local-drafts/v2', [saved]))[0].launch, terms);
  assert.throws(() => parseImport(encode('commerce.local-drafts/v2', [{ ...saved, approved: true }])));
  assert.throws(() => parseImport(encode('commerce.local-drafts/v1', [saved])));
});
