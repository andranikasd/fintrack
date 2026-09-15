import { addDays } from './dates';

/** Exact hundredths of AMD. Grouped thousands and k/m are accepted; no floats in storage. */
export function parseMinor(raw: string, allowZero = false): number | null {
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?([km])?$/i.exec(raw.trim());
  if (!match) return null;
  const value = (Number(match[1]!.replaceAll(',', '')) * 100 + Number((match[2] ?? '').padEnd(2, '0'))) *
    (match[3]?.toLowerCase() === 'k' ? 1000 : match[3]?.toLowerCase() === 'm' ? 1000000 : 1);
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= 100_000_000_000 ? value : null;
}
export function minorMoney(value: number, currency = '֏'): string {
  return `${(value / 100).toLocaleString('en-US', { minimumFractionDigits: value % 100 ? 2 : 0, maximumFractionDigits: 2 })} ${currency}`;
}
export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}
export interface Goal {
  id: number; user_id: number; name: string; target_minor: number; opening_minor: number;
  deadline: string | null; daily_minor: number | null; cap_minor: number | null; saved_minor: number;
}
export function goalPlan(goal: Goal, today: string, allowance = Infinity) {
  const remaining = Math.max(0, goal.target_minor - goal.saved_minor);
  const days = goal.deadline ? Math.max(1, Math.round((Date.parse(goal.deadline) - Date.parse(today)) / 86400000) + 1) : null;
  const required = remaining === 0 ? 0 : days ? Math.ceil(remaining / days) : Math.min(remaining, goal.daily_minor ?? 0);
  const suggested = Math.max(0, Math.min(remaining, required, goal.cap_minor ?? Infinity, Math.floor(allowance)));
  const finish = remaining === 0 ? today : suggested > 0 ? addDays(today, Math.ceil(remaining / suggested) - 1) : null;
  return { remaining, required, suggested, finish, overdue: Boolean(goal.deadline && goal.deadline < today && remaining) };
}
