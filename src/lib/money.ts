const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** 12500 -> "12,500" */
export function group(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(Math.round(n))).replace(GROUP, ',');
}

/** For Telegram messages: "12,500 ֏" */
export function money(n: number, sign = '֏'): string {
  return `${group(n)} ${sign}`;
}

/** For the PDF: the dram sign is missing from most embeddable fonts. */
export function moneyPlain(n: number, code = 'AMD'): string {
  return `${group(n)} ${code}`;
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

const AMOUNT_RE =
  /^(?<num>\d{1,3}(?:[ ,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?<suffix>[kKկԿ]|[mM])?$/u;

/**
 * "1500" | "1,500" | "1.5k" | "12500.50" -> whole drams.
 * Returns null when the token is not an amount.
 */
export function parseAmount(token: string): number | null {
  const m = AMOUNT_RE.exec(token.trim());
  if (!m?.groups) return null;
  const raw = m.groups['num']!.replace(/[ ,](?=\d{3}\b)/g, '').replace(',', '.');
  let value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = m.groups['suffix'];
  if (suffix) value *= /[mM]/.test(suffix) ? 1_000_000 : 1_000;
  const drams = Math.round(value);
  if (drams <= 0 || drams > 1_000_000_000) return null;
  return drams;
}
