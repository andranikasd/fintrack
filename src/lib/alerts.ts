import type { Api } from 'grammy';
import { OVERALL, type Db } from '../db';
import { monthEnd, monthLabel, monthStart, monthOf, daysInMonth, dayOfMonth } from './dates';
import { money, pct } from './money';

/** Percent marks that trigger a message, once each per month and scope. */
export const THRESHOLDS = [80, 100, 120, 150, 200] as const;

export interface AlertScope {
  categoryId: number; // OVERALL for the whole month
  label: string;
  spent: number;
  budget: number;
}

function highestCrossed(spent: number, budget: number): number | null {
  const percent = (spent / budget) * 100;
  let hit: number | null = null;
  for (const t of THRESHOLDS) if (percent >= t) hit = t;
  return hit;
}

function alertText(scope: AlertScope, threshold: number, sign: string, period: string): string {
  const left = scope.budget - scope.spent;
  const head =
    threshold < 100
      ? `⚠️ <b>${threshold}% of the ${scope.label} budget used</b>`
      : threshold === 100
        ? `🚨 <b>${scope.label} budget reached</b>`
        : `🔥 <b>${scope.label} budget blown — ${pct(scope.spent, scope.budget)}%</b>`;

  const lines = [
    head,
    `${monthLabel(period)}`,
    `Spent: <b>${money(scope.spent, sign)}</b> of ${money(scope.budget, sign)}`,
    left >= 0 ? `Left: <b>${money(left, sign)}</b>` : `Over by: <b>${money(-left, sign)}</b>`,
  ];
  return lines.join('\n');
}

/**
 * Checks every budget touched by a transaction and sends at most one message
 * per scope. Alerts are de-duplicated per (month, scope, threshold) in D1.
 */
export async function checkBudgets(
  db: Db,
  api: Api,
  userId: number,
  chatId: number,
  spentOn: string,
  categoryId: number | null,
  sign: string,
): Promise<void> {
  const period = monthOf(spentOn);
  const from = monthStart(period);
  const to = monthEnd(period);

  const scopes: AlertScope[] = [];

  const overall = await db.budget(userId, OVERALL);
  if (overall && overall > 0) {
    scopes.push({
      categoryId: OVERALL,
      label: 'monthly',
      spent: await db.totalBetween(userId, from, to),
      budget: overall,
    });
  }

  if (categoryId !== null) {
    const catBudget = await db.budget(userId, categoryId);
    if (catBudget && catBudget > 0) {
      const category = await db.category(userId, categoryId);
      scopes.push({
        categoryId,
        label: category ? `${category.emoji} ${category.name}`.trim() : 'category',
        spent: await db.totalForCategory(userId, categoryId, from, to),
        budget: catBudget,
      });
    }
  }

  for (const scope of scopes) {
    const threshold = highestCrossed(scope.spent, scope.budget);
    if (threshold === null) continue;
    const fresh = await db.claimAlert(userId, period, scope.categoryId, threshold);
    if (!fresh) continue;
    await api.sendMessage(chatId, alertText(scope, threshold, sign, period), {
      parse_mode: 'HTML',
    });
  }
}

/** Pace line shown after each entry: how the month is tracking against budget. */
export function paceLine(
  spent: number,
  budget: number,
  today: string,
  sign: string,
): string | null {
  if (budget <= 0) return null;
  const period = monthOf(today);
  const days = daysInMonth(period);
  const day = dayOfMonth(today);
  const left = budget - spent;
  const daysLeft = Math.max(1, days - day + 1);
  const perDay = Math.max(0, Math.floor(left / daysLeft));
  const bar = progressBar(spent, budget);
  return left >= 0
    ? `${bar} ${pct(spent, budget)}% · left ${money(left, sign)} · ${money(perDay, sign)}/day for ${daysLeft}d`
    : `${bar} ${pct(spent, budget)}% · over by ${money(-left, sign)}`;
}

export function progressBar(spent: number, budget: number, width = 10): string {
  if (budget <= 0) return '';
  const filled = Math.max(0, Math.min(width, Math.round((spent / budget) * width)));
  const over = spent > budget;
  return `${(over ? '🟥' : '🟩').repeat(filled)}${'⬜'.repeat(width - filled)}`;
}
