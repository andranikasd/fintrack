import { parseDateToken, todayIn } from './dates';
import { parseMinor, validDate } from './savings';

export interface PostRow { label: string; amountMinor: number; kind: 'expense' | 'save' | 'withdraw' | 'income'; }
export interface DailyPost { day: string; rows: PostRow[]; warning: string | null; }
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported table content.');
  return value as ObjectValue;
}
export function richText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(richText).join('');
  const node = object(value);
  if ('text' in node) return richText(node.text);
  throw new Error('Unsupported formatted text. Use plain text in the expense table.');
}

/** Read documented Telegram blocks, never silently drop an unknown financial row. */
function richLines(value: unknown): string[] {
  const blocks = Array.isArray(value) ? value : object(value).blocks;
  if (!Array.isArray(blocks)) throw new Error('Unsupported rich message.');
  const lines: string[] = [];
  for (const raw of blocks) {
    const b = object(raw);
    if (b.type === 'table') {
      if (!Array.isArray(b.cells)) throw new Error('Missing table cells.');
      for (const rawRow of b.cells) {
        if (!Array.isArray(rawRow) || rawRow.length !== 2) throw new Error('Use two table columns: Item and price.');
        lines.push(rawRow.map(cell => {
          const c = object(cell);
          if ((Number(c.colspan) || 1) > 1 || (Number(c.rowspan) || 1) > 1) throw new Error('Merged cells are not supported.');
          return richText(c.text ?? '').trim();
        }).join(' | '));
      }
    } else if (['paragraph', 'heading', 'footer', 'preformatted'].includes(String(b.type))) {
      lines.push(...richText(b.text).split('\n'));
    } else if (b.type !== 'divider' && b.type !== 'anchor') {
      throw new Error('Use text and a two-column table for the daily expense post.');
    }
  }
  return lines;
}

function headerDate(line: string, tz: string, at: Date): string | null {
  if (validDate(line)) return line;
  const named = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(line);
  if (named) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const month = months.indexOf(named[1]!.slice(0,3).toLowerCase()) + 1;
    const year = named[3] ?? todayIn(tz, at).slice(0,4);
    const date = `${year}-${String(month).padStart(2,'0')}-${named[2]!.padStart(2,'0')}`;
    if (!validDate(date)) throw new Error('Invalid date heading.');
    return date;
  }
  return parseDateToken(line, tz, at);
}

export function parseDailyPost(message: { text?: string; caption?: string; rich_message?: unknown; date: number }, tz: string): DailyPost {
  const lines = message.rich_message ? richLines(message.rich_message) : (message.text ?? message.caption ?? '').split('\n');
  const at = new Date(message.date * 1000);
  let day = todayIn(tz, at);
  let explicit = false;
  let total: number | null = null;
  let table = false;
  const rows: PostRow[] = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/^\|\s*|\s*\|$/g, '').trim();
    if (!line || /^[-|:\s]+$/.test(line) || /^```(?:\w+)?$/.test(line)) continue;
    const date = headerDate(line, tz, at);
    if (date) {
      if (explicit || rows.length) throw new Error('Put one date heading before the table.');
      day = date; explicit = true; continue;
    }
    if (/^(item|description|expense)\s*(?:\||\t|\s)\s*(price|amount)$/i.test(line)) { table = true; continue; }
    const totalMatch = /^(?:total\s*[:|]?\s*)?([\d,.]+)\s*(?:֏|AMD)?$/i.exec(line);
    if (totalMatch) {
      const parsed = parseMinor(totalMatch[1]!, true);
      if (parsed === null || total !== null) throw new Error('Invalid or repeated total.');
      total = parsed; continue;
    }
    if (total !== null) throw new Error('Put the total after all expense rows.');
    const cells = line.includes('|') ? line.split('|').map(x => x.trim()) : null;
    const match = cells ? (cells.length === 2 ? [line, cells[0]!, cells[1]!] : null)
      : /^(.*?)\s+([\d,.]+[km]?)\s*(?:֏|AMD)?$/i.exec(line);
    if (!match) throw new Error(`Cannot read row: ${line.slice(0,80)}`);
    let label = match[1]!.trim();
    const amount = parseMinor(match[2]!.replace(/\s*(֏|AMD)$/i, '').trim());
    if (!label || label.length > 120 || amount === null) throw new Error(`Invalid item or amount: ${line.slice(0,80)}`);
    const savings = /^(save|withdraw|income)\s*:\s*(.+)$/i.exec(label);
    const kind = savings ? savings[1]!.toLowerCase() as 'save' | 'withdraw' | 'income' : 'expense';
    if (savings) label = savings[2]!.trim();
    if (kind === 'expense' && amount % 100) throw new Error('Expense amounts must be whole drams. Savings and income can have two decimals.');
    rows.push({ label, amountMinor: amount, kind });
  }
  if (!rows.length && !table) throw new Error('No expense table found. Use Item | price followed by expense rows.');
  if (rows.length > 200) throw new Error('Use at most 200 rows per post.');
  const computed = rows.filter(r => r.kind === 'expense').reduce((sum,r) => sum + r.amountMinor,0);
  return { day, rows, warning: total !== null && total !== computed ? `Written total differs from expense rows (${computed / 100} AMD). The row amounts were used.` : null };
}
