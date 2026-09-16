import type { Account } from '../accounts-db';
import type { Income } from '../income-db';
import type { Goal } from '../lib/savings';
import type { Transfer } from '../transfers-db';
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
  finance?: {
    incomes: Income[];
    savings: Array<{id:number;goal_name:string;amount_minor:number;account_id:number;saved_on:string;source_chat:number|null}>;
    accounts: Account[];
    openingAccounts: Account[];
    goals: Goal[];
    transfers?: Transfer[];
  };
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
  if (data.finance) drawFinancialSummary(ctx);
  drawOverviewPage(ctx);
  const cursor = drawBreakdownPage(ctx);
  if (data.finance) drawFinancialDetails(ctx);
  else drawTransactionPages(ctx, cursor);
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
    d.singleMonth && d.budgetOverall > 0
      ? ['Budget', money(ctx, d.budgetOverall), false]
      : ['Expenses', String(d.transactions.length), false],
    d.singleMonth && d.budgetOverall > 0
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
    const total = Math.min(daysInMonth(d.singleMonth), Number(d.to.slice(8)));
    const byDay = new Map(d.byDay.map((r) => [r.day, r.total]));
    const bars = [];
    const cumulative: number[] = [];
    let running = 0;
    for (let day = Number(d.from.slice(8)); day <= total; day++) {
      const key = `${d.singleMonth}-${String(day).padStart(2, '0')}`;
      const value = byDay.get(key) ?? 0;
      running += value;
      cumulative.push(running);
      bars.push({ label: String(day), value });
    }
    const box = { x: M, y: y - 150, w: width - M * 2 - 40, h: 150 };
    const dailyLimit = d.budgetOverall > 0 ? Math.round(d.budgetOverall / daysInMonth(d.singleMonth)) : undefined;
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
    const budget = d.singleMonth && row.category_id ? d.categoryBudgets.get(row.category_id) ?? 0 : 0;
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
      d.singleMonth && d.budgetOverall > 0 ? money(ctx, d.budgetOverall) : '—',
      d.singleMonth && d.budgetOverall > 0 ? `${pct(d.total, d.budgetOverall)}%` : '—',
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

  const rows = d.transactions;
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

function wrapped(text: string, font: PDFFont, width: number, size = 9): string[] {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of sanitize(paragraph).split(/\s+/)) {
      if (line && font.widthOfTextAtSize(line + ' ' + word, size) > width) {
        result.push(line); line = '';
      }
      if (font.widthOfTextAtSize(word, size) > width) {
        if (line) { result.push(line); line = ''; }
        for (const char of word) {
          if (font.widthOfTextAtSize(line + char, size) > width) { result.push(line); line = ''; }
          line += char;
        }
      } else line = line ? line + ' ' + word : word;
    }
    result.push(line);
  }
  return result;
}

function detailTable(ctx: Ctx, title: string, cols: Col[], rows: string[][], previous?: Cursor): Cursor {
  let flow: Cursor;
  if (previous && previous.y > 210) {
    flow = {page: previous.page, y: previous.y - 35};
    sectionTitle(ctx, flow.page, M, flow.y, title);
    flow.y -= 22;
  } else flow = newSection(ctx, title);
  flow.y = tableHeader(ctx, flow.page, flow.y - 8, cols);
  for (const values of rows.length ? rows : [['No records in this period.']]) {
    const cells = cols.map((c, i) => wrapped(values[i] ?? '', ctx.regular, c.w - 12));
    const count = Math.max(...cells.map(c => c.length));
    if (count * 13 + 9 < 600) flow = ensureSpace(ctx, flow, count * 13 + 9, title, cols);
    // A very long note can continue over a page, with the column headings repeated.
    for (let line = 0; line < count; line++) {
      flow = ensureSpace(ctx, flow, 18, title, cols);
      let x = M;
      cols.forEach((c, i) => {
        const value = cells[i]![line] ?? '';
        flow.page.drawText(value, {x: c.align === 'right' ? x + c.w - 8 - ctx.regular.widthOfTextAtSize(value, 9) : x,
          y: flow.y, size: 9, font: ctx.regular, color: INK});
        x += c.w;
      });
      flow.y -= 13;
    }
    flow.y -= 9;
    flow.page.drawLine({start:{x:M,y:flow.y+5},end:{x:A4[0]-M,y:flow.y+5},color:GRID,thickness:.4});
  }
  return flow;
}

function amountOnly(minor: number): string {
  return (minor / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
function exactMoney(ctx: Ctx, minor: number): string { return `${amountOnly(minor)} ${ctx.data.currency}`; }

function drawFinancialSummary(ctx: Ctx): void {
  const d = ctx.data, f = d.finance!;
  const income = f.incomes.reduce((s,r)=>s+r.amount_minor,0);
  const deposits = f.savings.filter(r=>r.amount_minor>0).reduce((s,r)=>s+r.amount_minor,0);
  const withdrawals = -f.savings.filter(r=>r.amount_minor<0).reduce((s,r)=>s+r.amount_minor,0);
  const net = income-d.total*100-deposits+withdrawals;
  const page = newPage(ctx);
  let y = header(ctx,page,'Financial report');
  const text=(value:string,size=10,bold=false)=>{page.drawText(sanitize(value),{x:M,y,size,font:bold?ctx.bold:ctx.regular,color:INK});y-=size+13;};
  text(`${d.from} to ${d.to}`,12,true);
  text(d.to===d.generatedOn?"Includes today's activity so far.":'Completed reporting period.');
  y-=12;
  for(const [label,value] of [['Income received',income],['Spending',d.total*100],['Savings deposits',deposits],['Savings withdrawals',withdrawals],['Net cash flow',net]] as const) {
    page.drawText(label,{x:M,y,size:12,font:ctx.regular,color:MUTED});
    const amount=exactMoney(ctx,value);
    page.drawText(amount,{x:A4[0]-M-ctx.bold.widthOfTextAtSize(amount,16),y,size:16,font:ctx.bold,color:value<0?OVER:INK});
    y-=42;
  }
  y-=8;
  text(`${d.transactions.length} expenses | ${f.incomes.length} income receipts | ${f.savings.length} savings transfers`,10,true);
  text(`Average spending per calendar day: ${money(ctx,Math.round(d.total/dayCount(d)))}`);
  text(`Net savings rate: ${income>0?((deposits-withdrawals)/income*100).toFixed(1)+'% of income':'No income recorded'}`);
  if(d.singleMonth && d.budgetOverall>0) text(`Current monthly budget: ${money(ctx,d.budgetOverall)} | Remaining: ${money(ctx,d.budgetOverall-d.total)}`);
  const unknown=d.transactions.filter(r=>r.category_id===null);
  text(`Needs categorization: ${unknown.length} expenses, ${money(ctx,unknown.reduce((s,r)=>s+r.amount,0))}`);
  y-=10;
  text('Reading this report',12,true);
  for(const line of ['Savings are transfers, not spending. Opening balances are not income.',
    'Cash flow is income minus spending and net savings transfers.',
    'Account transfers change balances, not income, spending or net cash flow.',
    "Account balances include activity from each account's opening date.",
    'Budget comparisons use your current settings, not historical budget versions.',
    'Dates without entries are not confirmed no-spend days.',
    'Following pages: accounts, spending charts, categories and complete activity.']) text(line,9);
  const accountRows=f.accounts.filter(a=>a.opening_on<=d.to).map(a=>{
    const opening=f.openingAccounts.find(r=>r.id===a.id);
    const incoming=f.incomes.filter(r=>r.account_id===a.id&&r.received_on>=a.opening_on).reduce((s,r)=>s+r.amount_minor,0);
    const spending=d.transactions.filter(r=>r.account_id===a.id&&r.spent_on>=a.opening_on).reduce((s,r)=>s+r.amount*100,0);
    const saved=f.savings.filter(r=>r.account_id===a.id&&r.saved_on>=a.opening_on).reduce((s,r)=>s+r.amount_minor,0);
    const transferred=(f.transfers??[]).reduce((sum,r)=>sum+(r.to_account_id===a.id?r.amount_minor:0)-(r.from_account_id===a.id?r.amount_minor:0),0);
    return [a.name+(a.archived?' (archived)':'')+'\nOpening date: '+a.opening_on,
      amountOnly(a.opening_on>=d.from?a.opening_minor:opening?.balance_minor??a.opening_minor),
      amountOnly(incoming),amountOnly(spending),amountOnly(saved),amountOnly(transferred),amountOnly(a.balance_minor)];
  });
  let flow=detailTable(ctx,`Account reconciliation (${d.currency})`,[
    {title:'Account / opening date',w:113,align:'left'},{title:'Start / opening',w:67,align:'right'},
    {title:'Income',w:67,align:'right'},{title:'Spent',w:67,align:'right'},
    {title:'Net saved',w:67,align:'right'},{title:'Net moved',w:67,align:'right'},{title:'End balance',w:67,align:'right'},
  ],accountRows);
  if(f.transfers?.length)flow=detailTable(ctx,'Account transfers / no income or spending',[
    {title:'Date',w:80,align:'left'},{title:'From / to',w:180,align:'left'},
    {title:'Note',w:150,align:'left'},{title:'Amount',w:105,align:'right'},
  ],f.transfers.map(r=>[r.transferred_on,r.from_name+' / '+r.to_name,r.note,exactMoney(ctx,r.amount_minor)]),flow);
  const sourceTotals=new Map<string,number>();
  for(const r of f.incomes) sourceTotals.set(r.source,(sourceTotals.get(r.source)??0)+r.amount_minor);
  flow=detailTable(ctx,'Income by source',[{title:'Source',w:355,align:'left'},{title:'Received',w:160,align:'right'}],
    [...sourceTotals].sort((a,b)=>b[1]-a[1]).map(([name,total])=>[name,exactMoney(ctx,total)]),flow);
  if(f.goals.length) detailTable(ctx,`Savings goals as of ${d.generatedOn}`,[
    {title:'Goal / deadline',w:180,align:'left'},{title:'Saved / target',w:155,align:'right'},{title:'Period net / progress',w:180,align:'right'},
  ],f.goals.map(g=>[g.name+(g.deadline?' | '+g.deadline:''),exactMoney(ctx,g.saved_minor)+' / '+exactMoney(ctx,g.target_minor),
    exactMoney(ctx,f.savings.filter(r=>r.goal_name===g.name).reduce((s,r)=>s+r.amount_minor,0))+' | '+(g.saved_minor/g.target_minor*100).toFixed(1)+'%']),flow);
}

function drawFinancialDetails(ctx: Ctx): void {
  const d=ctx.data,f=d.finance!,account=(id:number|null|undefined)=>f.accounts.find(a=>a.id===id)?.name??'Unassigned';
  const rows=[...d.transactions.map(r=>({day:r.spent_on,kind:'Expense',label:(r.note||'Expense')+'\n'+(r.category_name??'Uncategorized'),account:account(r.account_id),amount:-r.amount*100,channel:r.source_chat!=null})),
    ...f.incomes.map(r=>({day:r.received_on,kind:r.passive?'Passive income':'Income',label:r.source,account:account(r.account_id),amount:r.amount_minor,channel:r.source_chat!=null})),
    ...f.savings.map(r=>({day:r.saved_on,kind:r.amount_minor>0?'Savings deposit':'Savings withdrawal',label:r.goal_name,account:account(r.account_id),amount:-r.amount_minor,channel:r.source_chat!=null}))].sort((a,b)=>a.day.localeCompare(b.day));
  detailTable(ctx,'Complete activity / account cash flow',[
    {title:'Date / type',w:95,align:'left'},{title:'Item / category / source',w:205,align:'left'},
    {title:'Account / entry',w:100,align:'left'},{title:'Cash change',w:115,align:'right'},
  ],rows.map(r=>[r.day+'\n'+r.kind,r.label,r.account+'\n'+(r.channel?'Channel':'Manual'),exactMoney(ctx,r.amount)]));
}
