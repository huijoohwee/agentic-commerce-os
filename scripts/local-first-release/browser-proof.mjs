/** Shared completeness contract for the browser producer and protected release consumer. */
export const BROWSER_PROOF_SCHEMA = 'commerce.local-first-browser-proof/v1';
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
  privacy: 'imported text cannot inject markup; no draft or checkout network writes',
});
const required = Object.values(BROWSER_CHECKS);
export function completeBrowserChecks(checks) {
  return Array.isArray(checks) && checks.length === required.length
    && new Set(checks).size === required.length && required.every(check => checks.includes(check));
}
export function assertBrowserProof(proof, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision) || proof?.ok !== true || proof.sourceRevision !== revision
    || proof.checkout !== 'deferred' || proof.schema !== BROWSER_PROOF_SCHEMA
    || !completeBrowserChecks(proof.checks)) throw Error('Candidate browser proof missing or incomplete');
  return proof;
}
