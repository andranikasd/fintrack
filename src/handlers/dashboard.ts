import { Composer, InputFile } from 'grammy';
import type { AppContext } from '../context';
import { dashboardData } from '../web/data';
import { renderDashboard } from '../web/render';
import { todayIn, addDays } from '../lib/dates';

export const dashboard = new Composer<AppContext>();
export async function sendDashboard(ctx:AppContext, days = 90):Promise<void> {
  const to=todayIn(ctx.tz), from=addDays(to,1-days);
  let data;
  try { data=await dashboardData(ctx.db,ctx.userId,ctx.tz,from,to); }
  catch(error) { await ctx.reply(error instanceof Error?error.message:'Could not generate that report. Try a shorter period.'); return; }
  await ctx.api.sendDocument(ctx.chat!.id,new InputFile(new TextEncoder().encode(renderDashboard(data,false,ctx.me.username)),`fintrack-${to}.html`),{
    caption:`Interactive HTML report · last ${days} days. Include or exclude categories and items, compare months, or choose Edit in Telegram on a record. This is a read-only snapshot; export again after corrections.`,
  });
}
dashboard.command('dashboard',ctx=>sendDashboard(ctx));
dashboard.command('chart',async ctx=>{
  const arg=ctx.match.trim()||'30';
  if (!/^\d+$/.test(arg)||Number(arg)<1||Number(arg)>366) { await ctx.reply('Use /chart 7, /chart 30, or a range from 1 to 366 days.'); return; }
  await sendDashboard(ctx,Number(arg));
});
