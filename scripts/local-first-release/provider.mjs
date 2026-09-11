import { WORKER } from './artifact.mjs';
import { readBoundedJsonResponse } from '../production-release/bounded-response.ts';

export function createProvider({ accountId, zoneId, token }) {
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[0-9a-f]{32}$/.test(zoneId) || !token) throw Error('Missing Cloudflare configuration');
  const script = `/accounts/${accountId}/workers/scripts/${WORKER}`, routeRoot = `/zones/${zoneId}/workers/routes`;
  async function api(resource, method = 'GET', body, absentAllowed = false) {
    const response = await fetch('https://api.cloudflare.com/client/v4' + resource, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    const value = await readBoundedJsonResponse(response, 1048576);
    if (absentAllowed && response.status === 404 && value.errors?.some(error => error.code === 10007)) return null;
    if (!response.ok || value.success !== true) throw Error(`Provider ${method} ${resource} failed (${response.status})`);
    return value.result;
  }
  async function active() {
    const value = await api(script + '/deployments', 'GET', undefined, true);
    if (value === null) return null;
    const deployment = value.deployments?.[0];
    if (!deployment || deployment.versions?.length !== 1 || deployment.versions[0].percentage !== 100) throw Error('Ambiguous active Worker version');
    return { deploymentId: deployment.id, versionId: deployment.versions[0].version_id };
  }
  async function route(pattern) {
    const routes = await api(routeRoot);
    if (!Array.isArray(routes) || routes.length > 1000) throw Error('Route inventory exceeds bound');
    const matches = routes.filter(item => item.pattern === pattern);
    if (matches.length > 1) throw Error('Duplicate route ownership');
    const match = matches[0];
    return match ? { id: match.id, pattern, script: match.script, state: 'bound' }
      : { id: null, pattern, script: null, state: 'absent' };
  }
  async function version(versionId, revision) {
    const value = await api(script + '/versions/' + encodeURIComponent(versionId));
    const bindings = value.resources?.bindings;
    const allowed = { ASSETS: 'assets', CF_VERSION_METADATA: 'version_metadata', RELEASE_CANDIDATE_SHA: 'plain_text' };
    if (!Array.isArray(bindings) || bindings.length !== 3
      || bindings.some(binding => allowed[binding.name] !== binding.type)
      || new Set(bindings.map(binding => binding.name)).size !== 3
      || !/^[0-9a-f]{40}$/.test(bindings.find(binding => binding.name === 'RELEASE_CANDIDATE_SHA')?.text)) {
      throw Error('Existing Worker is not the asset-only local-first profile');
    }
    const source = bindings.find(binding => binding.name === 'RELEASE_CANDIDATE_SHA').text;
    if (revision && (source !== revision || value.annotations?.['workers/tag'] !== revision)) throw Error('Uploaded version source mismatch');
    return { versionId, sourceRevision: source, bindingNames: bindings.map(binding => binding.name).sort() };
  }
  return { active, route, version,
    exposure: () => api(script + '/subdomain'),
    bindRoute: pattern => api(routeRoot, 'POST', { pattern, script: WORKER }),
    removeRoute: id => api(routeRoot + '/' + encodeURIComponent(id), 'DELETE'),
  };
}
