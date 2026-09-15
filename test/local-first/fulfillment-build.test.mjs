import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {buildLocalHost} from '../../scripts/local-host/build.ts';

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
