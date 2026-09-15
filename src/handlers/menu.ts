import { Composer } from 'grammy';
import type { AppContext } from '../context';
import { renderBudgets } from './budget';
import { renderList } from './categories';
import { sendAccounts } from './income';
import { undoLast, sendRecent } from './entry';
import { sendExportMenu } from './export';
import { sendMonth, sendStats } from './stats';

/** Reply-keyboard buttons, routed to the same code as the commands. */
export const menu = new Composer<AppContext>();

menu.hears('📊 Month', sendMonth);
menu.hears('📈 Stats', sendStats);
menu.hears('🗂 Categories', async (ctx) => renderList(ctx));
menu.hears('🎯 Budget', async (ctx) => renderBudgets(ctx));
menu.hears('📄 Export', sendExportMenu);
menu.hears('↩️ Undo', undoLast);

menu.hears('🧾 Recent',ctx=>sendRecent(ctx));
menu.hears('🏦 Accounts',sendAccounts);
menu.callbackQuery('reports:month',async ctx=>{await ctx.answerCallbackQuery();await sendMonth(ctx);});
menu.callbackQuery('reports:stats',async ctx=>{await ctx.answerCallbackQuery();await sendStats(ctx);});
