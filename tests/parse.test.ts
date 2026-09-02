import { describe, expect, it } from 'vitest';
import { parseAmount, group, pct } from '../src/lib/money';
import { matchCategory, parseEntry, splitEmojiSafe } from './helpers';
import { addDays, monthEnd, monthLabel, parseDateToken, shiftMonth, todayIn } from '../src/lib/dates';

const TZ = 'Asia/Yerevan';
const NOW = new Date('2026-09-14T09:00:00Z');

describe('parseAmount', () => {
  it('reads plain, grouped and suffixed numbers', () => {
    expect(parseAmount('1500')).toBe(1500);
    expect(parseAmount('12,500')).toBe(12500);
    expect(parseAmount('1.5k')).toBe(1500);
    expect(parseAmount('2K')).toBe(2000);
    expect(parseAmount('1m')).toBe(1_000_000);
    expect(parseAmount('999.49')).toBe(999);
  });

  it('rejects non-amounts', () => {
    expect(parseAmount('cafe')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-100')).toBeNull();
    expect(parseAmount('12.34.56')).toBeNull();
  });
});

describe('parseEntry', () => {
  it('takes the amount first or last', () => {
    expect(parseEntry('1500 cafe latte', TZ, NOW)).toMatchObject({
      amount: 1500,
      rest: 'cafe latte',
      spentOn: '2026-09-14',
    });
    expect(parseEntry('cafe 1500', TZ, NOW)).toMatchObject({ amount: 1500, rest: 'cafe' });
  });

  it('consumes a date token anywhere', () => {
    expect(parseEntry('yesterday 2.5k taxi', TZ, NOW)?.spentOn).toBe('2026-09-13');
    expect(parseEntry('12000 groceries 03.09', TZ, NOW)?.spentOn).toBe('2026-09-03');
    expect(parseEntry('12000 groceries 03.09', TZ, NOW)?.rest).toBe('groceries');
  });

  it('returns null without an amount', () => {
    expect(parseEntry('just some words', TZ, NOW)).toBeNull();
  });
});

describe('matchCategory', () => {
  const cats = [
    { id: 1, name: 'Cafe' },
    { id: 2, name: 'Fast food' },
    { id: 3, name: 'Transport' },
  ];

  it('matches exact names, longest first', () => {
    expect(matchCategory('fast food burger', cats)).toMatchObject({
      category: { id: 2 },
      note: 'burger',
    });
    expect(matchCategory('cafe latte', cats)).toMatchObject({ category: { id: 1 }, note: 'latte' });
  });

  it('matches a unique prefix', () => {
    expect(matchCategory('tra metro', cats)).toMatchObject({ category: { id: 3 }, note: 'metro' });
  });

  it('keeps the text as a note when nothing matches', () => {
    expect(matchCategory('pharmacy', cats)).toMatchObject({ category: null, note: 'pharmacy' });
  });
});

describe('dates', () => {
  it('resolves relative tokens in the user timezone', () => {
    expect(parseDateToken('today', TZ, NOW)).toBe('2026-09-14');
    expect(parseDateToken('yesterday', TZ, NOW)).toBe('2026-09-13');
    expect(parseDateToken('31.02', TZ, NOW)).toBeNull();
    expect(parseDateToken('lunch', TZ, NOW)).toBeNull();
  });

  it('rolls a future day/month back a year', () => {
    expect(parseDateToken('20.12', TZ, NOW)).toBe('2025-12-20');
  });

  it('walks months and month ends', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2026-09')).toBe('2026-09-30');
    expect(monthLabel('2026-09')).toBe('September 2026');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('uses the timezone for "today"', () => {
    // 23:30 UTC is already the next day in Yerevan (UTC+4).
    expect(todayIn(TZ, new Date('2026-09-14T23:30:00Z'))).toBe('2026-09-15');
  });
});

describe('formatting', () => {
  it('groups thousands and computes shares', () => {
    expect(group(1234567)).toBe('1,234,567');
    expect(pct(25, 200)).toBe(13);
    expect(pct(1, 0)).toBe(0);
  });
});

describe('splitEmoji', () => {
  it('peels a leading emoji off the name', () => {
    expect(splitEmojiSafe('🎁 Gifts')).toEqual({ emoji: '🎁', name: 'Gifts' });
    expect(splitEmojiSafe('Gifts')).toEqual({ emoji: '', name: 'Gifts' });
  });
});
