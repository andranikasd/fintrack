import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { todayIn } from '../lib/dates';
import { findGoal, financialStatus, type GoalStatus } from '../lib/finance';
import { minorMoney, parseMinor, validDate } from '../lib/savings';

export const goals = new Composer<AppContext>();
export function goalText(p: GoalStatus, sign: string): string {
  const g = p.goal;
  return `🎯 ${g.name}\nSaved: ${minorMoney(g.saved_minor,sign)} / ${minorMoney(g.target_minor,sign)} (${Math.round(g.saved_minor/g.target_minor*1000)/10}%)\nRemaining: ${minorMoney(p.remaining,sign)}\n` +
    `Plan: ${g.deadline ? `by ${g.deadline}` : `at ${minorMoney(g.daily_minor ?? 0,sign)} per day`}${g.cap_minor !== null ? ` · cap ${minorMoney(g.cap_minor,sign)}` : ''}\n` +
    (p.remaining===0 ? 'Goal reached!' : `Suggested today: ${minorMoney(p.suggested,sign)}\n${g.deadline?`Required today for ${g.deadline}: ${minorMoney(p.required,sign)}\n`:''}` +
    (p.suggested<p.required ? 'Your budget or daily cap limits the contribution.\n' : '') +
    (p.overdue ? 'Deadline has passed. Update the plan.\n' : '') +
    (p.finish ? `Estimated finish at this pace: ${p.finish}` : 'No contribution available at the current limit.'));
}
const USAGE = `🎯 Savings goals
Create or update a goal (amounts are AMD):
/goal laptop | 960,381.77 | 2027-03-15 | 0 | 6000
/goal laptop 960381.77 2027-03-15 0 6000
Name | target | deadline YYYY-MM-DD OR daily:3000 | starting saved | optional daily cap

Workflow: run /goal to see how much to set aside today, move that money yourself, then confirm it with /save laptop 5500. Use /withdraw laptop 2000 when money comes back out. Confirmed saves update the goal; they do not move money automatically.
/funding shared 20000 — include confirmed savings in your monthly spending limit and protect a 20,000 reserve
/funding separate — savings have separate funding (default)
/remind 20:00 — daily savings reminder in your timezone
/summary 21:00 — daily spending summary
Use off instead of a time to disable.`;

/** Parse the documented pipe form and the shorter space-separated form.
 * For the latter, the plan token (a date or daily: amount) marks the boundary
 * so goal names may still contain spaces or numbers.
 */
function goalParts(arg: string): string[] | null {
  if (arg.includes('|')) return arg.split('|').map(x => x.trim());
  const tokens = arg.split(/\s+/).filter(Boolean);
  const planIndex = tokens.findIndex((token, index) => index > 0 && (validDate(token) || /^daily:/i.test(token)));
  if (planIndex < 2) return null;
  return [tokens.slice(0, planIndex - 1).join(' '), tokens[planIndex - 1]!, tokens[planIndex]!, ...tokens.slice(planIndex + 1)];
}

goals.command('goal', async ctx => {
  const arg = ctx.match.trim();
  if (arg) {
    const parts = goalParts(arg);
    if (!parts) { await ctx.reply(USAGE); return; }
    const [name,targetRaw,plan,openingRaw,capRaw] = parts;
    const target = parseMinor(targetRaw??'');
    const opening = parseMinor(openingRaw??'0',true);
    const cap = capRaw ? parseMinor(capRaw) : null;
    const deadline = plan && validDate(plan) ? plan : null;
    const daily = plan?.match(/^daily:(.+)$/i) ? parseMinor(plan.slice(6)) : null;
    if (parts.length<3 || parts.length>5 || !name || !/^[\p{L}\p{N} _-]{1,40}$/u.test(name) || target===null || opening===null || (capRaw && cap===null) || (!deadline&&!daily) || (deadline && deadline<todayIn(ctx.tz))) {
      await ctx.reply(USAGE); return;
    }
    await ctx.db.finance.putGoal(ctx.userId,name,target,deadline,daily,opening,cap);
  }
  const status = await financialStatus(ctx.db,ctx.userId,todayIn(ctx.tz));
  if (!status.plans.length) { await ctx.reply(USAGE); return; }
  for (const plan of status.plans) await ctx.reply(goalText(plan,ctx.sign));
  await ctx.reply(`Funding: ${status.prefs.funding}. Reserve: ${minorMoney(status.prefs.reserve_minor,ctx.sign)}.\nAmounts are plans, not automatic transfers. /save confirms money actually moved.\n/goalhelp for setup and preferences.`);
});
goals.command('goalhelp',ctx=>ctx.reply(USAGE));
for (const command of ['save','withdraw'] as const) goals.command(command,async ctx=> {
  const m = /^(.+?)\s+([\d,.]+[km]?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/i.exec(ctx.match.trim());
  const amount = m ? parseMinor(m[2]!) : null;
  const day = m?.[3] ?? todayIn(ctx.tz);
  if (!m || amount===null || !validDate(day) || day>todayIn(ctx.tz)) { await ctx.reply(`Use /${command} laptop 5500, optionally followed by YYYY-MM-DD.`); return; }
  const goal = findGoal(await ctx.db.finance.goals(ctx.userId),m[1]!);
  if (!goal) { await ctx.reply('Unknown goal. Create one with /goal.'); return; }
  const ok = await ctx.db.finance.contribute(ctx.userId,goal.id,amount*(command==='withdraw'?-1:1),day,`message:${ctx.chat.id}:${ctx.message!.message_id}`);
  await ctx.reply(ok ? `${command==='save'?'Saved':'Withdrawn'} ${minorMoney(amount,ctx.sign)} for ${goal.name} on ${day}. /goal shows the updated plan.` : 'Already recorded, or withdrawal exceeds the saved balance.');
});
goals.command('funding',async ctx=> {
  const [mode,reserveRaw,...extra] = ctx.match.trim().split(/\s+/);
  const reserve = parseMinor(reserveRaw??'0',true);
  if (!['shared','separate'].includes(mode??'') || reserve===null || extra.length) { await ctx.reply('Use /funding shared 20000 or /funding separate. The optional reserve protects money for upcoming bills.'); return; }
  await ctx.db.finance.setFunding(ctx.userId,mode!,reserve);
  await ctx.reply(`Savings funding: ${mode}. Protected reserve: ${minorMoney(reserve,ctx.sign)}. Shared funding reduces the monthly spending allowance by confirmed net savings. Separate funding keeps /budget as a spending-only limit.`);
});
for (const [command,kind] of [['remind','reminder'],['summary','summary']] as const) goals.command(command,async ctx=> {
  const time = ctx.match.trim();
  if (time !== 'off' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { await ctx.reply(`Use /${command} 20:00 or /${command} off. Timezone: ${ctx.tz}.`); return; }
  await ctx.db.finance.setTime(ctx.userId,kind,time==='off'?null:time);
  await ctx.reply(time==='off'?`${kind} disabled.`:`${kind} set for ${time} (${ctx.tz}), delivered within about 5 minutes.`);
});
goals.command('alias',async ctx=> {
  const [labelsRaw,category,...extra] = ctx.match.split('|').map(x=>x.trim());
  const cat = (await ctx.db.categories(ctx.userId)).find(c=>c.name.toLowerCase()===category?.toLowerCase());
  const labels = (labelsRaw ?? '').split(',').map(label => label.trim()).filter(Boolean);
  if (!labels.length || labels.some(label => label.length > 120) || !cat || extra.length) { await ctx.reply('Use /alias chatgpt, cigarette, coffee | Personal. This categorizes matching rows and remembers the rule for future entries.'); return; }
  for (const label of labels) await ctx.db.finance.alias(ctx.userId,label,cat.id);
  await ctx.reply(`${labels.join(', ')} → ${cat.name}. Future matching entries will be categorized automatically.`);
});
export function reminderKeyboard(id: number) {
  return new InlineKeyboard().text('Saved it',`saving:yes:${id}`).text('Different amount',`saving:other:${id}`).row().text('Skip today',`saving:skip:${id}`);
}
goals.callbackQuery(/^saving:(yes|other|skip):(\d+)$/,async ctx=> {
  const id = Number(ctx.match[2]);
  const reminder = await ctx.db.finance.getReminder(ctx.userId,id);
  if (!reminder || reminder.status!=='pending') { await ctx.answerCallbackQuery({text:'Already handled.'}); return; }
  await ctx.answerCallbackQuery();
  if (ctx.match[1]==='other') {
    await ctx.db.setState(ctx.userId,'saving_amount',{id});
    await ctx.reply(`How much did you transfer on ${reminder.day}? Send an amount, or /cancel.`); return;
  }
  const ok = await ctx.db.finance.resolveReminder(ctx.userId,id,ctx.match[1]==='skip'?null:reminder.amount_minor);
  await ctx.editMessageText(ok ? (ctx.match[1]==='skip'?'Skipped. The next plan will recalculate.':`Confirmed ${minorMoney(reminder.amount_minor,ctx.sign)} on ${reminder.day}.`) : 'Savings changed since this reminder. Use /goal to refresh; record any additional transfer with /save.');
});
goals.on('message:text',async (ctx,next)=> {
  if (ctx.message.text.startsWith('/')) return next();
  const state = await ctx.db.getState(ctx.userId);
  if (state?.state!=='saving_amount') return next();
  const amount = parseMinor(ctx.message.text);
  if (amount===null) { await ctx.reply('Send a positive amount, e.g. 5500 or /cancel.'); return; }
  const id = Number(state.payload.id);
  const ok = await ctx.db.finance.resolveReminder(ctx.userId,id,amount);
  await ctx.db.clearState(ctx.userId);
  await ctx.reply(ok?`Confirmed ${minorMoney(amount,ctx.sign)}. /goal for progress.`:'Already handled, or savings changed since this reminder. Use /goal and /save for an additional transfer.');
});
