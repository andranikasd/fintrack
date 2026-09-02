import regularTtf from '../../assets/DejaVuSans-Regular.ttf';
import boldTtf from '../../assets/DejaVuSans-Bold.ttf';

export const FONT_REGULAR = regularTtf;
export const FONT_BOLD = boldTtf;

/**
 * The bundled font is subset to Latin, Cyrillic, Armenian and common
 * punctuation, so anything else (emoji above all) has to go before pdf-lib
 * tries to encode it.
 */
const SUPPORTED =
  /[ -~ -ÿЀ-џ԰-֏‐-‧‰‹›€№←-↓−●✓]/;

export function sanitize(text: string): string {
  let out = '';
  for (const ch of text) out += SUPPORTED.test(ch) ? ch : '';
  return out.replace(/\s+/g, ' ').trim();
}

/** Cuts a string to fit `maxWidth`, adding an ellipsis when it had to. */
export function fit(
  text: string,
  font: { widthOfTextAtSize(t: string, s: number): number },
  size: number,
  maxWidth: number,
): string {
  const clean = sanitize(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${clean.slice(0, mid)}...`, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${clean.slice(0, lo)}...`;
}
