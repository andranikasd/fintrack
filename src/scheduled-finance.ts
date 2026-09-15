import { uncategorizedKeyboard } from './handlers/category-review';
import type { Api } from 'grammy';
import { InputFile } from 'grammy';
import type { Db } from './db';
import { todayIn, addDays } from './lib/dates';
import { financialStatus } from './lib/finance';
import { minorMoney } from './lib/savings';
import { reminderKeyboard } from './handlers/goals';
import { dailyReport } from './handlers/daily';
import { dashboardData } from './web/data';
import { renderDashboard } from './web/render';

export function localTime(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
}
export async function runFinanceSchedule(db:Db,api:Api,user:{id:number;tz:string},sign:string,now=new Date()) {
  const today=todayIn(user.tz,now),time=localTime(user.tz,now),prefs=await db.finance.preferences(user.id);
  const deliver=async(kind:string,work:()=>Promise<void>)=> {
    if (!await db.finance.claimDelivery(user.id,today,kind,Math.floor(now.getTime()/1000))) return;
    try { await work(); await db.finance.finishDelivery(user.id,today,kind,true); }
    catch(err) { await db.finance.finishDelivery(user.id,today,kind,false); console.error('finance delivery failed',kind,user.id,err); }
  };
  if(prefs.reminder_time&&time>=prefs.reminder_time) {
    const status=await financialStatus(db,user.id,today);
    for(const plan of status.plans) if(plan.suggested>0) await deliver(`goal:${plan.goal.id}`,async()=> {
      const reminder=await db.finance.reminder(user.id,plan.goal.id,today,plan.suggested);
      if(reminder.status!=='pending') return;
      await api.sendMessage(user.id,`${plan.goal.name} · ${today}\nSuggested savings transfer: ${minorMoney(reminder.amount_minor,sign)}\nConfirm only after moving the money. If recorded in your table or /save, skip this reminder to avoid entering it twice.`,{reply_markup:reminderKeyboard(reminder.id)});
    });
  }
  if(prefs.summary_time&&time>=prefs.summary_time) {
    await deliver('daily-summary',async()=> {await api.sendMessage(user.id,await dailyReport(db,user.id,today,today,sign), { reply_markup: await uncategorizedKeyboard(db,user.id,today) });});
    await deliver('daily-chart',async()=> {
      const data=await dashboardData(db,user.id,user.tz,addDays(today,-6),today);
      const bytes=new TextEncoder().encode(renderDashboard(data,false));
      await api.sendDocument(user.id,new InputFile(bytes,`fintrack-week-${today}.html`),{caption:'Interactive weekly report: income, spending, savings and categories. Open this HTML file in a browser. Today is still in progress.'});
    });
  }
}
