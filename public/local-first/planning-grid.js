import {METRICS,formatValue} from './planning-catalog.js';
import {periodValue} from './planning-model.js';

export function node(tag,text,cls) {
  const el=document.createElement(tag);
  if(text!==undefined) el.textContent=text;
  if(cls) el.className=cls;
  return el;
}
export function button(label,click) {const b=node('button',label,'secondary');b.type='button';b.onclick=click;return b;}
export function labelled(text,control) {const l=node('label');l.append(node('span',text),control);return l;}
export function select(values,current,change) {
  const el=node('select');
  for(const [value,text] of values) {const opt=node('option',text);opt.value=value;el.append(opt);}
  el.value=current;el.onchange=()=>change(el.value);return el;
}
export function renderGrid(host,{keys,groups,currency,expanded,selection,onSelect,onExpand}) {
  const table=node('table'),head=table.createTHead().insertRow();
  head.append(node('th','Metric'));
  for(const group of groups) head.append(node('th',group.label));
  const body=table.createTBody(), first=groups[0].months[0];
  const row=(key,segment)=>{
    const tr=body.insertRow(), th=node('th'), spec=METRICS[key];
    const detailed=!segment && Object.hasOwn(first.segments[0].data,key);
    if(detailed) {
      const b=button((expanded.has(key)?'▾ ':'▸ ')+spec.label,()=>onExpand(key));
      b.setAttribute('aria-expanded',String(expanded.has(key)));th.append(b);
    } else th.textContent=segment?'↳ '+segment.label:spec.label;
    th.scope='row';tr.append(th);
    for(const group of groups) {
      const value=periodValue(group,key,segment?.id);
      const b=button(formatValue(value,spec.unit,currency),()=>{
        for(const active of table.querySelectorAll('[aria-pressed=true]')) active.setAttribute('aria-pressed','false');
        b.setAttribute('aria-pressed','true');onSelect({key,group:group.label,id:segment?.id});
      });
      b.setAttribute('aria-label',[spec.label,segment?.label,group.label,b.textContent].filter(Boolean).join(' · '));
      b.setAttribute('aria-pressed',String(selection?.key===key && selection?.id===segment?.id && selection?.group===group.label));
      tr.insertCell().append(b);
    }
  };
  for(const key of keys) {
    row(key);
    if(expanded.has(key) && Object.hasOwn(first.segments[0].data,key)) for(const s of first.segments) row(key,s);
  }
  const scroll=node('div',undefined,'agentic-model-scroll');scroll.append(table);host.append(scroll);
}
export function describeCell(selection,groups,currency) {
 const {key,id}=selection;
 const g=groups.find(group=>group.label===selection.group);
 if(!g) return '';
 const m=g.months[0], book=id?m.segments.find(s=>s.id===id):m;
 const formula=book.formulas[key], spec=METRICS[key];
 return [spec.label,book.label || 'All offers',g.label,formatValue(periodValue(g,key,id),spec.unit,currency),
   formula?.expression || (id?'Offer assumption or prior month balance':'Operating assumption or scheduled input'),
   formula?.source, g.months.length===1 && formula?.references?.map(ref=>ref.address+' '+ref.key+' '+(ref.value==null?'—':Number(ref.value.toFixed(3)))).join(', '),
   g.months.length>1?'Period calculation: '+spec.aggregation:null].filter(Boolean).join(' · ');
}
