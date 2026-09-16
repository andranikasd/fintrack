import type { Goal } from '../lib/savings';

export interface GoalHistory {
  from:string;to:string;
  daily:Array<{goal_id:number;day:string;deposits:number;withdrawals:number}>;
  balances:Array<{goal_id:number;balance:number;firstEntry:string|null}>;
}
export interface GoalScenario {daily?:number;boost?:number;skip?:number;horizon?:number}

/** Self-contained: renderDashboard embeds the compiled function for offline scenario calculations. */
export function buildGoalModel(goal:Goal,history:GoalHistory,today:string,options:GoalScenario={}) {
  const shift=(day:string,n:number)=>{const date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+n);return date.toISOString().slice(0,10);};
  const difference=(a:string,b:string)=>Math.round((Date.parse(a)-Date.parse(b))/86400000);
  const total=history.balances.find(row=>row.goal_id===goal.id);
  const saved=total?.balance??goal.saved_minor,remaining=Math.max(0,goal.target_minor-saved);
  const source=history.daily.filter(row=>row.goal_id===goal.id&&row.day<=today);
  const start=saved-source.reduce((sum,row)=>sum+row.deposits-row.withdrawals,0);
  let running=start;
  const points:Array<{day:string;balance:number;deposits:number;withdrawals:number}>=[];
  for(let day=history.from;day<=today;day=shift(day,1)){
    const row=source.find(row=>row.day===day),deposits=row?.deposits??0,withdrawals=row?.withdrawals??0;
    running+=deposits-withdrawals;points.push({day,balance:running,deposits,withdrawals});
  }
  const current=points.filter(row=>row.day>=shift(today,-29));
  const previous=points.filter(row=>row.day>=shift(today,-59)&&row.day<shift(today,-29));
  const deposits=current.reduce((sum,row)=>sum+row.deposits,0),withdrawals=current.reduce((sum,row)=>sum+row.withdrawals,0);
  const net=deposits-withdrawals,previousNet=previous.reduce((sum,row)=>sum+row.deposits-row.withdrawals,0);
  const contributionDays=current.filter(row=>row.deposits>0).length;
  const historyComplete=history.from<=shift(today,-29)&&history.to>=today;
  const trendComplete=history.from<=shift(today,-59)&&history.to>=today;
  const recentPace=historyComplete&&net>0&&contributionDays>=2&&total?.firstEntry&&difference(today,total.firstEntry)>=6?net/30:null;
  const deadlineDays=goal.deadline?difference(goal.deadline,today):null;
  const required=remaining>0&&deadlineDays!==null&&deadlineDays>0?Math.ceil(remaining/deadlineDays):null;
  const planPace=Math.max(0,Math.min(goal.cap_minor??Infinity,goal.deadline?(required??0):(goal.daily_minor??0)));
  const requested=Number.isFinite(options.daily)?Math.max(0,Math.min(100000000000,Math.round(options.daily!))):planPace;
  const daily=Math.min(requested,goal.cap_minor??Infinity);
  const boost=Number.isFinite(options.boost)?Math.max(0,Math.min(100000000000,Math.round(options.boost!))):0;
  const skip=Number.isFinite(options.skip)?Math.min(365,Math.max(0,Math.floor(options.skip!))):0;
  const horizon=[90,180,365].includes(options.horizon??180)?options.horizon??180:180;
  const finish=(pace:number|null,extra=0,pause=0)=>{
    if(!remaining)return today;
    if(extra>=remaining)return shift(today,1);
    if(!pace||pace<=0)return null;
    const days=Math.ceil((remaining-extra)/pace)+pause;
    return days<=36500?shift(today,days):null;
  };
  const plannedFinish=finish(planPace),recentFinish=finish(recentPace),scenarioFinish=finish(daily,boost,skip);
  const future=Array.from({length:horizon+1},(_,i)=>({day:shift(today,i),
    planned:Math.max(saved,Math.min(goal.target_minor,saved+planPace*i)),
    recent:recentPace===null?null:Math.max(saved,Math.min(goal.target_minor,saved+recentPace*i)),
    scenario:i===0?saved:Math.max(saved,Math.min(goal.target_minor,saved+boost+daily*Math.max(0,i-skip))),
  }));
  const milestone=[.25,.5,.75,1].find(ratio=>saved<goal.target_minor*ratio)??1;
  const weeks=Array.from({length:8},(_,i)=>{
    const from=shift(today,-55+i*7),to=shift(from,6),rows=points.filter(row=>row.day>=from&&row.day<=to);
    return {from,to,deposits:rows.reduce((s,r)=>s+r.deposits,0),withdrawals:rows.reduce((s,r)=>s+r.withdrawals,0)};
  });
  return {saved,remaining,start,points,deposits,withdrawals,net,previousNet,contributionDays,historyComplete,trendComplete,recentPace,
    deadlineDays,required,planPace,requested,daily,boost,skip,horizon,plannedFinish,recentFinish,scenarioFinish,future,milestone,
    milestoneAmount:Math.ceil(goal.target_minor*milestone),milestoneRemaining:Math.max(0,Math.ceil(goal.target_minor*milestone)-saved),weeks};
}
