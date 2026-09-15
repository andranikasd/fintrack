import type { InputRichBlock, InputRichMessage } from 'grammy/types';

/** Keep user-entered labels as plain text; never interpolate them into markup. */
export function reportTable(headers: string[], rows: string[][]): InputRichBlock {
  return {
    type: 'table', is_bordered: true, is_striped: true, is_compact: true,
    cells: [headers, ...rows].map((row, index) => row.map((text, column) => ({
      text, ...(index === 0 ? { is_header: true as const } : {}),
      align: column === 0 ? 'left' as const : 'right' as const,
      valign: 'middle' as const,
    }))),
  };
}

/** Daily report text remains available to plain-text integrations and tests. */
export function richDailyReport(text: string): InputRichMessage {
  const [title, ...lines] = text.split('\n');
  const blocks: InputRichBlock[] = [{ type: 'heading', size: 2, text: title! }];
  let rows: string[][] = [];
  const flush = () => {
    if (rows.length) blocks.push(reportTable(['Activity', 'Amount'], rows));
    rows = [];
  };
  for (const line of lines) {
    const match = /^(.*?)[:—]\s*(-?[\d,]+(?:\.\d+)?\s+.*)$/.exec(line);
    if (match) rows.push([match[1]!.trim(), match[2]!]);
    else {
      flush();
      if (line === 'By category' || line.startsWith('🎯 ')) blocks.push({type:'heading',size:3,text:line});
      else if (line) blocks.push({ type: 'paragraph', text: line });
    }
  }
  flush();
  return { blocks };
}
