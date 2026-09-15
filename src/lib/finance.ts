import type { Db } from '../db';
import { monthOf, monthStart, monthEnd, addDays } from './dates';
import { goalPlan, type Goal } from './savings';

export async function financialStatus(db: Db, user: number, today: string) {
  const from = monthStart(monthOf(today)), to = monthEnd(monthOf(today));
  const [goals,prefs,budget,spent,saved,contributions,income] = await Promise.all([
    db.finance.goals(user),db.finance.preferences(user),db.budget(user,0),db.totalBetween(user,from,to),
    db.finance.savingsTotal(user,from,to),db.finance.goalSavingsOn(user,today),db.income.total(user,from,to),
  ]);
  const remainingDays = Number(to.slice(8))-Number(today.slice(8))+1;
  const available = budget === null ? null : budget*100-spent*100-(prefs.funding==='shared'?saved:0)-prefs.reserve_minor;
  const dailyAllowance = prefs.funding==='shared' && available!==null ? Math.max(0,Math.floor(available/remainingDays)) : Infinity;
  const raw = goals.map(goal=> {
    const paid = Math.max(0,contributions.find(c=>c.goal_id===goal.id)?.total ?? 0);
    const start = goalPlan({...goal,saved_minor:goal.saved_minor-paid},today);
    const need = Math.max(0,Math.min(goal.target_minor-goal.saved_minor,start.required-paid));
    return {goal,paid,need,desired:Math.max(0,Math.min(need,(goal.cap_minor??Infinity)-paid))};
  });
  const totalDesired = raw.reduce((s,p)=>s+p.desired,0);
  const plans = raw.map(({goal,paid,need,desired})=> {
    const allowance = totalDesired>0 && dailyAllowance<totalDesired ? Math.floor(dailyAllowance*desired/totalDesired) : desired;
    const remaining = Math.max(0,goal.target_minor-goal.saved_minor);
    const pace = Math.max(0,Math.min(goal.cap_minor??Infinity, goalPlan(goal,today).required, dailyAllowance===Infinity?Infinity:paid+allowance));
    return {goal,required:need,suggested:allowance,remaining,finish:remaining===0?today:pace>0?addDays(today,Math.ceil(remaining/pace)-1+(allowance===0&&paid>0?1:0)):null,overdue:Boolean(goal.deadline&&goal.deadline<today&&remaining)};
  });
  return {goals,prefs,budget,spent,saved,income,cashFlow:income-spent*100-saved,available,plans};
}
export type GoalStatus = Awaited<ReturnType<typeof financialStatus>>['plans'][number];
export function findGoal(goals: Goal[], name: string) { return goals.find(g=>g.name.toLowerCase()===name.toLowerCase()); }
