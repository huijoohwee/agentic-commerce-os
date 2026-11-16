import test from 'node:test';
import assert from 'node:assert/strict';
import * as installed from 'agentic-geo/core';
import * as projected from '../../public/local-first/agentic-geo-core.mjs';
import { longitudeCases, observeLongitudeCase } from 'agentic-geo/testing/longitude-cases';
import { previewListingLongitudes, LISTING_GEO_LIMITS } from '../../public/local-first/listing-geo.js';
import { verifyGeoProjection } from '../../scripts/agentic-geo-projection.mjs';

for (const [label, name, args, expected] of longitudeCases) {
  test(`installed and browser geo core: ${label}`, () => {
    for (const core of [installed, projected]) {
      const input = args(), before = structuredClone(input);
      assert.deepEqual(observeLongitudeCase(core, name, input), expected?.error ? expected : { value: expected });
      assert.deepEqual(input, before);
    }
  });
}

test('the offline browser projection matches its exact installed owner export and lock', () => {
  assert.equal(verifyGeoProjection().export, 'agentic-geo/core');
});

test('listing preview bounds text and finite decimal values before invoking the core', () => {
  assert.deepEqual(previewListingLongitudes('179, -179'), installed.deriveRegionalPoiLongitudeSpan([179, -179]));
  assert.deepEqual(previewListingLongitudes(' 1e2, +.5 -0\n540 '), installed.deriveRegionalPoiLongitudeSpan([100, .5, 0, 540]));
  assert.equal(previewListingLongitudes(Array(LISTING_GEO_LIMITS.longitudes).fill('45').join(' ')).center, 45);
  for (const value of ['', ' ', 'NaN', 'Infinity', '0x20', '1e309', '1,', '12 degrees']) {
    assert.throws(() => previewListingLongitudes(value));
  }
  assert.throws(() => previewListingLongitudes(Array(1025).fill('0').join(' ')), /1,024/u);
  assert.throws(() => previewListingLongitudes('0'.repeat(24001)), /24,000/u);
});
