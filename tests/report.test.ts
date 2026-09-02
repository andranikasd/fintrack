import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildReport, type ReportData } from '../src/pdf/report';
import { sanitize, fit } from '../src/pdf/font';
import type { CategoryTotal, TxWithCategory } from '../src/types';

const CATEGORIES = ['Groceries', 'Cafe', 'Transport', 'Rent', 'Առողջություն', 'Fun'];

function fixture(): ReportData {
  const byCategory: CategoryTotal[] = CATEGORIES.map((name, i) => ({
    category_id: i + 1,
    name,
    emoji: '🛒',
    total: 120_000 - i * 15_000,
    count: 10 - i,
  }));

  const transactions: TxWithCategory[] = [];
  for (let day = 1; day <= 30; day++) {
    for (let n = 0; n < 3; n++) {
      const cat = (day + n) % CATEGORIES.length;
      transactions.push({
        id: transactions.length + 1,
        user_id: 1,
        category_id: cat + 1,
        amount: 1000 + ((day * 7 + n * 13) % 20) * 500,
        note: n === 0 ? 'lunch with a very long note that has to be cut somewhere' : 'սուրճ',
        spent_on: `2026-09-${String(day).padStart(2, '0')}`,
        created_at: '2026-09-01 10:00:00',
        category_name: CATEGORIES[cat]!,
        category_emoji: '🛒',
      });
    }
  }

  const byDay = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, '0')}`,
    total: 3000 + ((i * 37) % 9) * 2500,
  }));

  return {
    periodLabel: 'September 2026',
    from: '2026-09-01',
    to: '2026-09-30',
    total: byCategory.reduce((a, c) => a + c.total, 0),
    byCategory,
    byDay,
    byMonth: [
      { period: '2026-04', total: 380_000 },
      { period: '2026-05', total: 410_000 },
      { period: '2026-06', total: 350_000 },
      { period: '2026-07', total: 505_000 },
      { period: '2026-08', total: 460_000 },
      { period: '2026-09', total: 495_000 },
    ],
    budgetOverall: 450_000,
    categoryBudgets: new Map([[1, 100_000], [2, 30_000]]),
    transactions,
    currency: 'AMD',
    generatedOn: '2026-09-30',
    singleMonth: '2026-09',
  };
}

describe('PDF report', () => {
  it('renders a multi-page document with charts and tables', async () => {
    const bytes = await buildReport(fixture());
    expect(bytes.byteLength).toBeGreaterThan(5_000);

    const head = new TextDecoder().decode(bytes.slice(0, 8));
    expect(head.startsWith('%PDF-')).toBe(true);

    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(reloaded.getTitle()).toContain('September 2026');

    if (process.env['WRITE_PDF']) writeFileSync(process.env['WRITE_PDF'], bytes);
  });

  it('survives an empty period', async () => {
    const empty: ReportData = {
      ...fixture(),
      total: 0,
      byCategory: [],
      byDay: [],
      transactions: [],
      budgetOverall: 0,
    };
    const bytes = await buildReport(empty);
    expect(bytes.byteLength).toBeGreaterThan(1_000);
  });
});

describe('font safety', () => {
  it('drops glyphs the embedded subset does not carry', () => {
    expect(sanitize('🛒 Groceries')).toBe('Groceries');
    expect(sanitize('Առողջություն')).toBe('Առողջություն');
    expect(sanitize('Кафе')).toBe('Кафе');
  });

  it('truncates to the available width', () => {
    const font = { widthOfTextAtSize: (t: string, s: number) => t.length * s * 0.5 };
    expect(fit('a'.repeat(100), font, 10, 50).endsWith('...')).toBe(true);
    expect(fit('short', font, 10, 500)).toBe('short');
  });
});
