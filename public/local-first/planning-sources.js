/*!
MIT License

Copyright (c) 2026 huijoohwee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

MIT License

Copyright (c) 2026 Agentic Design System contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of the software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Scope: this grant covers `site/` and its public catalog/schema. It excludes `registry/owner-ledger.json`
and grants no rights in any referenced source, identity, content, or asset.

*/
import { moneyDigits } from './launch.js';
import { actualAt,readSettlementPeriod,cohortCount } from './planning-model.js';
import { node,button,labelled } from './planning-grid.js';
import { formatValue } from './planning-catalog.js';

export function download(name,text,type) {
  const url=URL.createObjectURL(new Blob([text],{type}));
  const link=node('a');link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function showRecords(host,columns,records,label) {
  const shadow=host.attachShadow({mode:'open'}), css=node('link'), mount=node('div');
  css.rel='stylesheet';css.href=new URL('./agentic-base-data-view.css',import.meta.url);
  shadow.append(css,mount);
  const {mountDataView}=await import('./agentic-base-data-view.js');
  if(!host.isConnected) return;
  return mountDataView(mount,{ariaLabel:label,orientation:'rows',wrapText:true,
    columns:columns.map((name,i)=>({name,id:'field-'+i})),rows:records.map((cells,i)=>({id:'record-'+i,cells:cells.map(String)}))});
}
export function brief(plan,months) {
  const m=months.at(-1), fmt=k=>formatValue(m.data[k],'money',plan.currency);
  return [plan.name+' — operating brief','Period '+months[0].period+' through '+m.period,
    'Projected ending subscribers: '+formatValue(m.data.active,'count',plan.currency),
    'Closing monthly billings: '+fmt('recurring'),'Closing operating result: '+fmt('result'),'Closing cash: '+fmt('cash'),
    'Projection basis: '+plan.segments.map(s=>s.name).join(', '),
    'Unvalidated demand. Collections follow the scenario payment assumptions.'].join('\n');
}
export function exportPeriods(plan,months,keys,metrics) {
  const quote=v=>'"'+String(v).replaceAll('"','""')+'"';
  const rows=[['Period',...keys.map(k=>metrics[k].label)],...months.map(m=>[m.period,...keys.map(k=>m.data[k]??'')])];
  download('planning-periods.csv',rows.map(r=>r.map(quote).join(',')).join('\r\n'),'text/csv');
}
export function recordRows(plan,kind) {
 if(kind==='segments') return [ ['Offer','Subscribers at opening','Current price','Source'],
    plan.segments.map(s=>[s.name,s.opening,formatValue(s.price,'money',plan.currency),s.source?'Offer revision '+s.source.revision:'Scenario assumption']) ];
 return [['Source','Owner','Use'],[
   ['Scenario inputs','Merchant','Editable local assumptions and dates'],
   ['Calculation workbook','Sheets','Arithmetic, dependency references and missing-denominator results'],
   ['Source file hierarchy','Design System','Model pages and source navigation shared with Graph'],
   ['Records','Base','Offer mapping and source tables'],
   ...plan.segments.filter(s=>s.source).map(s=>[s.source.title,'Saved offer '+s.source.id,'Revision '+s.source.revision+' initial terms']),
 ]];
}
export function sourceDetail(host,plan,id) {
 const segment=plan.segments.find(s=>'source-'+s.id===id);
 host.append(node('h2',segment?.name ?? 'Scenario source'));
 const text=segment?.source? JSON.stringify(segment.source,null,2):'Manually editable scenario input';
 host.append(node('p',text),node('pre',JSON.stringify(segment ?? plan.company,null,2)),
   button('Download source JSON',()=>download('planning-source.json',JSON.stringify(segment ?? plan.company,null,2),'application/json')));
}

function plainTable(headers,rows){
  const wrap=node('div',undefined,'agentic-model-scroll'),table=node('table'),header=table.createTHead().insertRow();
  for(const h of headers)header.append(node('th',h));
  const body=table.createTBody();
  for(const row of rows){const tr=body.insertRow();for(const value of row)tr.insertCell().textContent=value;}
  wrap.append(table);return wrap;
}
export function actualsPage(host,plan,months,mark,refresh,say){
 const picker=node('input');picker.type='file';picker.accept='.json,application/json';
 picker.onchange=async()=>{
   try{
     const file=picker.files?.[0];if(!file||file.size>512000)throw Error('Choose a revenue period JSON file under 500 kB');
     const result=readSettlementPeriod(JSON.parse(await file.text()),plan.currency,moneyDigits(plan.currency));
     if(!picker.isConnected) return;
     plan.settlements={...result,name:file.name.slice(0,160)};mark();refresh();
   }catch(e){say(e.message);}
 };
 const fmt=v=>formatValue(v,'money',plan.currency);
 host.append(node('p','Import a Commerce revenue period export. Only complete months in the supplied period contribute settled amounts.'),labelled('Revenue period JSON',picker));
 if(plan.settlements)host.append(node('p',plan.settlements.name+' · '+plan.settlements.lineCount+' settlement lines · '+plan.currency));
 host.append(plainTable(['Month','Planned collections','Reported settlements','Difference'],months.map(m=>{
   const actual=actualAt(plan.settlements,m.period);return [m.period,fmt(m.data.receipts),fmt(actual),fmt(actual===null?null:actual-m.data.receipts)];
 })));
}
export function cohortTable(host,plan,months,first,last){
 const start=months.slice(first,last+1);
 host.append(node('h3','Acquisition cohorts'),plainTable(['Entry month',...start.map(m=>m.period)],start.map((m,i)=>[
   m.period,...start.map((_,j)=>formatValue(cohortCount(months,i+first,j+first),'count',plan.currency))])));
}
export function extraPage(host,id,plan,months,mark,refresh,say){
 const fmt=n=>formatValue(n,'money',plan.currency), end=months.at(-1), notes=plan.notes??={};
 const exportText=(file,text)=>button('Download '+file,()=>download(file,text,'text/plain'));
 if(id==='dashboard'){
   host.append(node('p','Ending subscribers · '+formatValue(end.data.active,'count',plan.currency)),
    plainTable(['Offer','Ending subscribers','Revenue','Gross profit'],end.segments.map(s=>[s.label,formatValue(s.data.active,'count',plan.currency),fmt(s.data.recurring),fmt(s.data.margin)])));
 }else if(id==='timeline'){
   host.append(plainTable(['Month','Staff','Payroll and operating costs','Capital purchases','Funding','Ending cash'],
    months.map(m=>[m.period,m.data.staff,fmt(m.data.opex),fmt(m.data.capex),fmt(m.data.funding),fmt(m.data.cash)])));
 }else if(id==='expenses'){
   const expenses=plan.expenses??=[],form=node('form',undefined,'agentic-model-controls'),title=node('input'),amount=node('input'),date=node('input');
   title.required=true;title.maxLength=100;amount.type='number';amount.required=true;amount.step='0.01';amount.min='0.01';amount.max='10000000';date.type='date';date.required=true;
   const submit=node('button','Record request');submit.type='submit';form.append(labelled('Expense description',title),labelled('Requested amount',amount),labelled('Expense date',date),submit);
   form.onsubmit=e=>{e.preventDefault();if(!form.reportValidity())return;if(expenses.length>=100){say('This scenario supports 100 requests.');return;}
     expenses.push({title:title.value.trim(),amount:amount.valueAsNumber,date:date.value,state:'Requested'});mark();refresh();};
   host.append(node('p','Track reimbursement requests separately from forecast expenses.'),form,plainTable(['Description','Date','Amount','Review'],expenses.map(e=>[e.title,e.date,fmt(e.amount),e.state])));
   for(const e of expenses.filter(e=>e.state==='Requested'))host.append(button('Mark reviewed · '+e.title,()=>{e.state='Reviewed';mark();refresh();}));
 }else if(id==='board'){
   const text=[brief(plan,months),'Operating review',...months.map(m=>m.period+' | Billings '+fmt(m.data.recurring)+' | Result '+fmt(m.data.result)+' | Cash '+fmt(m.data.cash))].join('\n');
   host.append(node('pre',text),exportText('board-packet.txt',text));
 }else{
   const brand=id==='identity', label=brand?'Brand and voice guidance':'Message to stakeholders',el=node('textarea');
   el.rows=7;el.maxLength=4000;el.value=notes[id]??(brand?'':brief(plan,months));
   el.oninput=()=>{notes[id]=el.value;mark();};
   host.append(labelled(label,el),button('Download text',()=>download(brand?'brand-notes.txt':'stakeholder-message.txt',el.value,'text/plain')));
 }
}
