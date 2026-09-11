import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FILES, digest } from './artifact.mjs';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function authoredAssets(revision) {
  return FILES.map(file => {
    let bytes = fs.readFileSync('public/local-first/' + file);
    if (file === 'sw.js' || file === 'index.html') bytes = Buffer.from(bytes.toString().replaceAll('__RELEASE__', revision));
    return { path: file === 'index.html' ? '' : file, bytes: bytes.length, digest: digest(bytes),
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
export async function waitForAssets({ baseUrl, revision, assets = authoredAssets(revision),
  observe = () => {}, fetchImpl = fetch, now = Date.now, sleep = pause,
  timeoutMs = 60000, stableMs = 15000, intervalMs = 5000 }) {
  const deadline = now() + timeoutMs;
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
        if (item.digest !== asset.digest || item.bytes !== asset.bytes || !asset.contentType.test(item.contentType ?? '')
          || !/(?:^|,\s*)no-transform(?:,|$)/.test(response.headers.get('cache-control') ?? '')) item.terminal = 'asset_integrity_mismatch';
        else item.matched = true;
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
