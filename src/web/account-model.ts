import type { AccountAnalytics, FlowKind } from '../account-analytics';

export interface ReportAccount {id:number;name:string;opening_on:string;balance_minor:number;archived:number}

/** Pure, embedded in the report so account/month exploration works without a server. All amounts are minor units. */
export function buildAccountModel(history:AccountAnalytics,accounts:ReportAccount[],period:string,accountId:number|null=null) {
  const shift=(p:string,n:number)=>{const d=new Date(p+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,7);};
  const end=(p:string)=>{const d=new Date(shift(p,1)+'-01T00:00:00Z');d.setUTCDate(0);return d.toISOString().slice(0,10);};
  const sign=(kind:FlowKind)=>['expense','saving','transferOut'].includes(kind)?-1:1;
  const empty=()=>({income:0,expense:0,saving:0,withdrawal:0,transferIn:0,transferOut:0,funding:0,passive:0});
  const chosen=accounts.filter(a=>accountId===null||a.id===accountId);
  const ids=new Set(chosen.map(a=>a.id));
  const flows=history.daily.filter(r=>ids.has(r.accountId));
  const from=period+'-01',to=end(period)<history.to?end(period):history.to;
  const elapsed=to>=from?Number(to.slice(8)):0,days=Number(end(period).slice(8));
  const previousPeriod=shift(period,-1),previousFrom=previousPeriod+'-01';
  const previousTo=previousPeriod+'-'+String(Math.min(elapsed,Number(end(previousPeriod).slice(8)))).padStart(2,'0');
  const sum=(start:string,finish:string,id:number|null=null)=>{
    const totals=empty();for(const r of flows)if(r.day>=start&&r.day<=finish&&(id===null||r.accountId===id)){totals[r.kind]+=r.amount;if(r.kind==='income'&&r.passive)totals.passive+=r.amount;}return totals;
  };
  const balance=(day:string,id:number|null=null)=>history.baseline.filter(r=>ids.has(r.accountId)&&(id===null||r.accountId===id)).reduce((n,r)=>n+r.amount,0)+flows.filter(r=>r.day<=day&&(id===null||r.accountId===id)).reduce((n,r)=>n+sign(r.kind)*r.amount,0);
  const before=new Date(from+'T00:00:00Z');before.setUTCDate(0);const openingDay=before.toISOString().slice(0,10);
  const totals=sum(from,to),previous=sum(previousFrom,elapsed===days?end(previousPeriod):previousTo);
  const rows=chosen.filter(a=>a.opening_on<=to).map(a=>({...a,...sum(from,to,a.id),opening:balance(openingDay,a.id),closing:balance(to,a.id)}));
  const daily=Array.from({length:days},(_,i)=>{
    const day=period+'-'+String(i+1).padStart(2,'0'),actual=day<=to;
    return {day,actual,...sum(day,day),balance:actual?balance(day):null,spent:actual?sum(from,day).expense:null,
      previousSpent:sum(previousFrom,previousPeriod+'-'+String(Math.min(i+1,Number(end(previousPeriod).slice(8)))).padStart(2,'0')).expense,
      accounts:rows.map(a=>({id:a.id,balance:actual?(a.opening_on<=day?balance(day,a.id):null):null}))};
  });
  const months=[];for(let p=shift(history.from.slice(0,7),1);p<=period;p=shift(p,1)){
    const last=end(p)<history.to?end(p):history.to;
    months.push({period:p,...sum(p+'-01',last),closing:balance(last),partial:last<end(p),accounts:chosen.map(a=>({id:a.id,balance:a.opening_on<=last?balance(last,a.id):null}))});
  }
  const groups=(kind:FlowKind)=>{
    const map=new Map<string,number>();for(const r of history.breakdown)if(r.period===period&&r.kind===kind&&ids.has(r.accountId))map.set(r.label,(map.get(r.label)||0)+r.amount);
    return [...map].map(([label,amount])=>({label,amount})).sort((a,b)=>b.amount-a.amount);
  };
  return {period,from,to,elapsed,days,partial:elapsed<days,previousFrom,previousTo:elapsed===days?end(previousPeriod):previousTo,totals,previous,
    opening:balance(openingDay),closing:balance(to),rows,daily,months,sources:groups('income'),categories:groups('expense'),
    excluded:history.excluded.filter(r=>r.period===period),
    projected:elapsed?Math.round(totals.expense/elapsed*days):0,
    savingRate:totals.income?(totals.saving-totals.withdrawal)/totals.income*100:null,
  };
}
