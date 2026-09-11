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
  checkMain, record, wrangler, verifyLive, secretsFile }) {
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
      '--var', `RELEASE_CANDIDATE_SHA:${revision}`, '--secrets-file', secretsFile]);
    journal.active = await provider.active();
    if (!journal.active) throw Error('Candidate deployment absent');
    await provider.version(journal.active.versionId, revision, 'sandbox');
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
          wrangler(['versions', 'deploy', `${before.active.versionId}@100%`, '-c', CONFIG, '--yes']);
          if ((await provider.active())?.versionId !== before.active.versionId) throw Error('Version restoration unconfirmed');
          journal.outcome = 'failed-previous-version-restored';
        }
      }
    } catch (restorationError) { journal.restorationError = restorationError.message; }
    record('failed');
    throw error;
  }
}
