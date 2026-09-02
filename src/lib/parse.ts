import { parseAmount } from './money';
import { parseDateToken, todayIn } from './dates';

export interface ParsedEntry {
  amount: number;
  /** Everything that was not the amount or the date: category guess + note. */
  rest: string;
  spentOn: string;
  /** True when the user typed an explicit date token. */
  datedExplicitly: boolean;
}

/**
 * Quick entry grammar, order-free:
 *   "1500 food lunch"  "food 1500"  "yesterday 2.5k taxi"  "12,500 rent"
 * The first amount-looking token wins; a date token anywhere is consumed.
 */
export function parseEntry(text: string, tz: string, now: Date = new Date()): ParsedEntry | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let amount: number | null = null;
  let spentOn: string | null = null;
  const rest: string[] = [];

  for (const token of tokens) {
    if (amount === null) {
      const parsed = parseAmount(token);
      if (parsed !== null) {
        amount = parsed;
        continue;
      }
    }
    if (spentOn === null) {
      const date = parseDateToken(token, tz, now);
      if (date !== null) {
        spentOn = date;
        continue;
      }
    }
    rest.push(token);
  }

  if (amount === null) return null;
  return {
    amount,
    rest: rest.join(' '),
    spentOn: spentOn ?? todayIn(tz, now),
    datedExplicitly: spentOn !== null,
  };
}

const EMOJI_AND_PUNCT = /[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]/gu;

export function normalizeName(name: string): string {
  return name.replace(EMOJI_AND_PUNCT, '').trim().replace(/\s+/g, ' ');
}

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_AND_PUNCT, '').trim();
}

export interface NameMatchable {
  id: number;
  name: string;
}

/**
 * Matches the leading words of `rest` against category names.
 * Tries the longest prefix first, so "fast food lunch" beats "food".
 * Returns the matched category plus the leftover note.
 */
export function matchCategory<T extends NameMatchable>(
  rest: string,
  categories: readonly T[],
): { category: T | null; note: string } {
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { category: null, note: '' };

  const byName = new Map<string, T>();
  for (const c of categories) byName.set(c.name.toLowerCase(), c);

  for (let take = Math.min(3, words.length); take >= 1; take--) {
    const candidate = words.slice(0, take).join(' ').toLowerCase();
    const exact = byName.get(candidate);
    if (exact) return { category: exact, note: words.slice(take).join(' ') };
  }

  // Fall back to a unique prefix match on the first word ("tra" -> Transport).
  const first = words[0]!.toLowerCase();
  if (first.length >= 2) {
    const hits = categories.filter((c) => c.name.toLowerCase().startsWith(first));
    if (hits.length === 1) return { category: hits[0]!, note: words.slice(1).join(' ') };
  }

  return { category: null, note: words.join(' ') };
}
