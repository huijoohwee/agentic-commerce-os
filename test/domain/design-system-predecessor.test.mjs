import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeWorker,recovery} from '../../scripts/design-system-predecessor.mjs';
test('refuses ambiguous traffic and independent successor writes',()=>{
  const a={created_on:'2026-01-01',versions:[{version_id:'a'.repeat(36),percentage:100}]};
  assert.equal(activeWorker([a]).version,a.versions[0].version_id);
  assert.throws(()=>activeWorker([a,a]));assert.throws(()=>activeWorker([{...a,versions:[...a.versions,...a.versions]}]));
  assert.throws(()=>recovery('new','old',false));assert.equal(recovery('old','old',false),false);assert.equal(recovery('new','old',true),true);
});
