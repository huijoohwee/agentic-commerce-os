// Project the pinned Gateway metadata into the existing offline browser asset.
import { readFileSync, writeFileSync } from 'node:fs';
import { openReferenceIndex } from 'agentic-gateway/references';

const asset = new URL('../public/local-first/sme-pack-business-plan.js', import.meta.url);
const source = readFileSync(asset, 'utf8');
const read = name => readFileSync(new URL(import.meta.resolve('agentic-gateway/references/' + name + '.json')), 'utf8');
const catalog = await openReferenceIndex(read('index'), JSON.parse(read('pin')));
const byId = new Map(catalog.list().map(entry => [entry.id, entry]));
const guidelines = {
  parent_prd: 'guideline/prd-tad-adr-mvp-gtm',
  pitch_deck: 'guideline/pitch-deck',
  business_plan: 'guideline/business-plan',
  financial_model: 'guideline/financial-model',
  venture_record: 'guideline/pd-bp-fm',
};
const sources = {};
for (const id of Object.values(guidelines)) {
  const ref = byId.get(id);
  if (ref?.kind !== 'guideline') throw Error('Unknown guideline: ' + id);
  sources[id] = {reference_id: id, version: ref.version, revision: ref.revision, digest: ref.digest};
}
const marker = /(?<=\/\/ Gateway guideline projection\n)[\s\S]*?(?=\/\/ End Gateway guideline projection)/g;
if ([...source.matchAll(marker)].length !== 1) throw Error('Missing guideline projection');
const project = records => source.replace(marker, () => 'const gatewaySources = ' + JSON.stringify(records, null, 2) + ';\n');
const projected = project(sources);

// Reassemble the offline pack with distinguishable values for every owner field.
// This also catches a literal copy that happens to match today's pinned metadata.
async function verifyPack(moduleText, records) {
  const { PACK } = await import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'));
  const rows = PACK.guideline_sources;
  for (const [rowId, id] of Object.entries(guidelines)) {
    const matches = rows.filter(row => row.id === rowId);
    if (matches.length !== 1 || Object.entries(records[id]).some(([key, value]) => matches[0][key] !== value))
      throw Error('SME pack row ' + rowId + ' must consume ' + id + ' from Gateway');
  }
  if (rows.length !== Object.keys(guidelines).length) throw Error('Unexpected SME pack guideline source');
}

await verifyPack(projected, sources);
const probes = Object.fromEntries(Object.entries(sources).map(([id, record]) =>
  [id, Object.fromEntries(Object.keys(record).map(key => [key, id + '#' + key]))]));
await verifyPack(project(probes), probes);
if (process.argv.includes('--write')) writeFileSync(asset, projected);
else if (projected !== source) throw Error('Stale guideline sources. Run node scripts/project-guideline-sources.mjs --write');
