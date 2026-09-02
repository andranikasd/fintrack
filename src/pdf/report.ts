import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { daysInMonth, monthLabel, prettyDate } from '../lib/dates';
import { group, moneyPlain, pct } from '../lib/money';
import type { CategoryTotal, TxWithCategory } from '../types';
import {
  GRID,
  INK,
  MUTED,
  OVER,
  PANEL,
  color,
  drawColumns,
  drawDonut,
  drawLegend,
  drawLineChart,
  type Slice,
} from './charts';
import { FONT_BOLD, FONT_REGULAR, fit, sanitize } from './font';

export interface ReportData {
  periodLabel: string;
  from: string;
  to: string;
  total: number;
  byCategory: CategoryTotal[];
  byDay: Array<{ day: string; total: number }>;
  byMonth: Array<{ period: string; total: number }>;
  budgetOverall: number;
  categoryBudgets: Map<number, number>;
  transactions: TxWithCategory[];
  currency: string;
  generatedOn: string;
  singleMonth: string | null; // "YYYY-MM" when the report covers one month
}

const A4: [number, number] = [595.28, 841.89];
const M = 40; // page margin
const MAX_TX_ROWS = 600;

interface Ctx {
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
  data: ReportData;
}

export async function buildReport(data: ReportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  let regular: PDFFont;
  let bold: PDFFont;
  try {
    regular = await doc.embedFont(FONT_REGULAR, { subset: true });
    bold = await doc.embedFont(FONT_BOLD, { subset: true });
  } catch {
    regular = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  doc.setTitle(`FinTrack — ${data.periodLabel}`);
  doc.setCreator('FinTrack');
  doc.setProducer('FinTrack');

  const ctx: Ctx = { doc, regular, bold, data };
  drawOverviewPage(ctx);
  const cursor = drawBreakdownPage(ctx);
  drawTransactionPages(ctx, cursor);
  numberPages(ctx);

  return await doc.save();
}

// --------------------------------------------------------------------- pages

function newPage(ctx: Ctx): PDFPage {
  const page = ctx.doc.addPage(A4);
  return page;
}

function header(ctx: Ctx, page: PDFPage, title: string): number {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: height - 78, width, height: 78, color: PANEL });
  page.drawText(sanitize(title), {
    x: M,
    y: height - 46,
    size: 20,
    font: ctx.bold,
    color: INK,
  });
  page.drawText(sanitize(`${ctx.data.periodLabel} · generated ${prettyDate(ctx.data.generatedOn)}`), {
    x: M,
    y: height - 64,
    size: 9,
    font: ctx.regular,
    color: MUTED,
  });
  return height - 100; // cursor
}

function money(ctx: Ctx, n: number): string {
  return moneyPlain(n, ctx.data.currency);
}

function drawOverviewPage(ctx: Ctx): void {
  const page = newPage(ctx);
  const { width, height } = page.getSize();
  let y = header(ctx, page, 'Spending report');

  const d = ctx.data;
  const days = dayCount(d);
  const perDay = days > 0 ? Math.round(d.total / days) : 0;
  const top = d.byCategory[0];

  const cards: Array<[string, string, boolean]> = [
    ['Total spent', money(ctx, d.total), false],
    d.budgetOverall > 0
      ? ['Budget', money(ctx, d.budgetOverall), false]
      : ['Expenses', String(d.transactions.length), false],
    d.budgetOverall > 0
      ? d.total <= d.budgetOverall
        ? ['Left', money(ctx, d.budgetOverall - d.total), false]
        : ['Over budget', money(ctx, d.total - d.budgetOverall), true]
      : ['Average / day', money(ctx, perDay), false],
    top
      ? [`Top: ${top.name}`, `${money(ctx, top.total)} (${pct(top.total, d.total)}%)`, false]
      : ['Average / day', money(ctx, perDay), false],
  ];

  const cardW = (width - M * 2 - 12 * 3) / 4;
  cards.forEach(([label, value, warn], i) => {
    const x = M + i * (cardW + 12);
    page.drawRectangle({
      x,
      y: y - 52,
      width: cardW,
      height: 52,
      color: PANEL,
      borderColor: GRID,
      borderWidth: 0.5,
    });
    page.drawText(fit(label, ctx.regular, 8, cardW - 16), {
      x: x + 8,
      y: y - 20,
      size: 8,
      font: ctx.regular,
      color: MUTED,
    });
    // Long values (a category name plus its share) get a smaller size instead
    // of an ellipsis.
    let size = 12;
    while (size > 8 && ctx.bold.widthOfTextAtSize(sanitize(value), size) > cardW - 16) size -= 0.5;
    page.drawText(fit(value, ctx.bold, size, cardW - 16), {
      x: x + 8,
      y: y - 40,
      size,
      font: ctx.bold,
      color: warn ? OVER : INK,
    });
  });
  y -= 76;

  // Donut of the top categories.
  sectionTitle(ctx, page, M, y, 'Where the money went');
  y -= 14;

  const slices = topSlices(d.byCategory, 8);
  if (slices.length > 0) {
    const donutSize = 150;
    const cx = M + donutSize / 2;
    const cy = y - donutSize / 2;
    drawDonut(page, cx, cy, donutSize / 2, slices, { pageHeight: height });
    const totalLabel = money(ctx, d.total);
    const tw = ctx.bold.widthOfTextAtSize(totalLabel, 11);
    page.drawText(totalLabel, {
      x: cx - tw / 2,
      y: cy - 4,
      size: 11,
      font: ctx.bold,
      color: INK,
    });
    drawLegend(
      page,
      { x: M + donutSize + 30, y: y - donutSize, w: width - M * 2 - donutSize - 30, h: donutSize },
      slices,
      ctx.regular,
      9,
      (s) => `${money(ctx, s.value)} · ${pct(s.value, d.total)}%`,
    );
    y -= donutSize + 26;
  } else {
    page.drawText('No expenses in this period.', {
      x: M,
      y: y - 14,
      size: 10,
      font: ctx.regular,
      color: MUTED,
    });
    y -= 40;
  }

  // Daily (single month) or monthly (range) rhythm.
  if (d.singleMonth) {
    sectionTitle(ctx, page, M, y, `Daily spending · ${monthLabel(d.singleMonth)}`);
    y -= 14;
    const total = daysInMonth(d.singleMonth);
    const byDay = new Map(d.byDay.map((r) => [r.day, r.total]));
    const bars = [];
    const cumulative: number[] = [];
    let running = 0;
    for (let day = 1; day <= total; day++) {
      const key = `${d.singleMonth}-${String(day).padStart(2, '0')}`;
      const value = byDay.get(key) ?? 0;
      running += value;
      cumulative.push(running);
      bars.push({ label: String(day), value });
    }
    const box = { x: M, y: y - 150, w: width - M * 2 - 40, h: 150 };
    const dailyLimit = d.budgetOverall > 0 ? Math.round(d.budgetOverall / total) : undefined;
    drawColumns(page, box, bars, ctx.regular, {
      pageHeight: height,
      formatValue: (v) => group(v),
      limit: dailyLimit,
      limitLabel: dailyLimit ? `daily pace ${money(ctx, dailyLimit)}` : undefined,
      labelEvery: 2,
    });
    y -= 168;

    // Cumulative spend against the monthly limit.
    if (d.budgetOverall > 0) {
      sectionTitle(ctx, page, M, y, 'Cumulative vs budget');
      y -= 14;
      drawLineChart(
        page,
        { x: M, y: y - 120, w: width - M * 2 - 40, h: 120 },
        cumulative,
        ctx.regular,
        {
          formatValue: (v) => group(v),
          limit: d.budgetOverall,
          limitLabel: `budget ${money(ctx, d.budgetOverall)}`,
          lineColor: color(0),
        },
      );
      y -= 138;
    }
  } else {
    sectionTitle(ctx, page, M, y, 'Monthly totals');
    y -= 14;
    const bars = d.byMonth.map((m) => ({
      label: `${monthLabel(m.period).slice(0, 3)} ${m.period.slice(2, 4)}`,
      value: m.total,
    }));
    drawColumns(page, { x: M, y: y - 160, w: width - M * 2 - 40, h: 160 }, bars, ctx.regular, {
      pageHeight: height,
      formatValue: (v) => group(v),
      limit: d.budgetOverall > 0 ? d.budgetOverall : undefined,
      limitLabel: d.budgetOverall > 0 ? `monthly budget ${money(ctx, d.budgetOverall)}` : undefined,
    });
  }
}

function drawBreakdownPage(ctx: Ctx): Cursor {
  const d = ctx.data;
  const page = newPage(ctx);
  const { width, height } = page.getSize();
  let y = header(ctx, page, 'Categories');

  // 6-month trend for context, even in a single-month report.
  if (d.byMonth.length > 1) {
    sectionTitle(ctx, page, M, y, 'Trend');
    y -= 14;
    const bars = d.byMonth.map((m) => ({
      label: `${monthLabel(m.period).slice(0, 3)} ${m.period.slice(2, 4)}`,
      value: m.total,
      emphasise: d.singleMonth === m.period,
    }));
    drawColumns(page, { x: M, y: y - 130, w: width - M * 2 - 40, h: 130 }, bars, ctx.regular, {
      pageHeight: height,
      formatValue: (v) => group(v),
      limit: d.budgetOverall > 0 ? d.budgetOverall : undefined,
      limitLabel: d.budgetOverall > 0 ? 'budget' : undefined,
    });
    y -= 150;
  }

  sectionTitle(ctx, page, M, y, 'By category');
  y -= 18;

  const cols = [
    { title: 'Category', w: 150, align: 'left' as const },
    { title: 'Expenses', w: 60, align: 'right' as const },
    { title: 'Total', w: 95, align: 'right' as const },
    { title: 'Share', w: 50, align: 'right' as const },
    { title: 'Budget', w: 95, align: 'right' as const },
    { title: 'Status', w: 65, align: 'right' as const },
  ];
  y = tableHeader(ctx, page, y, cols);

  let cursor: Cursor = { page, y };
  for (const row of d.byCategory) {
    cursor = ensureSpace(ctx, cursor, 30, 'Categories', cols);
    const budget = row.category_id ? d.categoryBudgets.get(row.category_id) ?? 0 : 0;
    const status = budget > 0 ? `${pct(row.total, budget)}%` : '—';
    const over = budget > 0 && row.total > budget;
    cursor.y = tableRow(
      ctx,
      cursor.page,
      cursor.y,
      cols,
      [
        row.name,
        String(row.count),
        money(ctx, row.total),
        `${pct(row.total, d.total)}%`,
        budget > 0 ? money(ctx, budget) : '—',
        status,
      ],
      over ? OVER : INK,
    );
  }

  // Total line.
  cursor = ensureSpace(ctx, cursor, 30, 'Categories', cols);
  cursor.page.drawLine({
    start: { x: M, y: cursor.y + 4 },
    end: { x: width - M, y: cursor.y + 4 },
    thickness: 0.8,
    color: GRID,
  });
  cursor.y = tableRow(
    ctx,
    cursor.page,
    cursor.y - 4,
    cols,
    [
      'Total',
      String(d.transactions.length),
      money(ctx, d.total),
      '100%',
      d.budgetOverall > 0 ? money(ctx, d.budgetOverall) : '—',
      d.budgetOverall > 0 ? `${pct(d.total, d.budgetOverall)}%` : '—',
    ],
    INK,
    true,
  );
  return cursor;
}

function drawTransactionPages(ctx: Ctx, cursor: Cursor): void {
  const d = ctx.data;
  if (d.transactions.length === 0) return;

  const cols = [
    { title: 'Date', w: 65, align: 'left' as const },
    { title: 'Category', w: 120, align: 'left' as const },
    { title: 'Note', w: 230, align: 'left' as const },
    { title: 'Amount', w: 100, align: 'right' as const },
  ];

  // Continue on the current page when a screenful still fits, else start fresh.
  let flow: Cursor = cursor.y > 220 ? { ...cursor, y: cursor.y - 26 } : newSection(ctx, 'Expenses');
  if (flow.page === cursor.page) sectionTitle(ctx, flow.page, M, flow.y, 'Expenses');
  flow.y = tableHeader(ctx, flow.page, flow.y - 18, cols);

  const rows = d.transactions.slice(0, MAX_TX_ROWS);
  for (const tx of rows) {
    flow = ensureSpace(ctx, flow, 24, 'Expenses', cols);
    flow.y = tableRow(ctx, flow.page, flow.y, cols, [
      prettyDate(tx.spent_on),
      tx.category_name ?? 'Uncategorised',
      tx.note,
      money(ctx, tx.amount),
    ]);
  }

  if (d.transactions.length > rows.length) {
    flow = ensureSpace(ctx, flow, 24, 'Expenses', cols);
    flow.page.drawText(
      sanitize(`...and ${d.transactions.length - rows.length} more expenses (export CSV for the full list)`),
      { x: M, y: flow.y, size: 8, font: ctx.regular, color: MUTED },
    );
  }
}

// --------------------------------------------------------------------- pieces

export interface Cursor {
  page: PDFPage;
  y: number;
}

/** Starts a fresh page with the standard header and returns its cursor. */
function newSection(ctx: Ctx, title: string): Cursor {
  const page = newPage(ctx);
  return { page, y: header(ctx, page, title) };
}

/** Breaks to a new page (repeating the table header) when `need` no longer fits. */
function ensureSpace(ctx: Ctx, cursor: Cursor, need: number, title: string, cols: readonly Col[]): Cursor {
  if (cursor.y - need > 50) return cursor;
  const next = newSection(ctx, title);
  next.y = tableHeader(ctx, next.page, next.y - 4, cols);
  return next;
}

interface Col {
  title: string;
  w: number;
  align: 'left' | 'right';
}

function tableHeader(ctx: Ctx, page: PDFPage, y: number, cols: readonly Col[]): number {
  let x = M;
  for (const c of cols) {
    const text = sanitize(c.title);
    const tx = c.align === 'right' ? x + c.w - ctx.bold.widthOfTextAtSize(text, 8) : x;
    page.drawText(text, { x: tx, y, size: 8, font: ctx.bold, color: MUTED });
    x += c.w;
  }
  page.drawLine({
    start: { x: M, y: y - 5 },
    end: { x: M + cols.reduce((a, c) => a + c.w, 0), y: y - 5 },
    thickness: 0.8,
    color: GRID,
  });
  return y - 18;
}

function tableRow(
  ctx: Ctx,
  page: PDFPage,
  y: number,
  cols: readonly Col[],
  values: readonly string[],
  ink = INK,
  bold = false,
): number {
  const font = bold ? ctx.bold : ctx.regular;
  let x = M;
  cols.forEach((c, i) => {
    const text = fit(values[i] ?? '', font, 9, c.w - 8);
    const tx = c.align === 'right' ? x + c.w - font.widthOfTextAtSize(text, 9) : x;
    page.drawText(text, { x: tx, y, size: 9, font, color: ink });
    x += c.w;
  });
  return y - 15;
}

function sectionTitle(ctx: Ctx, page: PDFPage, x: number, y: number, text: string): void {
  page.drawText(sanitize(text), { x, y, size: 11, font: ctx.bold, color: INK });
}

function topSlices(rows: readonly CategoryTotal[], limit: number): Slice[] {
  const slices: Slice[] = rows.slice(0, limit).map((r, i) => ({
    label: sanitize(r.name),
    value: r.total,
    colorIndex: i,
  }));
  const restTotal = rows.slice(limit).reduce((a, r) => a + r.total, 0);
  if (restTotal > 0) {
    slices.push({ label: `Other (${rows.length - limit})`, value: restTotal, colorIndex: limit });
  }
  return slices.filter((s) => s.value > 0);
}

function dayCount(d: ReportData): number {
  const from = new Date(`${d.from}T00:00:00Z`).getTime();
  const to = new Date(`${d.to}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

function numberPages(ctx: Ctx): void {
  const pages = ctx.doc.getPages();
  pages.forEach((page, i) => {
    const { width } = page.getSize();
    const label = `${i + 1} / ${pages.length}`;
    page.drawText(label, {
      x: width - M - ctx.regular.widthOfTextAtSize(label, 8),
      y: 24,
      size: 8,
      font: ctx.regular,
      color: MUTED,
    });
    page.drawText('FinTrack', { x: M, y: 24, size: 8, font: ctx.regular, color: MUTED });
    page.drawLine({
      start: { x: M, y: 38 },
      end: { x: width - M, y: 38 },
      thickness: 0.5,
      color: GRID,
    });
  });
}
