import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {buildLocalHost,listingPlanJoin} from '../../scripts/local-host/build.ts';

test('evidence patch versions preserve the accepted five-role listing plan',()=>{
  const plan=readFileSync(new URL('../../docs/durable-fulfillment.md',import.meta.url),'utf8');
  const bytes=text=>new TextEncoder().encode(text);
  const accepted=listingPlanJoin(bytes(plan));
  assert.deepEqual(Object.values(accepted.revisions),Array(5).fill('0.3.0'));
  assert.deepEqual(listingPlanJoin(bytes(plan.replace(/version: "[^"]+"/,'version: "0.3.7"'))),accepted);
  for(const changed of [plan.replace(/version: "[^"]+"/,'version: "0.4.0"'),
    plan.replace('tad_revision: "0.3.0"','tad_revision: "0.3.1"')])
    assert.throws(()=>listingPlanJoin(bytes(changed)),/listing_plan_join_invalid/);
});

test('installed durable host builds within budget and rejects absent private configuration',async t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'listing-build-')));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=await buildLocalHost(directory,'listing');
  assert.equal(file,join(directory,'commerce-listing-host.mjs'));
  assert.ok(readFileSync(file).length<500000);
  const result=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Listing host unavailable/);
  assert.equal(result.stdout,'');
});
