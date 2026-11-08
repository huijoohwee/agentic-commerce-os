// The public route binds a Worker version to an immutable Pages deployment.
// Never roll back an independently changed Worker or Pages alias.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
export function activeWorker(rows) {
  assert(Array.isArray(rows) && rows.length);
  const ordered=[...rows].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on));
  const current=ordered[0];assert(Number.isFinite(Date.parse(current.created_on)));
  assert(!ordered[1] || Date.parse(current.created_on)>Date.parse(ordered[1].created_on));
  assert.equal(current.versions.length,1);assert.equal(current.versions[0].percentage,100);
  const version=current.versions[0].version_id;assert.match(version,/^[0-9a-f-]{36}$/i);
  return {version,message:current.annotations?.['workers/message']};
}
export function recovery(current,prior,ours) {
  if(current===prior)return false;
  assert(ours,'Independent release detected; refusing rollback');return true;
}
async function main(action,dir){
  const read=f=>JSON.parse(fs.readFileSync(join(dir,f),'utf8'));
  const write=(f,x)=>fs.writeFileSync(join(dir,f),JSON.stringify(x)+'\n',{flag:'wx'});
  const account=process.env.CLOUDFLARE_ACCOUNT_ID, token=process.env.CLOUDFLARE_API_TOKEN;
  assert(account && token);
  const api=async (path,method='GET')=>{
    const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+path,{method,redirect:'error',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
    assert(r.ok,'Provider request failed: '+r.status);const v=await r.json();assert(v.success);return v.result;
  };
  const project='/pages/projects/agentic-design-system', worker='/workers/scripts/agentic-design-system-edge-production';
  const state=async()=>{
    const dep=await api(worker+'/deployments'),w=activeWorker(dep.deployments??dep);
    const p=(await api(project)).canonical_deployment;assert.equal(p.environment,'production');assert.match(p.id,/^[0-9a-f-]{36}$/i);
    return {...w,pages:p.id,pagesRevision:p.deployment_trigger.metadata.commit_hash};
  };
  const route=()=>JSON.parse(execFileSync(process.execPath,['scripts/design-system-release.mjs','route-proof','agentic-design-system-edge-production'],{encoding:'utf8'}));
  const headers=async()=>{const r=await fetch('https://airvio.co/agentic-design-system/?verify='+Date.now(),{method:'HEAD',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return ['release','source','payload'].map(k=>r.headers.get('x-design-system-'+k));};
  const file='prior-production.json', candidate=process.env.CANDIDATE_SHA;
  const message='Design System Production candidate '+candidate+' run '+process.env.GITHUB_RUN_ID;
  if(action==='capture'){
    const base=read('route-baseline.json');if(base.state==='absent')return;
    const s=await state(),ids=await headers();assert.match(ids[0],/^[a-f0-9]{40}$/);assert.match(ids[1],/^[a-f0-9]{40}$/);assert.match(ids[2],/^[a-f0-9]{64}$/);
    assert.equal(s.pagesRevision,ids[0]);assert(s.message?.startsWith('Design System Production candidate '+ids[0]+' run '));
    assert.equal(route().routeId,base.routeId);write(file,{...s,ids});return;
  }
  if(action==='check-pages'||action==='check-worker'){
    if(!fs.existsSync(join(dir,file)))return;
    const old=read(file), current=await state();assert.equal(current.version,old.version);
    assert.equal(current.pages,action==='check-pages'?old.pages:read('pages-production-deployment.json').id);
    assert.equal(route().routeId,read('route-baseline.json').routeId);return;
  }
  assert.equal(action,'restore');const p=read(file);assert.equal(route().routeId,read('route-baseline.json').routeId);
  let s=await state();
  if(recovery(s.version,p.version,s.message===message)){
    execFileSync('./node_modules/.bin/wrangler',['rollback',p.version,'--config','wrangler.design-system.jsonc','--env','production','--yes','--message','Restore preceding Design System release'],{stdio:'inherit'});
  }
  s=await state();assert.equal(s.version,p.version);
  if(recovery(s.pages,p.pages,s.pagesRevision===candidate)){
    await api(project+'/deployments/'+p.pages+'/rollback','POST');
  }
  s=await state();assert.equal(s.pages,p.pages);assert.equal(s.version,p.version);assert.deepEqual(await headers(),p.ids);
  write('route-rollback-receipt.json',{baseline:'active',workerVersion:p.version,pages:p.pages,routeId:route().routeId});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main(...process.argv.slice(2));
