/** All date handling is done on YYYY-MM-DD strings in the user's timezone. */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function todayIn(tz: string, at: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "2026-09-14" -> "2026-09" */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** "2026-09" shifted by delta months. */
export function shiftMonth(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthStart(period: string): string {
  return `${period}-01`;
}

export function monthEnd(period: string): string {
  return addDays(monthStart(shiftMonth(period, 1)), -1);
}

export function daysInMonth(period: string): number {
  return Number(monthEnd(period).slice(8));
}

export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8));
}

export function prettyDate(date: string): string {
  const [y, m, d] = date.split('-') as [string, string, string];
  return `${d}.${m}.${y}`;
}

/**
 * Leading date token in a quick entry: today | yesterday | dd.mm | dd.mm.yyyy | dd/mm.
 * Returns null when the token is not a date.
 */
export function parseDateToken(token: string, tz: string, now: Date = new Date()): string | null {
  const t = token.toLowerCase();
  const today = todayIn(tz, now);
  if (t === 'today' || t === 'td' || t === 'сегодня' || t === 'այսօր') return today;
  if (t === 'yesterday' || t === 'yst' || t === 'вчера' || t === 'երեկ') return addDays(today, -1);

  const m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Reject 31.02 and friends.
  const back = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso) return null;
  // A bare dd.mm in the future means last year.
  if (!m[3] && iso > today) return `${year - 1}-${iso.slice(5)}`;
  return iso;
}
