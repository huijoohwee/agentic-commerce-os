import { renderStorefrontTemplate } from '../../src/local-first/checkout-offer.ts';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FILES, digest } from './artifact.mjs';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function authoredAssets(revision, checkout = 'sandbox') {
  if (!['sandbox', 'live-reader', 'live'].includes(checkout)) throw Error('asset_checkout_invalid');
  return FILES.map(file => {
    let bytes = fs.readFileSync('public/local-first/' + file);
    if (file === 'sw.js' || file === 'index.html') bytes = Buffer.from(renderStorefrontTemplate(bytes.toString(), revision, checkout));
    return { path: file.startsWith('workspace-pack.') ? 'services/workspace-pack/' + (file.endsWith('.html') ? '' : file) : file === 'index.html' ? '' : file, bytes: bytes.length, digest: digest(bytes),
      contentType: file.endsWith('.js') ? /(?:application|text)\/javascript/ : file.endsWith('.css') ? /text\/css/ : /text\/html/ };
  });
}
async function readDigest(response) {
  const reader = response.body?.getReader(), hash = createHash('sha256');
  let bytes = 0;
  try {
    if (reader) for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes >= 500000) throw Error('asset_body_over_budget');
      hash.update(next.value);
    }
    return { bytes, digest: hash.digest('hex') };
  } finally { await reader?.cancel(); }
}
export async function waitForAssets({ baseUrl, revision, checkout = 'sandbox', assets = authoredAssets(revision, checkout), previous = null,
  observe = () => {}, fetchImpl = fetch, now = Date.now, sleep = pause,
  timeoutMs = 60000, stableMs = 15000, intervalMs = 5000 }) {
  const deadline = now() + timeoutMs;
  const predecessor = previous?.sourceRevision === revision && previous.checkout !== checkout
    && typeof previous.workerVersionId === 'string' && previous.workerVersionId.length > 0
    ? authoredAssets(revision, previous.checkout) : [];
  let stableSince = null, attempt = 0;
  for (;;) {
    const observation = { attempt: ++attempt, observedAt: new Date(now()).toISOString(), assets: [] };
    const results = await Promise.all(assets.map(async asset => {
      const item = { path: asset.path, matched: false };
      try {
        const response = await fetchImpl(new URL(asset.path, baseUrl), { redirect: 'manual', cache: 'no-store',
          headers: { connection: 'close' }, signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - now()))) });
        Object.assign(item, { status: response.status, contentType: response.headers.get('content-type'),
          sourceRevision: response.headers.get('x-commerce-source'), ray: response.headers.get('cf-ray') });
        if (response.status !== 200) {
          if (![404, 502, 503, 504].includes(response.status)) item.terminal = 'asset_terminal_http_' + response.status;
          await response.body?.cancel(); return item;
        }
        if (item.sourceRevision !== revision) { item.error = 'asset_source_not_converged'; await response.body?.cancel(); return item; }
        Object.assign(item, await readDigest(response));
        const validHeaders = asset.contentType.test(item.contentType ?? '')
          && /(?:^|,\s*)no-transform(?:,|$)/.test(response.headers.get('cache-control') ?? '');
        if (item.digest === asset.digest && item.bytes === asset.bytes && validHeaders) item.matched = true;
        else {
          const prior = predecessor.find(row => row.path === asset.path);
          if (validHeaders && prior?.digest === item.digest && prior.bytes === item.bytes)
            item.error = 'asset_checkout_not_converged';
          else item.terminal = 'asset_integrity_mismatch';
        }
      } catch (error) {
        item.error = error.message;
        if (error.message === 'asset_body_over_budget') item.terminal = error.message;
      }
      return item;
    }));
    observation.assets = results;
    const matched = results.every(item => item.matched);
    stableSince = matched ? (stableSince ?? now()) : null;
    observation.stableForMs = stableSince === null ? 0 : now() - stableSince;
    observe(observation);
    const terminal = results.find(item => item.terminal);
    if (terminal) throw Error(terminal.terminal + ':' + terminal.path);
    if (matched && observation.stableForMs >= stableMs) return observation;
    if (now() >= deadline) throw Error('asset_convergence_deadline');
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}
