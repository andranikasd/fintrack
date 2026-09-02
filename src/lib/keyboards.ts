import { InlineKeyboard, Keyboard } from 'grammy';
import type { Category } from '../types';

export const MAIN_MENU = new Keyboard()
  .text('📊 Month').text('📈 Stats').row()
  .text('🗂 Categories').text('🎯 Budget').row()
  .text('📄 Export').text('↩️ Undo')
  .resized()
  .persistent();

/** Category picker; `prefix` is the callback-data namespace, e.g. "pick:12". */
export function categoryKeyboard(
  categories: readonly Category[],
  prefix: string,
  perRow = 3,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  categories.forEach((c, i) => {
    kb.text(`${c.emoji} ${c.name}`.trim(), `${prefix}:${c.id}`);
    if ((i + 1) % perRow === 0) kb.row();
  });
  return kb;
}

export function confirmKeyboard(yes: string, no: string): InlineKeyboard {
  return new InlineKeyboard().text('✅ Yes', yes).text('✖️ Cancel', no);
}

export function periodNavKeyboard(period: string, action: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('◀️', `${action}:${period}:prev`)
    .text('📄 PDF', `export:pdf:${period}`)
    .text('▶️', `${action}:${period}:next`);
}
