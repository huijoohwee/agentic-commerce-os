import { mountSourceExplorer, createVarianceBar } from './source-explorer.js';
import { listDrafts } from './drafts.js';
import { PAGES, METRICS, PAGE_METRICS, COMPANY_INPUTS, OFFER_INPUTS,formatValue } from './planning-catalog.js';
import { loadPlans,savePlan,newSegment } from './planning-scenarios.js';
import { projectPlan,monthAt,bucketPeriods,sensitivity } from './planning-model.js';
import { node,button,select,labelled,renderGrid,describeCell } from './planning-grid.js';
import { download,brief,exportPeriods,recordRows,showRecords,sourceDetail,actualsPage,cohortTable,extraPage } from './planning-sources.js';
import { prepareViewStylesheet } from './workspace-view-styles.js';

const styles=prepareViewStylesheet(new URL('./planning-explorer.css',import.meta.url).href);
let pending,workspace;
export async function openPlanning(host,hash) {
  pending ??= Promise.all([styles(),listDrafts().then(loadPlans)]).catch(err=>{pending=null;throw err;});
  const [,plans]=await pending;
  if(location.hash.slice(1)!==hash) return;
  workspace ??= createWorkspace(host,plans);
  workspace.navigate(new URLSearchParams(hash.split('?')[1]).get('page'));
}

function createWorkspace(host,initial) {
 const plans=new Map(initial.map(p=>[p.id,p])), dirty=new Set(), expanded=new Set(),saving=new Set();
 let compareId, current=initial[0].id, page='volume',scope,first=0,last=11,frequency='month',band=10,selection,segmentId,recordHandle;
 const plan=()=>plans.get(current);
 const status=node('p'); status.setAttribute('role','status');
 const controls=node('div',undefined,'agentic-model-controls'), shell=node('div',undefined,'agentic-model-workspace');
 const sidebar=node('nav'),tree=node('div'),content=node('article');
 sidebar.setAttribute('aria-label','Planning navigation');
 const explorer=node('details'),wide=matchMedia('(min-width: 48rem)');
 explorer.open=wide.matches;wide.addEventListener('change',()=>{explorer.open=wide.matches;});
 explorer.append(node('summary','Explorer'),tree);sidebar.append(explorer);
 shell.append(sidebar,content);host.replaceChildren(controls,status,shell);
 function items(){
   return [...PAGES,...plan().segments.map(s=>({id:'source-'+s.id,name:'Source files/Offer assumptions/'+s.name.replaceAll('/',' ∕ ')}))];
 }
 const go=id=>{if(!wide.matches)explorer.open=false;location.hash='vendor-planning?page='+encodeURIComponent(id);};
 function showTree(){mountSourceExplorer(tree,{items:items(),label:'Planning pages and source files', selectedId:page,onOpen:go});}
 function say(text){status.textContent=text;}
 function mark(){dirty.add(current);say('Unsaved scenario changes');save.disabled=false;}
 let save;
 function header(){
   controls.replaceChildren();
   const picker=select([...plans.values()].map(p=>[p.id,p.name]),current,id=>{
     current=id;selection=null;segmentId=null;if(!items().some(i=>i.id===page))page='volume';
     showTree();header();render();
   });
   save=button('Save scenario',async()=>{
     const id=current, draft=plan(), snapshot=structuredClone(draft);
     if(saving.has(id))return; saving.add(id);save.disabled=true;
     try{
       const saved=await savePlan(snapshot);
       const unchanged=JSON.stringify(draft)===JSON.stringify(snapshot);draft.revision=saved.revision;
       if(unchanged)dirty.delete(id);
       if(id===current){header();say(unchanged?'Saved scenario revision '+saved.revision:'Newer edits are unsaved');}
     }catch(err){if(id===current)say(err.message);}
     finally{saving.delete(id);if(id===current)save.disabled=!dirty.has(id);}
   });
   save.disabled=!dirty.has(current)||saving.has(current);
   controls.append(labelled('Scenario',picker),button('Duplicate scenario',()=>{
      if(plans.size>=16){say('This workspace supports 16 scenarios.');return;}
      const clone=structuredClone(plan());clone.id=crypto.randomUUID();clone.name=(clone.name.slice(0,100)+' copy');clone.revision=0;
      plans.set(clone.id,clone);current=clone.id;dirty.add(current);header();showTree();render();
   }),save,button('Reload saved scenarios',async()=>{
     if(dirty.size && !window.confirm('Discard unsaved scenario changes on this device?'))return;
     try{const loaded=await loadPlans([]);plans.clear();dirty.clear();for(const p of loaded)plans.set(p.id,p);
       if(!plans.has(current))current=loaded[0].id;selection=null;segmentId=null;header();navigate(page);}
     catch(err){say(err.message);}
   }));
   say((dirty.has(current)?'Unsaved scenario':'Saved revision '+plan().revision)+' · '+plan().currency+' · Estimates, demand unvalidated');
 }
 function numberInput(owner,key,spec){
   const el=node('input');el.type='number';el.min=spec.unit==='period'?'1':'0';el.max=String(spec.max);
   el.step=['count','period'].includes(spec.unit)?'1':'any';el.value=owner[key];el.required=true;
   el.onchange=()=>{if(!el.reportValidity()) {el.value=owner[key];return;}owner[key]=el.valueAsNumber;mark();};
   return labelled(spec.label+(spec.unit==='money'?' ('+plan().currency+')':spec.unit==='%'?' (%)':''),el);
 }
 function addForm(title,owner,fields) {
   const fieldset=node('fieldset'),legend=node('legend',title),group=node('div',undefined,'agentic-model-controls');
   fieldset.append(legend,group);content.append(fieldset);
   for(const [key,spec] of Object.entries(fields))group.append(numberInput(owner,key,spec));
 }
 function editText(owner,key,label,onChange){
   const el=node('input');el.value=owner[key];el.maxLength=120;el.required=true;
   el.onchange=()=>{if(!el.value.trim()){el.value=owner[key];return;}owner[key]=el.value.trim();mark();onChange?.();};
   return labelled(label,el);
 }
 function assumptions(){
   const p=plan(),intro=node('div',undefined,'agentic-model-controls'),start=node('input');start.type='month';start.value=p.start;
   start.onchange=()=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(start.value)||+start.value.slice(0,4)<1000||+start.value.slice(0,4)>9997){start.value=p.start;return;}
     p.start=start.value;selection=null;mark();};
   intro.append(editText(p,'name','Scenario name',header),labelled('First model month',start),
     button('Add offer',()=>{if(p.segments.length>=8){say('A scenario supports eight offers.');return;}
      const s=newSegment('Offer '+(p.segments.length+1));p.segments.push(s);segmentId=s.id;mark();showTree();render();}));
   content.append(intro);
   const s=p.segments.find(s=>s.id===segmentId)??p.segments[0];
   const selector=select(p.segments.map(s=>[s.id,s.name]),s.id,id=>{segmentId=id;render();});
   const choose=node('div',undefined,'agentic-model-controls');choose.append(labelled('Offer segment',selector),
      editText(s,'name','Offer name',()=>{showTree();render();}));
   content.append(choose);addForm('Offer drivers',s,OFFER_INPUTS);addForm('Operating assumptions',p.company,COMPANY_INPUTS);
 }
 function periodControls(months){
   const bar=node('div',undefined,'agentic-model-controls'), options=months.map((m,i)=>[String(i),m.period]);
   const changed=()=>{selection=null;render();};
   bar.append(labelled('From month',select(options,String(first),v=>{first=+v;last=Math.max(last,first);changed();})),
    labelled('Through month',select(options,String(last),v=>{last=+v;first=Math.min(first,last);changed();})),
    labelled('Period grouping',select([['month','Monthly'],['quarter','Quarterly'],['year','Yearly']],frequency,v=>{frequency=v;changed();})));
   content.append(bar);
 }
 function grid(months,keys){
   const groups=bucketPeriods(months,months[first].period,months[last].period,frequency);
   const inspector=node('p');inspector.setAttribute('aria-label','Cell formula');inspector.setAttribute('aria-live','polite');
   if(!selection || !keys.includes(selection.key) || !groups.some(g=>g.label===selection.group))selection={key:keys[0],group:groups[0].label};
   const inspect=s=>{selection=s;inspector.textContent=describeCell(s,groups,plan().currency);};
   inspect(selection);content.append(inspector);
   renderGrid(content,{keys,groups,currency:plan().currency,expanded,selection,onSelect:inspect,onExpand:key=>{
     if(!expanded.delete(key))expanded.add(key);if(selection?.id && !expanded.has(selection.key))selection=null;render();}});
   const details=node('details');details.append(node('summary','Formula directory'));
   const list=node('ul');for(const key of keys)list.append(node('li',METRICS[key].label+' · '+(months[0].formulas[key]?.expression ?? 'Scenario input')));
   details.append(list);content.append(details,button('Export monthly values',()=>exportPeriods(plan(),months.slice(first,last+1),keys,METRICS)));
 }
 function unitTools(months){
   const p=plan(),segment=p.segments.find(s=>s.id===segmentId)??p.segments[0];
   const bar=node('div',undefined,'agentic-model-controls');
   bar.append(labelled('Adjust offer',select(p.segments.map(s=>[s.id,s.name]),segment.id,v=>{segmentId=v;render();})));
   for(const key of ['price','cost','churn','cac']) {
     const spec=OFFER_INPUTS[key],range=node('input'),out=node('output');range.type='range';range.min='0';
     range.max=String(Math.min(spec.max,Math.max(segment[key]*2, key==='churn'?20:100)));range.step='0.01';range.value=segment[key];
     out.textContent=formatValue(segment[key],spec.unit,p.currency);
     range.oninput=()=>{segment[key]=range.valueAsNumber;out.textContent=formatValue(segment[key],spec.unit,p.currency);
       mark();refreshResults(projectPlan(p));};
     const wrap=labelled(spec.label,range);wrap.append(out);bar.append(wrap);
   }
   const result=node('section'),detail=node('p'),meter=node('meter');
   const refreshResults=series=>{const val=series[last].data.multiple;
     detail.textContent=series[last].period+' · Estimated lifetime value / acquisition cost '+formatValue(val,'ratio',p.currency)+' · Scenario target '+p.company.target+'×';
     meter.min=0;meter.max=Math.max(1,p.company.target*2,val??0);meter.value=val??0;meter.hidden=val===null;
     meter.setAttribute('aria-label','Value compared to scenario target');result.replaceChildren();
     gridInto(result,series);};
   function gridInto(host,series){const groups=bucketPeriods(series,series[first].period,series[last].period,frequency);
     const info=node('p');info.setAttribute('aria-label','Cell formula');host.append(info);
     const keys=PAGE_METRICS.unit;const s=selection && keys.includes(selection.key) && groups.some(g=>g.label===selection.group)?selection:{key:'arpu',group:groups[0].label};
     info.textContent=describeCell(s,groups,p.currency);
     renderGrid(host,{keys,groups,currency:p.currency,expanded,selection:s,onSelect:v=>{selection=v;info.textContent=describeCell(v,groups,p.currency);},onExpand:k=>{if(!expanded.delete(k))expanded.add(k);render();}});
   }
   content.append(bar,detail,meter,result);refreshResults(months);
 }
 function risks(months){
   const control=node('input'),rows=node('div'),out=node('output');control.type='range';control.min='1';control.max='50';control.value=band;
   const display=()=>{out.textContent='±'+band+'%';const list=node('ol');
    const ranks=sensitivity(plan(),last,band), scale=Math.max(1,...ranks.flatMap(r=>[Math.abs(r.lower),Math.abs(r.upper)]));
    for(const item of ranks){const label=OFFER_INPUTS[item.key].label+' · Lower '+formatValue(item.lower,'money',plan().currency)+' · Higher '+formatValue(item.upper,'money',plan().currency);
      const row=node('li',label);row.append(createVarianceBar(document,item.lower,item.upper,scale,label));list.append(row);}
    rows.replaceChildren(list);};
   control.oninput=()=>{band=control.valueAsNumber;display();};
   content.append(node('p','Change in operating result at '+months[last].period+' when one driver moves across all offers.'),labelled('Driver change (%)',control),out,rows);display();
 }
 function render(){
   recordHandle?.destroy();recordHandle=null;
   const generation=scope=Symbol(), p=plan(), months=projectPlan(p);
   const item=items().find(i=>i.id===page)??PAGES[0];
   content.replaceChildren(node('h2',item.title??'Offer source'));
   if(page.startsWith('source-'))return sourceDetail(content,p,page);
   if(page==='inputs')return assumptions();
   if(page==='segments'||page==='sources'){
     const target=node('div');content.append(target);const [cols,rows]=recordRows(p,page);
     void showRecords(target,cols,rows,item.title).then(handle=>{if(scope===generation)recordHandle=handle;else handle?.destroy();}).catch(err=>{if(scope===generation)say(err.message);});
     return;
   }
   periodControls(months);
   const slice=months.slice(first,last+1);
   if(page==='compare'){
     const alternatives=[...plans.values()].filter(other=>other.id!==p.id && other.currency===p.currency);
     if(!alternatives.length){content.append(node('p','Duplicate this scenario to compare a second set of assumptions.'));return;}
     const other=alternatives.find(x=>x.id===compareId)??alternatives[0], comparison=new Map(projectPlan(other).map(m=>[m.period,m]));
     content.append(labelled('Compare against',select(alternatives.map(x=>[x.id,x.name]),other.id,id=>{compareId=id;render();})));
     const target=node('div');content.append(target);
     const fmt=n=>formatValue(n,'money',p.currency);
     const rows=slice.map(m=>{const prior=comparison.get(m.period);return [m.period,fmt(m.data.result),fmt(prior?.data.result),fmt(prior?m.data.result-prior.data.result:null)];});
     void showRecords(target,['Period',p.name+' result',other.name+' result','Difference'],rows,'Scenario comparison').then(handle=>{
       if(scope===generation)recordHandle=handle;else handle?.destroy();}).catch(err=>{if(scope===generation)say(err.message);});
     return;
   }
   if(page==='profit'){
     const crossing=slice.find(m=>m.data.cash<0),positive=slice.find(m=>m.data.result>0);
     content.append(node('p','First profitable month · '+(positive?.period??'None in range')+' · First cash shortfall · '+(crossing?.period??'None in range')));
   }
   if(page==='actuals')return actualsPage(content,p,slice,mark,render,say);
   if(['timeline','dashboard','expenses','board','identity','mail'].includes(page))return extraPage(content,page,p,slice,mark,render,say);
   if(page==='unit')return unitTools(months);
   if(page==='sensitivity')return risks(months);
   if(page==='report'){
     const text=brief(p,months.slice(first,last+1));content.append(node('pre',text),button('Download brief',()=>download('operating-brief.txt',text,'text/plain')));return;
   }
   grid(months,PAGE_METRICS[page]??PAGE_METRICS.volume);
   if(page==='retention')cohortTable(content,p,months,first,last);
 }
 function navigate(requested){page=items().some(i=>i.id===requested)?requested:'volume';selection=null;showTree();header();render();}
 return {navigate};
}
