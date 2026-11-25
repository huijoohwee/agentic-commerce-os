// Project the pinned Gateway metadata into the existing offline browser asset.
import { readFileSync, writeFileSync } from 'node:fs';
import { openReferenceIndex } from 'agentic-gateway/references';

const asset = new URL('../public/local-first/sme-pack-business-plan.js', import.meta.url);
const source = readFileSync(asset, 'utf8');
const read = name => readFileSync(new URL(import.meta.resolve('agentic-gateway/references/' + name + '.json')), 'utf8');
const catalog = await openReferenceIndex(read('index'), JSON.parse(read('pin')));
const byId = new Map(catalog.list().map(entry => [entry.id, entry]));
const sources = {};
for (const [, id] of source.matchAll(/\.\.\.gatewaySources\['([^']+)'\]/g)) {
  const ref = byId.get(id);
  if (ref?.kind !== 'guideline') throw Error('Unknown guideline: ' + id);
  sources[id] = {reference_id: id, path: ref.owner + '/' + ref.path, version: ref.version, revision: ref.revision, digest: ref.digest};
}
const marker = /(?<=\/\/ Gateway guideline projection\n)[\s\S]*?(?=\/\/ End Gateway guideline projection)/g;
if (!Object.keys(sources).length || [...source.matchAll(marker)].length !== 1) throw Error('Missing guideline projection');
const projected = source.replace(marker, () => 'const gatewaySources = ' + JSON.stringify(sources, null, 2) + ';\n');
if (process.argv.includes('--write')) writeFileSync(asset, projected);
else if (projected !== source) throw Error('Stale guideline sources. Run node scripts/project-guideline-sources.mjs --write');
