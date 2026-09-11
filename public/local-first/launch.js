// One browser/agent contract. No model, provider, account or network dependency.
import { validDraft, validLaunchTerms, MAXIMUM_AMOUNT_MINOR } from './drafts.js';
export const LAUNCH_CONTINUITY = 'edge-commerce-agent-mvp@0.2.0';

export function evaluateLaunch(terms) {
  if (!validLaunchTerms(terms)) throw Error('Complete the merchant, registered agent, buyer, outcome and bounded cost fields.');
  const variableCostMinor = terms.deliveryCostMinor + terms.providerFeeMinor + terms.agentCostMinor + terms.acquisitionCostMinor;
  const contributionMinor = terms.priceMinor - variableCostMinor;
  return Object.freeze({ currency: terms.currency, priceMinor: terms.priceMinor, variableCostMinor, contributionMinor,
    firstSaleNetMinor: contributionMinor - terms.fixedCostMinor,
    tenSalesNetMinor: contributionMinor * 10 - terms.fixedCostMinor,
    breakEvenSales: contributionMinor > 0 ? Math.ceil(terms.fixedCostMinor / contributionMinor) : null,
    estimate: true, demandStatus: 'unvalidated',
    constraints: Object.freeze(contributionMinor > 0 ? [] : ['non_positive_contribution']),
    argument: 'Reuse the registered discovery agent, merchant theme and human-confirmed checkout. Provider quotes own live prices.',
    selection: contributionMinor > 0 ? 'reviewable' : 'revise_costs_or_price' });
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function reviewLaunch(draft) {
  if (!validDraft(draft)) {
    throw Error('Save this offer before reviewing its launch.');
  }
  // Snapshot before async hashing: callers cannot mutate the reviewed terms mid-flight.
  const snapshot = structuredClone(draft), economics = evaluateLaunch(snapshot.launch);
  if (economics.constraints.length) throw Error('Estimated revenue must exceed per-sale costs before launch review.');
  return Object.freeze({ draftId: snapshot.id, revision: snapshot.revision, contentDigest: await digest(snapshot),
    terms: Object.freeze(snapshot.launch), economics,
    themeManifest: Object.freeze({ merchantId: snapshot.launch.merchantId,
      catalogScope: Object.freeze([snapshot.launch.agentId]),
      copy: Object.freeze({ brand: snapshot.title, headline: snapshot.launch.outcome, subhead: snapshot.launch.audience }) }) });
}

export async function exportLaunchPack(draft, reviewed) {
  // A review is an exact-content local acknowledgement, never provider or release authority.
  const current = await reviewLaunch(draft);
  if (!reviewed || current.draftId !== reviewed.draftId || current.revision !== reviewed.revision
    || current.contentDigest !== reviewed.contentDigest) throw Error('This offer changed. Review the saved version again.');
  return Object.freeze({ schema: 'commerce.merchant-launch/v1', continuityId: LAUNCH_CONTINUITY,
    source: { draftId: current.draftId, revision: current.revision, contentDigest: current.contentDigest },
    review: { disposition: 'reviewed-local', grantsPublishAuthority: false, grantsPaymentAuthority: false },
    themeManifest: current.themeManifest, economics: current.economics,
    checkout: { owner: 'agentic-commerce-os', path: '/s/' + current.terms.merchantId,
      priceAuthority: 'registered-discovery-provider', settlementAuthority: 'human-confirmation-and-payment-provider' },
    nextAction: { tool: 'commerce.theme.deploy', arguments: { merchantId: current.terms.merchantId, manifest: current.themeManifest },
      requires: ['operator-authorization', 'current-authoring-claim', 'active-registered-agent', 'provider-readiness'] },
    fulfillment: 'Use the authoritative settlement receipt before delivering the agreed outcome.',
    demandStatus: 'unvalidated' });
}

export function moneyDigits(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw Error('Use a three-letter currency code.');
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

export function parseMoney(text, currency) {
  const digits = moneyDigits(currency);
  if (typeof text !== 'string' || !/^\d+(?:\.\d+)?$/.test(text)) throw Error('Enter costs as non-negative amounts, without symbols or separators.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > digits || whole.length > 10) throw Error('Amount precision or size exceeds the currency limit.');
  const value = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0'));
  if (!Number.isSafeInteger(value) || value > MAXIMUM_AMOUNT_MINOR) throw Error('Amount exceeds the supported limit.');
  return value;
}

export function formatMoney(value, currency) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value / 10 ** moneyDigits(currency));
}
