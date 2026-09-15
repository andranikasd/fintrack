import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { AppContext } from '../context';
import { DashboardAuth } from '../web/auth';
import { dashboardData } from '../web/data';
import { renderDashboard } from '../web/render';
import { todayIn, addDays } from '../lib/dates';

export const dashboard = new Composer<AppContext>();
export async function sendDashboard(ctx:AppContext):Promise<void> {
  const arg=typeof ctx.match==='string'?ctx.match.trim():'';
  if (ctx.env.DASHBOARD_URL && arg!=='html') {
    const token=await new DashboardAuth(ctx.env.DB).issue(ctx.userId,'login');
    const url=`${ctx.env.DASHBOARD_URL.replace(/\/$/,'')}/dashboard#login=${token}`;
    await ctx.reply('Open your private dashboard to explore charts, manage categories, and record income. This sign-in link works once and expires in 10 minutes.',{
      reply_markup:new InlineKeyboard().url('Open dashboard',url),
    });
    return;
  }
  const to=todayIn(ctx.tz), from=addDays(to,-89);
  const data=await dashboardData(ctx.db,ctx.userId,ctx.tz,from,to);
  await ctx.api.sendDocument(ctx.chat!.id,new InputFile(new TextEncoder().encode(renderDashboard(data,false)),`fintrack-${to}.html`),{
    caption:'Interactive HTML report · last 90 days. Open in a browser to filter dates, categories and charts. This snapshot cannot change your saved records. /dashboard opens the live version when configured.',
  });
}
dashboard.command('dashboard',sendDashboard);
