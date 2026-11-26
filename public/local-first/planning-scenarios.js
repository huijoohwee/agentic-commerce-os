import { moneyDigits } from './launch.js';
import { defaults, OFFER_INPUTS, COMPANY_INPUTS } from './planning-catalog.js';
import { projectPlan } from './planning-model.js';
import { validLaunchTerms, isArchived, LAUNCH_VARIABLE_COST_FIELDS } from './drafts.js';

export const newSegment = (name='New offer') => ({id:crypto.randomUUID(),name,...defaults(OFFER_INPUTS)});
export function createPlan(drafts=[],now=new Date()) {
  const eligible=drafts.filter(d=>!isArchived(d) && validLaunchTerms(d.launch));
  const currency=eligible[0]?.launch.currency ?? 'USD';
  const segments=eligible.filter(d=>d.launch.currency===currency).slice(0,8).map(d=>{
    const t=d.launch, scale=10 ** moneyDigits(currency);
    return {...newSegment(d.title), price:t.priceMinor/scale, cost:LAUNCH_VARIABLE_COST_FIELDS
      .filter(k=>k!=='acquisitionCostMinor').reduce((n,k)=>n+t[k],0)/scale,cac:t.acquisitionCostMinor/scale,
      source:{id:d.id,revision:d.revision,title:d.title}};
  });
  if (!segments.length) segments.push({...newSegment('Service membership'),opening:18},
    {...newSegment('Care subscription'),opening:6,price:59,cost:14,leads:5});
  return {id:crypto.randomUUID(),name:eligible.length?'Offer plan':'Example plan',revision:0,
    start:now.toISOString().slice(0,7),currency,company:defaults(COMPANY_INPUTS),segments};
}
function open() {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('commerce-model-scenarios',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('plans',{keyPath:'id'});
    req.onerror=()=>reject(req.error); req.onsuccess=()=>resolve(req.result);
  });
}
async function transaction(mode,op) {
  const db=await open();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('plans',mode), store=tx.objectStore('plans'); let result,reason;
    tx.oncomplete=()=>{db.close();resolve(result);};
    tx.onabort=()=>{db.close();reject(reason || tx.error || Error('Plan storage unavailable'));};
    const fail=err=>{reason=err;tx.abort();};
    try {op(store,v=>{result=v;},fail);} catch(err){fail(err);}
  });
}
export function loadPlans(seed) {
  return transaction('readwrite',(store,done,fail)=>{
    const req=store.getAll();
    req.onsuccess=()=>{try {
      if(req.result.length){done(req.result);return;}
      const first=createPlan(seed); first.revision=1;store.add(first);done([first]);
    } catch(err){fail(err);}};
  });
}
export function savePlan(input) {
  const snapshot=structuredClone(input);
  if(!snapshot.name?.trim() || snapshot.name.length>120 || snapshot.segments.some(s=>!s.name?.trim() || s.name.length>120)) throw Error('Add a name of up to 120 characters');
  projectPlan(snapshot);
  return transaction('readwrite',(store,done,fail)=>{
    const req=store.get(snapshot.id);
    req.onsuccess=()=>{
      if((req.result?.revision ?? 0)!==snapshot.revision) return fail(Error('This scenario changed in another tab. Reload the saved scenario before editing.'));
      snapshot.revision++;store.put(snapshot);done(snapshot);
    };
  });
}
