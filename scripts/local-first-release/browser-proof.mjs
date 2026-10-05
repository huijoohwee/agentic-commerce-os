/** Shared completeness contract for the browser producer and protected release consumer. */
export const BROWSER_PROOF_SCHEMA = 'commerce.local-first-browser-proof/v2';
export const BROWSER_CHECKS = Object.freeze({
  scope: 'exact production scope and server mutation refusal',
  mobile: 'mobile draft creation, safe canvas link and responsive layout',
  offline: 'offline navigation, editing and durable reload',
  concurrency: 'concurrent tabs reject stale overwrites and retain editor text',
  portability: 'portable JSON roundtrip and atomic import conflict preservation',
  launch: 'offline merchant review, exact economics and private-note-free native launch export',
  review: 'unsaved and concurrently changed offers require fresh merchant review',
  economics: 'launch terms survive offline reload and loss-making estimates fail review',
  roles: 'shopper, vendor and admin views use durable drafts, private projections, human review and offline mobile navigation',
  checkout: 'Stripe test checkout review, provider identity, pending delivery refusal, cancellation, reload and offline safety',
  privacy: 'imported text cannot inject markup; no private draft network writes',
});
const required = Object.values(BROWSER_CHECKS);
export function completeBrowserChecks(checks) {
  return Array.isArray(checks) && checks.length === required.length
    && new Set(checks).size === required.length && required.every(check => checks.includes(check));
}
export function assertBrowserProof(proof, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision) || proof?.ok !== true || proof.sourceRevision !== revision
    || proof.checkout !== 'sandbox' || proof.schema !== BROWSER_PROOF_SCHEMA
    || !completeBrowserChecks(proof.checks)) throw Error('Candidate browser proof missing or incomplete');
  return proof;
}

// Live evidence deliberately does not claim the sandbox suite or a customer sale.
export const LIVE_BROWSER_PROOF_SCHEMA = 'commerce.local-first-live-browser-proof/v1';
export const LIVE_BROWSER_CHECKS = Object.freeze({
  identity: 'exact candidate, live offer profile and explicit checkout mode',
  layout: 'mobile and desktop education review with explicit price and private recovery controls',
  readOnly: 'live-read-only: GET-only UI, readiness and checkout; no Session creation or hosted payment',
  fixture: 'local-fixture: configured sales policy and verified paid download from a simulated payment',
  recovery: 'local-fixture: saved-file restore in a fresh browser and invalid recovery refusal',
  safety: 'local-fixture: offline entitlement hiding, uncached receipts and same-origin requests',
});
function liveRequired(scope) {
  if (scope === 'live-read-only') return [LIVE_BROWSER_CHECKS.identity, LIVE_BROWSER_CHECKS.layout, LIVE_BROWSER_CHECKS.readOnly];
  if (scope === 'local-fixture') return [LIVE_BROWSER_CHECKS.identity, LIVE_BROWSER_CHECKS.layout,
    LIVE_BROWSER_CHECKS.fixture, LIVE_BROWSER_CHECKS.recovery, LIVE_BROWSER_CHECKS.safety];
  return [];
}
export function completeLiveBrowserChecks(checks, scope) {
  const required = liveRequired(scope);
  return required.length > 0 && Array.isArray(checks) && checks.length === required.length
    && new Set(checks).size === required.length && required.every(check => checks.includes(check));
}
export function assertLiveBrowserProof(proof, revision, {checkout, profileDigest, scope} = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(profileDigest ?? '')
    || !['live', 'live-reader'].includes(checkout) || !['local-fixture', 'live-read-only'].includes(scope)
    || proof?.schema !== LIVE_BROWSER_PROOF_SCHEMA || proof.ok !== true || proof.sourceRevision !== revision
    || proof.checkout !== checkout || proof.profileDigest !== profileDigest || proof.scope !== scope
    || proof.hostedPaymentSubmitted !== false || proof.liveSessionCreated !== false || proof.customerRevenueVerified !== false
    || proof.provider !== (scope === 'local-fixture' ? 'local-stripe-contract-fixture' : 'read-only-live')
    || !completeLiveBrowserChecks(proof.checks, scope)) throw Error('Candidate live browser proof missing or incomplete');
  return proof;
}
