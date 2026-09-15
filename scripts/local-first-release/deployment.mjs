import { CONFIG, WORKER } from './artifact.mjs';
import { validateProductionRouteAuthorityProof } from '../production-release/route-authority.ts';
import { parseRetainedBaseline } from './retained-baseline.mjs';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export async function observeBefore(provider, authority, retainedInput = null) {
  const retained = parseRetainedBaseline(retainedInput);
  const before = { active: await provider.active(), route: await provider.route(authority.pattern) };
  validateProductionRouteAuthorityProof(authority, before.route, 'before');
  if (retained) {
    if (authority.mode !== 'bootstrap' || !same(before.active, {
      deploymentId: retained.deploymentId, versionId: retained.versionId,
    })) throw Error('Retained deployment changed; preserve the current provider state');
    await provider.version(retained.versionId, retained.sourceRevision);
  } else if (authority.mode === 'bootstrap' && before.active !== null) {
    throw Error('Bootstrap Worker already exists; inspect retained version before selecting a new release');
  }
  if (authority.mode === 'steady-state' && before.active === null) throw Error('Steady-state Worker is absent');
  if (before.active && !retained) await provider.version(before.active.versionId);
  return before;
}

// Context, candidate, preparation and human-review guards run in execute.mjs before this sequence.
export async function deployLocalFirst({ provider, routeAuthority, before, journal, revision,
  checkMain, record, wrangler, verifyLive, secretsFile, fulfillment = null }) {
  const { pattern, mode } = routeAuthority;
  let ownedVersion = false;
  try {
    checkMain();
    if (!same(await provider.active(), before.active) || !same(await provider.route(pattern), before.route)) {
      throw Error('Provider state changed before upload');
    }
    if (!secretsFile) throw Error('Sandbox signing secret file required');
    record('deploy-sandbox-worker');
    // Bootstrap is unrouted. An existing local-first route activates immediately on deploy.
    wrangler(['deploy', '-c', CONFIG, '--minify', '--tag', revision, '--message', 'Reviewed native sandbox checkout; no real payments',
      '--var', `RELEASE_CANDIDATE_SHA:${revision}`, '--secrets-file', secretsFile,
      ...(fulfillment ? ['--var', `LISTING_HOST_PINS_JSON:${JSON.stringify(fulfillment.pins)}`] : [])]);
    journal.active = await provider.active();
    if (!journal.active) throw Error('Candidate deployment absent');
    await provider.version(journal.active.versionId, revision, 'sandbox', fulfillment?.pins ?? null);
    ownedVersion = true;
    const exposure = await provider.exposure();
    if (exposure.enabled !== false || exposure.previews_enabled !== false) throw Error('Unexpected public subdomain exposure');
    record('version-verified');
    checkMain();
    if (!same(await provider.route(pattern), before.route) || !same(await provider.active(), journal.active)) {
      throw Error('Provider state changed before route');
    }
    if (mode === 'bootstrap') {
      record('activate-exact-route');
      await provider.bindRoute(pattern);
    }
    journal.route = await provider.route(pattern);
    validateProductionRouteAuthorityProof(routeAuthority, journal.route, 'after');
    record('verify-live-browser');
    await verifyLive(journal.active);
    if (!same(await provider.active(), journal.active) || !same(await provider.route(pattern), journal.route)) {
      throw Error('Final provider identity drift');
    }
  } catch (error) {
    journal.outcome = 'preserve-required'; journal.error = error.message;
    record('failed');
    try {
      // Never restore over a peer or replay an ambiguous upload/route write.
      if (ownedVersion && same(await provider.active(), journal.active)) {
        const currentRoute = await provider.route(pattern);
        if (mode === 'bootstrap' && currentRoute.state === 'bound' && currentRoute.script === WORKER
          && same(journal.route, currentRoute)) {
          await provider.removeRoute(currentRoute.id);
          if ((await provider.route(pattern)).state !== 'absent') throw Error('Route restoration unconfirmed');
          journal.outcome = 'failed-route-restored-worker-retained';
        } else if (mode === 'steady-state' && same(currentRoute, before.route)) {
          await activateLocalFirstVersion(wrangler, before.active.versionId);
          if ((await provider.active())?.versionId !== before.active.versionId) throw Error('Version restoration unconfirmed');
          journal.outcome = 'failed-previous-version-restored';
        }
      }
    } catch (restorationError) { journal.restorationError = restorationError.message; }
    record('failed');
    throw error;
  }
}

async function activateLocalFirstVersion(wrangler, versionId) {
  await wrangler(['versions', 'deploy', versionId + '@100%', '-c', CONFIG, '--yes']);
}

/** Exact restoration shared by failure recovery and the explicit rehearsal.
 * Call only after the existing protected release context and authority checks. */
export async function restoreLocalFirstVersion({ provider, pattern, route, expected, target,
  checkMain, record, wrangler }) {
  checkMain();
  await provider.version(target.versionId, target.sourceRevision, target.checkout, target.pins);
  const unchanged = async () => {
    if (!same(await provider.active(), expected) || !same(await provider.route(pattern), route))
      throw Error('Provider state changed before version restoration');
  };
  await unchanged();
  checkMain();
  record('restore-exact-version');
  // No retry: an ambiguous provider write must be reconciled by its owner.
  try {
    await activateLocalFirstVersion(wrangler, target.versionId);
    const active = await provider.active();
    if (active?.versionId !== target.versionId || !same(await provider.route(pattern), route))
      throw Error('Version restoration unconfirmed');
    return active;
  } catch (error) { error.writeResultUnknown = true; throw error; }
}

/** Rehearse one retained reader and return to the exact candidate. The browser
 * retains one actual job; no fixture result can establish provider continuity. */
export async function rehearseLocalFirstRollback({ provider, routeAuthority, candidate, reader,
  revision, pins, checkMain, record, wrangler, observation, journal }) {
  if (routeAuthority.mode !== 'steady-state' || candidate.versionId === reader.versionId)
    throw Error('Rollback rehearsal requires distinct deployed candidate and reader versions');
  const pattern = routeAuthority.pattern, route = await provider.route(pattern);
  if (route.state !== 'bound' || route.script !== routeAuthority.script
    || route.id !== routeAuthority.routeId) throw Error('Rollback rehearsal route mismatch');
  await provider.version(candidate.versionId, revision, 'sandbox', pins);
  await provider.version(reader.versionId, reader.sourceRevision, 'sandbox', null);
  if (!same(await provider.active(), candidate)) throw Error('Rollback rehearsal candidate changed');
  const proof = { schema: 'commerce.fulfillment-provider-rollback/v1', status: 'pending',
    sourceRevision: revision, candidate, reader, retainedJob: null, readerDeployment: null,
    restoredDeployment: null, readerVerified: false, restoredVerified: false,
    writeResultUnknown: false, realMoney: false };
  journal.rollback = proof;
  let failure;
  try {
    proof.retainedJob = await observation.prepare({ revision, versionId: candidate.versionId });
    record('rollback-job-retained');
    proof.readerDeployment = await restoreLocalFirstVersion({ provider, pattern, route, expected: candidate,
      target: { ...reader, checkout: 'sandbox', pins: null }, checkMain, record, wrangler });
    journal.active = proof.readerDeployment;
    record('rollback-reader-active');
    await observation.reader(reader);
    proof.readerVerified = true;
    record('rollback-reader-verified');
  } catch (error) { failure = error; }
  if (proof.readerDeployment) {
    try {
      proof.restoredDeployment = await restoreLocalFirstVersion({ provider, pattern, route,
        expected: proof.readerDeployment, target: { versionId: candidate.versionId, sourceRevision: revision,
          checkout: 'sandbox', pins }, checkMain, record, wrangler });
      journal.active = proof.restoredDeployment;
      record('rollback-candidate-restored');
      await observation.restored({ revision, versionId: candidate.versionId });
      proof.restoredVerified = true;
    } catch (error) {
      proof.restorationError = error.message;
      proof.writeResultUnknown ||= error.writeResultUnknown === true;
      failure ??= error;
    }
  }
  proof.status = !failure && proof.readerVerified && proof.restoredVerified ? 'complete' : 'preserve-required';
  proof.completedAt = new Date().toISOString();
  if (failure) { proof.error = failure.message; proof.writeResultUnknown ||= failure.writeResultUnknown === true; }
  record('rollback-rehearsal-' + proof.status);
  if (failure) throw failure;
  return proof;
}
