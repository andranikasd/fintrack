import type { Api } from 'grammy';
import { runFinanceSchedule } from './scheduled-finance';
import { Db, OVERALL } from './db';
import { monthLabel, monthOf, shiftMonth, todayIn } from './lib/dates';
import { monthReport, richMonthReport } from './handlers/stats';
import { money } from './lib/money';
import type { Env } from './types';

export async function runScheduled(env: Env, api: Api): Promise<void> {
  const db = new Db(env.DB, env.DEFAULT_TZ || 'Asia/Yerevan');

  const sign = env.CURRENCY_SIGN || '֏';
  for (const user of await db.listUsers()) {
    const today = todayIn(user.tz);
    const allowlist = (env.ALLOWED_USER_IDS ?? '').split(',').map(s=>Number(s.trim())).filter(n=>n>0);
    if (allowlist.length && !allowlist.includes(user.id)) continue;
    try { await runFinanceSchedule(db,api,user,sign); }
    catch (err) { console.error('finance schedule failed',user.id,err); }
    if (!today.endsWith('-01')) continue;
    if (!await db.finance.claimDelivery(user.id,today,'monthly',Math.floor(Date.now()/1000))) continue;

    const closed = shiftMonth(monthOf(today), -1);
    try {
      const report = await monthReport(db, user.id, closed, user.tz, sign);
      const limit = await db.budget(user.id, OVERALL);
      const tail = limit
        ? `\n\nNew month, budget back to ${money(limit, sign)}.`
        : '\n\nNew month. Set a limit with /budget.';
      await api.sendRichMessage(user.id, richMonthReport(`📅 <b>${monthLabel(closed)} closed</b>\n\n${report}${tail}`), {
        reply_markup: {
          inline_keyboard: [[{ text: '📄 PDF report', callback_data: `export:pdf:${closed}` }]],
        },
      });
      await db.finance.finishDelivery(user.id,today,'monthly',true);
    } catch (err) {
      await db.finance.finishDelivery(user.id,today,'monthly',false);
      console.error('monthly summary failed', user.id, err);
    }
  }
}
