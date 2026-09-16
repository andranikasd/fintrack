import { describe,expect,it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { buildGoalModel, type GoalHistory } from '../src/web/goal-model';
import { testDb } from './sqlite';
import { dashboardData } from '../src/web/data';
import { renderDashboard } from '../src/web/render';
import { todayIn,addDays } from '../src/lib/dates';
import type { Goal } from '../src/lib/savings';

const today='2026-09-16';
const goal:Goal={id:1,user_id:1,name:'Laptop',target_minor:100000,saved_minor:30000,opening_minor:10000,daily_minor:1000,deadline:null,cap_minor:null};
const history:GoalHistory={from:'2026-06-19',to:today,balances:[{goal_id:1,balance:30000,firstEntry:'2026-07-01'}],daily:[
  {goal_id:1,day:'2026-07-01',deposits:5000,withdrawals:0},
  {goal_id:1,day:'2026-08-20',deposits:10000,withdrawals:0},
  {goal_id:1,day:'2026-09-01',deposits:10000,withdrawals:0},
  {goal_id:1,day:today,deposits:0,withdrawals:5000},
]};
describe('offline goal projections',()=>{
 it('reconstructs history, includes withdrawals and excludes opening savings from contribution trends',()=>{
  const m=buildGoalModel(goal,history,today);
  expect(m.start).toBe(10000);expect(m.points.at(-1)!.balance).toBe(30000);expect(m.net).toBe(15000);
  expect(m.deposits).toBe(20000);expect(m.withdrawals).toBe(5000);expect(m.previousNet).toBe(0);
  expect(m.recentPace).toBe(500);expect(m.plannedFinish).toBe(addDays(today,70));expect(m.recentFinish).toBe(addDays(today,140));
  expect(m.milestone).toBe(.5);expect(m.milestoneRemaining).toBe(20000);
 });
 it('starts tomorrow, applies pauses and extra deposits, and respects the daily cap',()=>{
  const m=buildGoalModel({...goal,cap_minor:1500},history,today,{daily:2000,boost:10000,skip:7,horizon:90});
  expect(m.daily).toBe(1500);expect(m.scenarioFinish).toBe(addDays(today,47));
  expect(m.future[0]!.scenario).toBe(30000);expect(m.future[1]!.scenario).toBe(40000);expect(m.future[7]!.scenario).toBe(40000);expect(m.future[8]!.scenario).toBe(41500);
  expect(m.future.at(-1)!.scenario).toBe(goal.target_minor);
 });
 it('handles zero pace, reached goals, overdue targets and incomplete history honestly',()=>{
  expect(buildGoalModel(goal,history,today,{daily:0}).scenarioFinish).toBeNull();
  expect(buildGoalModel(goal,history,today,{daily:0,boost:70000,skip:30}).scenarioFinish).toBe(addDays(today,1));
  expect(buildGoalModel({...goal,target_minor:20000},history,today).scenarioFinish).toBe(today);
  expect(buildGoalModel({...goal,daily_minor:null,deadline:'2026-09-15'},history,today).plannedFinish).toBeNull();
  const m=buildGoalModel(goal,{...history,from:today,daily:history.daily.filter(r=>r.day===today)},today);
  expect(m.historyComplete).toBe(false);expect(m.recentPace).toBeNull();
  expect(buildGoalModel(goal,{...history,daily:history.daily.filter(r=>r.day!=='2026-08-20')},today).recentPace).toBeNull();
 });
 it('uses remaining calendar days for deadline pace and bounds unrealistic projections',()=>{
  const m=buildGoalModel({...goal,daily_minor:null,deadline:addDays(today,7)},history,today);
  expect(m.required).toBe(10000);expect(m.plannedFinish).toBe(addDays(today,7));
  expect(buildGoalModel({...goal,deadline:addDays(today,7)},history,today).planPace).toBe(10000);
  expect(buildGoalModel(goal,history,today,{daily:1}).scenarioFinish).toBeNull();
 });
 it('embeds a complete 90-day history even in a one-day report and scopes it to the owner',async()=>{
  const {db}=testDb();await db.ensureUser(1);await db.ensureUser(2);
  const day=todayIn('Asia/Yerevan');await db.accounts.create(1,'Card',100000000,addDays(day,-100),'card');await db.accounts.create(2,'Other',100000000,day,'other');
  await db.finance.putGoal(1,'Travel',1000000,null,1000,10000,null);await db.finance.putGoal(2,'Private',1000000,null,1000,0,null);
  const g=(await db.finance.goals(1))[0]!,other=(await db.finance.goals(2))[0]!;
  await db.finance.contribute(1,g.id,20000,addDays(day,-40),'old',1);await db.finance.contribute(1,g.id,10000,day,'today',1);
  await db.finance.contribute(2,other.id,99000,day,'private',2);
  const data=await dashboardData(db,1,'Asia/Yerevan',day,day);
  expect(data.records).toHaveLength(1);expect(data.goalHistory.daily).toHaveLength(2);
  expect(data.goalHistory.balances).toEqual([{goal_id:g.id,balance:40000,firstEntry:addDays(day,-40)}]);
  expect(data.goalHistory.from).toBe(addDays(day,-89));
  expect(buildGoalModel(g,data.goalHistory,day).start).toBe(10000);
 });
 it('creates a realistic standalone planner preview with several goals and recorded trends',async()=>{
  const {db}=testDb();await db.ensureUser(1);const day=todayIn('Asia/Yerevan'),from=addDays(day,-89);
  await db.accounts.create(1,'Everyday card',250000000,from,'card');await db.accounts.create(1,'Cash',20000000,from,'cash');
  const configs=[['New laptop',96000000,22000000,350000,addDays(day,170)],['Summer in Italy',140000000,15000000,400000,addDays(day,130)],['Emergency fund',180000000,75000000,250000,null]] as const;
  for(const [name,target,opening,daily,deadline] of configs)await db.finance.putGoal(1,name,target,deadline,daily,opening,null);
  const goals=await db.finance.goals(1);
  for(let i=0;i<90;i++){
   const date=addDays(from,i);
   for(let n=0;n<goals.length;n++)if(i%(n+3)===0)await db.finance.contribute(1,goals[n]!.id,180000+n*80000+(i>60?180000:0),date,'save-'+n+'-'+i,1);
   if(i%3===0)await db.addTransaction(1,null,1500+(i%7)*550,i%2?'Groceries':'Coffee & lunch',date,1);
   if(i%30===0)await db.income.add(1,'Salary',65000000,date,'salary-'+i,1);
  }
  await db.finance.contribute(1,goals[1]!.id,-420000,addDays(day,-8),'withdraw',2);
  await db.setBudget(1,0,250000);
  const data=await dashboardData(db,1,'Asia/Yerevan',from,day),html=renderDashboard(data,false);
  expect(html).not.toContain('__FINTRACK_GOAL_MODEL__');expect(html).not.toMatch(/https?:\/\/.*\.(?:css|js|woff)/);
  if(process.env.WRITE_PLANNER_HTML)writeFileSync(process.env.WRITE_PLANNER_HTML,html);
 });
});
