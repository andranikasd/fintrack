import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { AppContext } from '../context';
import { DashboardAuth } from '../web/auth';
import { dashboardData } from '../web/data';
import { renderDashboard } from '../web/render';
import { todayIn, addDays } from '../lib/dates';

export const dashboard = new Composer<AppContext>();
export async function sendDashboard(ctx:AppContext, days = 90):Promise<void> {
  const arg=typeof ctx.match==='string'?ctx.match.trim():'';
  const to=todayIn(ctx.tz), from=addDays(to,1-days);
  if (ctx.env.DASHBOARD_URL && arg!=='html') {
    const token=await new DashboardAuth(ctx.env.DB).issue(ctx.userId,'login');
    const url=`${ctx.env.DASHBOARD_URL.replace(/\/$/,'')}/dashboard?from=${from}&to=${to}#login=${token}`;
    await ctx.reply('Open your private dashboard to explore charts, manage categories, and record income. This sign-in link works once and expires in 10 minutes.',{
      reply_markup:new InlineKeyboard().url('Open dashboard',url),
    });
    return;
  }
  let data;
  try { data=await dashboardData(ctx.db,ctx.userId,ctx.tz,from,to); }
  catch(error) { await ctx.reply(error instanceof Error?error.message:'Could not generate that report. Try a shorter period.'); return; }
  await ctx.api.sendDocument(ctx.chat!.id,new InputFile(new TextEncoder().encode(renderDashboard(data,false)),`fintrack-${to}.html`),{
    caption:`Interactive HTML report · last ${days} days. Open in a browser to filter dates, categories and charts. This snapshot cannot change your saved records. /dashboard opens the live version when configured.`,
  });
}
dashboard.command('dashboard',ctx=>sendDashboard(ctx));
dashboard.command('chart',async ctx=>{
  const arg=ctx.match.trim()||'30';
  if (!/^\d+$/.test(arg)||Number(arg)<1||Number(arg)>366) { await ctx.reply('Use /chart 7, /chart 30, or a range from 1 to 366 days.'); return; }
  await sendDashboard(ctx,Number(arg));
});
