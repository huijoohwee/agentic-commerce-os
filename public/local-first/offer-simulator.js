import { invalidLaunchFields, LAUNCH_MONEY_FIELDS, MAXIMUM_AMOUNT_MINOR } from './drafts.js';
import { evaluateLaunch } from './launch.js';

export const DEFAULT_BAND_PERCENT = 10;
const metrics = ['priceMinor', 'variableCostMinor', 'contributionMinor', 'firstSaleNetMinor', 'tenSalesNetMinor'];

function invalid(code, field) {
  // The stateless service transports workspace codes. Keep field names in its bounded alphabet.
  const suffix = field.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
  const message = 'workspace_' + code + '_' + (/^[a-z_]{1,64}$/.test(suffix) ? suffix : 'field');
  throw Object.assign(new RangeError(message), { code, field });
}

function validateTerms(terms, source) {
  const fields = invalidLaunchFields(terms);
  if (fields.length) invalid(source + '_invalid', fields.find(field => field !== 'launch') ?? 'launch');
}

/** Preview overrides are money drivers in integer minor units. */
export function simulateOffer({ saved, preview = {} }) {
  validateTerms(saved, 'saved');
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(preview))) invalid('preview_invalid', 'preview');
  for (const field of Object.keys(preview)) {
    if (!LAUNCH_MONEY_FIELDS.includes(field)) invalid('preview_invalid', field);
  }
  const terms = { ...saved, ...preview };
  validateTerms(terms, 'preview');
  const baseline = evaluateLaunch(saved), estimate = evaluateLaunch(terms);
  const deltas = Object.fromEntries(metrics.map(field => [field, estimate[field] - baseline[field]]));
  const reachable = estimate.breakEvenSales !== null && baseline.breakEvenSales !== null;
  deltas.breakEvenSales = reachable ? estimate.breakEvenSales - baseline.breakEvenSales : null;
  if (!reachable) deltas.breakEvenReason = 'not_reachable';
  return { saved: baseline, preview: estimate, deltas,
    flags: { estimate: estimate.estimate, demandStatus: estimate.demandStatus } };
}

/** Vary one driver at a time around the preview. Endpoints and swing use ten-sale net minor units. */
export function rankSensitivity({ terms, bandPercent = DEFAULT_BAND_PERCENT }) {
  validateTerms(terms, 'preview');
  if (!Number.isInteger(bandPercent) || bandPercent < 1 || bandPercent > 50) invalid('band_invalid', 'bandPercent');
  return LAUNCH_MONEY_FIELDS.map(field => {
    const endpoint = percent => Math.min(MAXIMUM_AMOUNT_MINOR, Math.floor((terms[field] * percent + 50) / 100));
    const lowTerms = { ...terms, [field]: endpoint(100 - bandPercent) };
    const highTerms = { ...terms, [field]: endpoint(100 + bandPercent) };
    const low = evaluateLaunch(lowTerms).tenSalesNetMinor;
    const high = evaluateLaunch(highTerms).tenSalesNetMinor;
    return { field, lowTerms, highTerms, low, high, swing: Math.abs(high - low) };
  }).sort((a, b) => b.swing - a.swing); // Stable sort retains the declared order for ties.
}

export function compareOfferDrivers({ saved, preview, bandPercent = DEFAULT_BAND_PERCENT }) {
  const comparison = simulateOffer({ saved, preview });
  return { ...comparison, bandPercent, ranking: rankSensitivity({ terms: { ...saved, ...preview }, bandPercent }) };
}
