import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlan} from '../../public/local-first/planning-scenarios.js';
import {projectPlan,periodValue,bucketPeriods,sensitivity} from '../../public/local-first/planning-model.js';
import {verifyPlanningPins} from '../../scripts/local-first-release/planning-pins.mjs';
test('shared projections match their pins',verifyPlanningPins);
const fixture=()=>createPlan([], new Date('2026-12-01T00:00:00Z'));
test('segment aggregation, formula provenance and rolling balance checks',()=>{
  const plan=fixture();Object.assign(plan.company,{hires:2,hiring:4,finance:1300,funding:3});
  const baseline=projectPlan(plan); assert.equal(baseline.length,24);assert.equal(baseline[1].period,'2027-01');
  for(const m of baseline){
    assert.ok(Math.abs(m.data.check)<1e-6);
    assert.equal(m.data.recurring,m.segments.reduce((sum,s)=>sum+s.data.recurring,0));
    assert.match(m.segments[0].formulas.recurring.source,/^=A\d+ \* A\d+$/);
  }
  assert.equal(baseline[2].data.funding,1300);assert.equal(baseline[3].data.staff,3);
  const variant=structuredClone(plan);variant.segments[0].price+=5;
  const changed=projectPlan(variant); assert.ok(Math.abs(changed[0].data.result-baseline[0].data.result-5*baseline[0].segments[0].data.active)<1e-6);
  assert.notEqual(changed[23].data.cash,baseline[23].data.cash);
  const q=bucketPeriods(baseline,'2027-01','2027-03','quarter')[0];
  assert.equal(q.label,'2027 Q1');assert.equal(periodValue(q,'active'),baseline[3].data.active);
  assert.equal(periodValue(q,'opening'),baseline[1].data.opening);
  const sums=k=>q.months.reduce((n,m)=>n+m.data[k],0);
  assert.equal(periodValue(q,'recurring'),sums('recurring'));assert.equal(periodValue(q,'arpu'),sums('recurring')/sums('active'));
});
test('zero denominators stay unknown and sensitivity preserves the base scenario',()=>{
 const p=fixture();p.segments.forEach(s=>{s.opening=0;s.leads=0;});const ms=projectPlan(p);
 assert.equal(ms[0].data.lifetime,null);assert.equal(ms[0].data.cac,null);assert.equal(ms[0].data.multiple,null);
 const copy=JSON.stringify(p), rank=sensitivity(p,5,10);assert.equal(rank.length,6);assert.equal(JSON.stringify(p),copy);
 assert.throws(()=>sensitivity(p,25,10));p.company.hiring=0;assert.throws(()=>projectPlan(p));
});
test('saved offers retain their native monetary precision and revision',()=>{
 const launch={priceMinor:920,deliveryCostMinor:8,providerFeeMinor:4,agentCostMinor:2,acquisitionCostMinor:3,fixedCostMinor:0,
   merchantId:'merchant',agentId:'agent',audience:'Members',outcome:'Monthly service',currency:'JPY'};
 const scenario=createPlan([{id:'x',title:'Service',revision:4,launch}]);
 assert.equal(scenario.segments[0].price,920);assert.equal(scenario.segments[0].cost,14);assert.equal(scenario.segments[0].source.revision,4);
});
test('imported actuals distinguish fully covered zero months from missing or partial months',async()=>{
 const {readSettlementPeriod,actualAt,cohortCount}=await import('../../public/local-first/planning-model.js');
 const start=Date.parse('2026-12-01T00:00:00Z'),end=Date.parse('2027-02-09T00:00:00Z');
 const line={settlementId:'entry',settledAmountMinor:5000,markupMinor:100,recordedAtMs:start,recordedAt:new Date(start).toISOString(),currency:'USD'};
 const report={ok:true,startInclusiveMs:start,endExclusiveMs:end,lineCount:1,summedMarkupMinor:100,lines:[line]};
 const data=readSettlementPeriod(report,'USD',2);
 assert.equal(actualAt(data,'2026-12'),50);assert.equal(actualAt(data,'2027-01'),0);assert.equal(actualAt(data,'2027-02'),null);
 assert.throws(()=>readSettlementPeriod({...report,lines:[line,line],lineCount:2},'USD',2));
 const ms=projectPlan(fixture());assert.equal(cohortCount(ms,0,0),ms[0].data.added);assert.ok(cohortCount(ms,0,1)<ms[0].data.added);
});
