import fs from 'node:fs';
import {createHash} from 'node:crypto';
export function verifyPlanningPins() {
  const expected = {
    'source-explorer.js':['agentic-design-system','site/source-explorer.js'],
    'planning-explorer.css':['agentic-design-system','site/source-explorer.css'],
    'formula.mjs':['agentic-sheets','sheets/formula.mjs'], 'schema.mjs':['agentic-sheets','sheets/schema.mjs'],
  };
  const pins=JSON.parse(fs.readFileSync('config/planning-sources.pin.json'));
  if(!Array.isArray(pins)||new Set(pins.map(p=>p.asset)).size!==4||pins.length!==4)throw Error('Planning source inventory invalid');
  for(const {asset,path,owner,revision,sha256} of pins){
    const entry=expected[asset];
    if(!entry||entry[0]!==owner||entry[1]!==path||!/^[0-9a-f]{40}$/.test(revision) ||
      createHash('sha256').update(fs.readFileSync('public/local-first/'+asset)).digest('hex')!==sha256)
      throw Error('Planning source differs from pin: '+asset);
  }
}
