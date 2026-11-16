// Product-owned text bounds; the generated core is byte-identical to the pinned package export.
import { deriveRegionalPoiLongitudeSpan } from './agentic-geo-core.mjs';

export const LISTING_GEO_LIMITS = Object.freeze({ longitudes: 1024, textCharacters: 24000 });

/** Transient preview only: no record, lookup, persistence or publication effects. */
export function previewListingLongitudes(text) {
  if (typeof text !== 'string' || text.length > LISTING_GEO_LIMITS.textCharacters) {
    throw new RangeError('Use at most 24,000 characters.');
  }
  if (!text.trim()) throw new TypeError('Enter at least one longitude.');
  const values = text.trim().split(/[\s,]+/u);
  if (values.length > LISTING_GEO_LIMITS.longitudes) throw new RangeError('Use at most 1,024 longitudes.');
  const longitudes = values.map(value => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) {
      throw new TypeError('Use finite decimal longitudes separated by commas or spaces.');
    }
    const longitude = Number(value);
    if (!Number.isFinite(longitude)) throw new RangeError('Use finite decimal longitudes.');
    return longitude;
  });
  return deriveRegionalPoiLongitudeSpan(longitudes);
}
