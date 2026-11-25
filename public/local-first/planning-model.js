import { calculate } from './formula.mjs';
import { METRICS, OFFER_INPUTS, COMPANY_INPUTS } from './planning-catalog.js';

// Each bounded worksheet evaluates one segment or the consolidated book for one month.
// Keep both readable expressions and the actual Sheets addresses for cell inspection.
function sheet(inputs, rules) {
  const cells = {}, addresses = {}, formulas = {}, names = Object.keys({...inputs,...rules});
  names.forEach((key,i) => { addresses[key] = 'A' + (i + 1); });
  for (const [key,num] of Object.entries(inputs)) cells[addresses[key]] = {type:'number',value:num};
  for (const [key,expression] of Object.entries(rules)) {
    const source = '=' + expression.replace(/[a-zA-Z][a-zA-Z0-9]*/g, name => {
      if (!addresses[name]) throw Error('Unknown planning input ' + name);
      return addresses[name];
    });
    cells[addresses[key]] = {type:'formula',value:source};
    formulas[key] = {expression,source};
  }
  const values = calculate({rows:names.length,columns:1,cells});
  const data = {};
  for (const key of names) {
    const value = values[addresses[key]];
    if (value.error && value.error !== 'DIV_ZERO') throw Error('Planning calculation failed for ' + key);
    data[key] = value.value;
    if (data[key] !== null && (!Number.isFinite(data[key]) || Math.abs(data[key]) > 9e13)) throw RangeError('Plan exceeds the supported numeric range');
  }
  for(const info of Object.values(formulas)) {
    const keys=[...new Set(info.expression.match(/[a-zA-Z][a-zA-Z0-9]*/g) ?? [])];
    info.references=keys.map(key=>({key,address:addresses[key],value:data[key]}));
  }
  return {data,formulas};
}
const ratios = {
  arpu:'recurring / active', churnRate:'lost / opening * 100', marginRate:'margin / recurring * 100',
  cac:'acquisition / added', lifetime:'margin / active / (lost / opening)', multiple:'lifetime / cac',
  conversion:'added / leads * 100'
};
const segmentRules = {
  added:'leads * convert / 100',lost:'opening * churn / 100',active:'opening + added - lost',
  recurring:'active * price',runRate:'recurring * 12',service:'active * cost',acquisition:'added * unitAcquisition',
  margin:'recurring - service',original:'priorCohort * (1 - churn / 100)',...ratios,
};
const sumKeys = ['opening','leads','added','lost','active','recurring','runRate','service','acquisition','margin','original'];
const companyRules = {
  payroll:'staff * wages',opex:'payroll + tools + overhead + acquisition',result:'margin - opex',
  ar:'recurring * receivable / 100',ap:'service * payable / 100',receipts:'recurring - ar + priorAr',
  paid:'service - ap + priorAp',burn:'paid + opex - receipts',cashFlow:'funding - capex - burn',
  cash:'priorCash + cashFlow',equipment:'priorEquipment + capex',equity:'priorEquity + funding + result',
  assets:'cash + ar + equipment',liabilitiesEquity:'ap + equity',check:'assets - liabilitiesEquity',...ratios,
};
export function monthAt(start,index) {
 const [year,month] = start.split('-').map(Number), n=year*12+month-1+index;
 return Math.floor(n/12)+'-'+String(n%12+1).padStart(2,'0');
}
function checkInputs(input,fields) {
 for (const [key,{unit,max,label}] of Object.entries(fields)) {
   const n = input[key];
   if (!Number.isFinite(n) || n < (unit === 'period' ? 1 : 0) || n > max ||
     (['count','period'].includes(unit) && !Number.isInteger(n))) throw RangeError('Invalid ' + label);
 }
}
export function projectPlan(plan) {
 if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(plan.start) || Number(plan.start.slice(0,4)) < 1000 || Number(plan.start.slice(0,4)) > 9997 ||
     !/^[A-Z]{3}$/.test(plan.currency) || !Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length>8 ||
     new Set(plan.segments.map(s=>s.id)).size!==plan.segments.length) throw Error('Invalid planning horizon, currency or offers');
 checkInputs(plan.company,COMPANY_INPUTS);
 for (const s of plan.segments) checkInputs(s,OFFER_INPUTS);
 const months=[], c=plan.company;
 for (let i=0;i<24;i++) {
   const last=months.at(-1);
   const segments=plan.segments.map((s,j)=>{
     const prior=last?.segments[j].data;
     const {data,formulas}=sheet({opening:prior?.active ?? s.opening, priorCohort:prior?.original ?? s.opening,
       leads:i ? prior.leads*(1+s.growth/100) : s.leads,price:s.price,cost:s.cost,convert:s.convert,churn:s.churn,unitAcquisition:s.cac},segmentRules);
     return {id:s.id,label:s.name,data,formulas};
   });
   const totals=Object.fromEntries(sumKeys.map(k=>[k,segments.reduce((n,s)=>n+s.data[k],0)]));
   const prior=last?.data;
   const {data,formulas}=sheet({...totals, staff:c.staff+(i+1>=c.hiring?c.hires:0), wages:c.wages,tools:c.tools,overhead:c.overhead,
      receivable:c.receivable,payable:c.payable,funding:i+1===c.funding?c.finance:0,capex:c.capex,
      priorAr:prior?.ar ?? 0,priorAp:prior?.ap ?? 0,priorCash:prior?.cash ?? c.openingCash,
      priorEquity:prior?.equity ?? c.openingCash,priorEquipment:prior?.equipment ?? 0}, companyRules);
   data.runway=data.burn>0 ? Math.max(0,data.cash)/data.burn : null;
   if (Math.abs(data.check)<1e-7) data.check=0;
   formulas.runway={expression:'Positive closing cash divided by positive operating burn'};
   for (const k of sumKeys) formulas[k]={expression:'Sum across offers · '+METRICS[k].label};
   months.push({period:monthAt(plan.start,i),data,segments,formulas});
 }
 return months;
}
export function bucketPeriods(months,first,last,frequency) {
 const groups=[];
 for (const m of months.filter(m=>m.period>=first && m.period<=last)) {
   const [y,n]=m.period.split('-'), label=frequency==='year'?y:frequency==='quarter'?y+' Q'+Math.ceil(Number(n)/3):m.period;
   if (groups.at(-1)?.label!==label) groups.push({label,months:[]});
   groups.at(-1).months.push(m);
 }
 return groups;
}
export function periodValue(group,key,segmentId) {
 const rows=group.months.map(m=>segmentId ? m.segments.find(s=>s.id===segmentId)?.data : m.data);
 if (rows.some(r=>r?.[key]===undefined)) return null;
 const aggregation=METRICS[key].aggregation;
 if(rows.length===1 || aggregation==='last') return rows.at(-1)[key];
 if(aggregation==='first') return rows[0][key];
 if(aggregation==='sum') return rows.reduce((n,r)=>n+r[key],0);
 // Exposure-weighted period ratios use raw numerators and denominators.
 const totals=Object.fromEntries(sumKeys.map(k=>[k,rows.reduce((n,r)=>n+r[k],0)]));
 return sheet(totals,ratios).data[key];
}
export function sensitivity(plan,index,band) {
 if(!Number.isInteger(index)||index<0||index>=24||!Number.isFinite(band)||band<1||band>50) throw RangeError('Invalid sensitivity window');
 const baseline=projectPlan(plan)[index].data.result;
 return ['price','cost','cac','leads','churn','convert'].map(key=>{
   const shift=factor=>{
     const changed=structuredClone(plan);
     for(const s of changed.segments) {
       const v=Math.min(OFFER_INPUTS[key].max,s[key]*factor);
       s[key]=OFFER_INPUTS[key].unit==='count'?Math.round(v):v;
     }
     return projectPlan(changed)[index].data.result-baseline;
   };
   const lower=shift(1-band/100),upper=shift(1+band/100);
   return {key,lower,upper,swing:Math.abs(upper-lower)};
 }).sort((a,b)=>b.swing-a.swing);
}

// Only complete UTC months from a supplied period report are comparable to a plan month.
export function readSettlementPeriod(report,currency,minorDigits) {
 const {startInclusiveMs:start,endExclusiveMs:end,lines}=report??{};
 if(report?.ok!==true || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>=end ||
    end>8640000000000000 || !Array.isArray(lines) || lines.length>500 || report.lineCount!==lines.length) throw Error('Expected a complete Commerce revenue period report with up to 500 lines');
 const ids=new Set(), amounts={}, byMonth={};let markup=0;
 for(const line of lines){
   if(!line || typeof line.settlementId!=='string' || !line.settlementId || ids.has(line.settlementId) ||
     !/^[A-Z]{3}$/.test(line.currency) || !Number.isSafeInteger(line.recordedAtMs) || line.recordedAtMs<start || line.recordedAtMs>=end ||
     new Date(line.recordedAtMs).toISOString()!==line.recordedAt || !Number.isSafeInteger(line.settledAmountMinor) || line.settledAmountMinor<0 ||
     !Number.isSafeInteger(line.markupMinor)||line.markupMinor<0||line.markupMinor>line.settledAmountMinor) throw Error('Invalid or duplicate settlement line');
   ids.add(line.settlementId);markup+=line.markupMinor;
   if(line.currency!==currency)continue;
   const month=line.recordedAt.slice(0,7);amounts[month]=(amounts[month]??0)+line.settledAmountMinor;
   if(!Number.isSafeInteger(amounts[month]))throw Error('Settlement total exceeds precision');
   byMonth[month]=amounts[month]/10**minorDigits;
 }
 if(!Number.isSafeInteger(markup)||report.summedMarkupMinor!==markup)throw Error('Settlement report total mismatch');
 return {start,end,byMonth,lineCount:lines.length,currency};
}
export function actualAt(snapshot,period) {
 if(!snapshot || Date.parse(period+'-01T00:00:00Z')<snapshot.start ||
    Date.parse(monthAt(period,1)+'-01T00:00:00Z')>snapshot.end)return null;
 return snapshot.byMonth[period]??0;
}
export function cohortCount(months,cohort,at,segmentId) {
 if(at<cohort)return null;
 const origin=months[cohort].segments.filter(s=>!segmentId||s.id===segmentId);
 return origin.reduce((sum,s)=>{
   let active=s.data.added;
   for(let i=cohort+1;i<=at;i++){const m=months[i].segments.find(row=>row.id===s.id);active*=1-m.data.churn/100;}
   return sum+active;
 },0);
}
