import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { evaluateLaunch } from '../../public/local-first/launch.js';
import { LAUNCH_MONEY_FIELDS, MAXIMUM_AMOUNT_MINOR } from '../../public/local-first/drafts.js';
import { compareOfferDrivers, rankSensitivity, simulateOffer } from '../../public/local-first/offer-simulator.js';

const saved = Object.freeze({ merchantId: 'maker', agentId: 'studio', audience: 'Local makers', outcome: 'A finished kit',
  currency: 'USD', priceMinor: 105, deliveryCostMinor: 10, providerFeeMinor: 10, agentCostMinor: 0,
  acquisitionCostMinor: 0, fixedCostMinor: 55 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('saved and preview estimates match the evaluator and changes are expressed in their native units', () => {
  const snapshot = Object.freeze({ revision: 3, launch: saved }), before = digest(snapshot);
  for (const preview of [{}, { deliveryCostMinor: 15, fixedCostMinor: 0 }, { priceMinor: 1 }, { priceMinor: MAXIMUM_AMOUNT_MINOR }]) {
    const result = compareOfferDrivers({ saved, preview });
    assert.deepEqual(result.saved, evaluateLaunch(saved));
    assert.deepEqual(result.preview, evaluateLaunch({ ...saved, ...preview }));
    assert.deepEqual(result.flags, { estimate: true, demandStatus: 'unvalidated' });
    for (const [key, value] of Object.entries(result.preview)) {
      if (typeof value === 'number') assert.equal(result.deltas[key], value - result.saved[key]);
    }
    assert.deepEqual(result.ranking, rankSensitivity({ terms: { ...saved, ...preview }, bandPercent: 10 }));
  }
  assert.equal(digest(snapshot), before);
  for (const [baseline, preview] of [[saved, { priceMinor: 20 }], [{ ...saved, priceMinor: 15 }, { priceMinor: 50 }], [{ ...saved, priceMinor: 15 }, {}]]) {
    const { deltas } = simulateOffer({ saved: baseline, preview });
    assert.equal(deltas.breakEvenSales, null); assert.equal(deltas.breakEvenReason, 'not_reachable');
  }
});

test('one-driver swings use half-up rounding, bounded endpoints and declared field order for ties', () => {
  const rows = rankSensitivity({ terms: saved });
  assert.deepEqual(rows.map(({ field, swing }) => [field, swing]), [
    ['priceMinor', 210], ['deliveryCostMinor', 20], ['providerFeeMinor', 20],
    ['fixedCostMinor', 11], ['agentCostMinor', 0], ['acquisitionCostMinor', 0],
  ]);
  for (const { field, lowTerms, highTerms, low, high, swing } of rows) {
    for (const key of Object.keys(saved).filter(key => key !== field)) {
      assert.equal(lowTerms[key], saved[key]); assert.equal(highTerms[key], saved[key]);
    }
    assert.equal(low, evaluateLaunch(lowTerms).tenSalesNetMinor);
    assert.equal(high, evaluateLaunch(highTerms).tenSalesNetMinor);
    assert.equal(swing, Math.abs(high - low));
  }
  assert.equal(rows[0].lowTerms.priceMinor, 95); assert.equal(rows[0].highTerms.priceMinor, 116);
  const atLimit = rankSensitivity({ terms: { ...saved, priceMinor: MAXIMUM_AMOUNT_MINOR }, bandPercent: 50 });
  assert.equal(atLimit[0].highTerms.priceMinor, MAXIMUM_AMOUNT_MINOR);
  for (const bandPercent of [1, 50]) {
    const terms = { ...saved, ...Object.fromEntries(LAUNCH_MONEY_FIELDS.map(key => [key, 0])), priceMinor: 1 };
    const tied = rankSensitivity({ terms, bandPercent });
    assert.deepEqual(tied.map(row => row.field), LAUNCH_MONEY_FIELDS);
    assert.equal(tied[0].lowTerms.priceMinor, 1);
  }
});

test('invalid amounts, missing saved fields and unsupported bands fail with a named field', () => {
  for (const [preview, field] of [[{ priceMinor: 0 }, 'priceMinor'], [{ agentCostMinor: -1 }, 'agentCostMinor'],
    [{ fixedCostMinor: 1.1 }, 'fixedCostMinor'], [{ priceMinor: '10' }, 'priceMinor'],
    [{ providerFeeMinor: MAXIMUM_AMOUNT_MINOR + 1 }, 'providerFeeMinor'], [{ currency: 'EUR' }, 'currency'],
    [null, 'preview'], [[], 'preview'], [new Date(), 'preview']]) {
    assert.throws(() => simulateOffer({ saved, preview }), { code: 'preview_invalid', field });
  }
  for (const bandPercent of [0, 51, null, 2.5, '10', NaN]) {
    assert.throws(() => compareOfferDrivers({ saved, bandPercent }), { code: 'band_invalid', field: 'bandPercent' });
  }
  const { deliveryCostMinor, ...incomplete } = saved;
  assert.throws(() => simulateOffer({ saved: incomplete }), { code: 'saved_invalid', field: 'deliveryCostMinor' });
});
