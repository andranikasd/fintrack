import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { fit, sanitize } from './font';

export interface Box {
  x: number;
  y: number; // bottom-left corner, PDF coordinates
  w: number;
  h: number;
}

export const PALETTE: RGB[] = [
  rgb(0.20, 0.44, 0.85),
  rgb(0.95, 0.55, 0.15),
  rgb(0.16, 0.68, 0.45),
  rgb(0.85, 0.28, 0.35),
  rgb(0.55, 0.36, 0.78),
  rgb(0.20, 0.72, 0.80),
  rgb(0.90, 0.75, 0.20),
  rgb(0.45, 0.50, 0.58),
  rgb(0.75, 0.40, 0.60),
  rgb(0.35, 0.60, 0.25),
  rgb(0.60, 0.45, 0.30),
  rgb(0.30, 0.35, 0.60),
];

export const INK = rgb(0.12, 0.13, 0.16);
export const MUTED = rgb(0.45, 0.47, 0.52);
export const GRID = rgb(0.87, 0.88, 0.90);
export const PANEL = rgb(0.965, 0.97, 0.98);
export const OVER = rgb(0.85, 0.28, 0.35);

export function color(i: number): RGB {
  return PALETTE[i % PALETTE.length]!;
}

/**
 * pdf-lib reads SVG paths with y growing downwards from the anchor, so every
 * chart shape is emitted relative to the page top and anchored at (0, height).
 */
function path(points: Array<[number, number]>, pageHeight: number): string {
  const parts = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)} ${(pageHeight - py).toFixed(2)}`);
  return `${parts.join(' ')} Z`;
}

export interface Slice {
  label: string;
  value: number;
  colorIndex: number;
}

/** Donut chart. Slices are polygon approximations: no arc support needed. */
export function drawDonut(
  page: PDFPage,
  cx: number,
  cy: number,
  radius: number,
  slices: readonly Slice[],
  opts: { innerRatio?: number; pageHeight: number },
): void {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return;
  const inner = radius * (opts.innerRatio ?? 0.55);
  let angle = Math.PI / 2; // start at 12 o'clock

  for (const slice of slices) {
    const sweep = (slice.value / total) * Math.PI * 2;
    const steps = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * 180));
    const outer: Array<[number, number]> = [];
    const innerPts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const a = angle - (sweep * i) / steps; // clockwise
      outer.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
      innerPts.push([cx + Math.cos(a) * inner, cy + Math.sin(a) * inner]);
    }
    innerPts.reverse();
    page.drawSvgPath(path([...outer, ...innerPts], opts.pageHeight), {
      x: 0,
      y: opts.pageHeight,
      color: color(slice.colorIndex),
      borderWidth: 0,
    });
    angle -= sweep;
  }
}

export function drawLegend(
  page: PDFPage,
  box: Box,
  slices: readonly Slice[],
  font: PDFFont,
  size: number,
  valueOf: (s: Slice) => string,
): void {
  let y = box.y + box.h - size;
  for (const slice of slices) {
    page.drawRectangle({
      x: box.x,
      y: y + 1,
      width: size * 0.8,
      height: size * 0.8,
      color: color(slice.colorIndex),
    });
    const value = valueOf(slice);
    const valueWidth = font.widthOfTextAtSize(value, size);
    page.drawText(fit(slice.label, font, size, box.w - size * 1.6 - valueWidth - 8), {
      x: box.x + size * 1.5,
      y,
      size,
      font,
      color: INK,
    });
    page.drawText(value, {
      x: box.x + box.w - valueWidth,
      y,
      size,
      font,
      color: MUTED,
    });
    y -= size + 6;
    if (y < box.y) break;
  }
}

export interface Bar {
  label: string;
  value: number;
  emphasise?: boolean;
}

/** Vertical column chart with a horizontal grid and an optional limit line. */
export function drawColumns(
  page: PDFPage,
  box: Box,
  bars: readonly Bar[],
  font: PDFFont,
  opts: {
    pageHeight: number;
    formatValue: (v: number) => string;
    limit?: number;
    limitLabel?: string;
    labelEvery?: number;
    barColor?: RGB;
  },
): void {
  const max = Math.max(...bars.map((b) => b.value), opts.limit ?? 0, 1);
  const plotBottom = box.y + 16;
  const plotHeight = box.h - 26;
  const scale = plotHeight / max;

  // Grid + axis labels.
  for (let i = 0; i <= 4; i++) {
    const y = plotBottom + (plotHeight * i) / 4;
    page.drawLine({
      start: { x: box.x, y },
      end: { x: box.x + box.w, y },
      thickness: 0.5,
      color: GRID,
    });
    const label = opts.formatValue((max * i) / 4);
    page.drawText(label, {
      x: box.x + box.w + 4,
      y: y - 3,
      size: 6.5,
      font,
      color: MUTED,
    });
  }

  const slot = box.w / Math.max(1, bars.length);
  const barWidth = Math.max(1.5, Math.min(slot * 0.62, 26));
  const labelEvery = opts.labelEvery ?? 1;

  bars.forEach((bar, i) => {
    const height = Math.max(bar.value > 0 ? 0.8 : 0, bar.value * scale);
    const x = box.x + slot * i + (slot - barWidth) / 2;
    page.drawRectangle({
      x,
      y: plotBottom,
      width: barWidth,
      height,
      color: bar.emphasise ? OVER : opts.barColor ?? PALETTE[0]!,
    });
    if (i % labelEvery === 0) {
      const text = sanitize(bar.label);
      const width = font.widthOfTextAtSize(text, 6.5);
      page.drawText(text, {
        x: x + barWidth / 2 - width / 2,
        y: box.y + 5,
        size: 6.5,
        font,
        color: MUTED,
      });
    }
  });

  if (opts.limit && opts.limit > 0) {
    const y = plotBottom + opts.limit * scale;
    dashedLine(page, box.x, y, box.x + box.w, OVER);
    if (opts.limitLabel) {
      page.drawText(sanitize(opts.limitLabel), {
        x: box.x + 2,
        y: y + 3,
        size: 6.5,
        font,
        color: OVER,
      });
    }
  }
}

export function dashedLine(page: PDFPage, x1: number, y: number, x2: number, c: RGB): void {
  const dash = 4;
  for (let x = x1; x < x2; x += dash * 2) {
    page.drawLine({
      start: { x, y },
      end: { x: Math.min(x + dash, x2), y },
      thickness: 1,
      color: c,
    });
  }
}

/** Standalone line chart: grid, optional limit line, one series. */
export function drawLineChart(
  page: PDFPage,
  box: Box,
  values: readonly number[],
  font: PDFFont,
  opts: {
    formatValue: (v: number) => string;
    limit?: number;
    limitLabel?: string;
    lineColor?: RGB;
  },
): void {
  const max = Math.max(...values, opts.limit ?? 0, 1);
  const plotBottom = box.y + 16;
  const plotHeight = box.h - 26;

  for (let i = 0; i <= 4; i++) {
    const y = plotBottom + (plotHeight * i) / 4;
    page.drawLine({
      start: { x: box.x, y },
      end: { x: box.x + box.w, y },
      thickness: 0.5,
      color: GRID,
    });
    page.drawText(opts.formatValue((max * i) / 4), {
      x: box.x + box.w + 4,
      y: y - 3,
      size: 6.5,
      font,
      color: MUTED,
    });
  }

  if (opts.limit && opts.limit > 0) {
    const y = plotBottom + (opts.limit / max) * plotHeight;
    dashedLine(page, box.x, y, box.x + box.w, OVER);
    if (opts.limitLabel) {
      page.drawText(sanitize(opts.limitLabel), {
        x: box.x + 2,
        y: y + 3,
        size: 6.5,
        font,
        color: OVER,
      });
    }
  }

  if (values.length < 2) return;
  const step = box.w / (values.length - 1);
  let prev = { x: box.x, y: plotBottom + (values[0]! / max) * plotHeight };
  for (let i = 1; i < values.length; i++) {
    const point = { x: box.x + step * i, y: plotBottom + (values[i]! / max) * plotHeight };
    page.drawLine({
      start: prev,
      end: point,
      thickness: 1.4,
      color: opts.lineColor ?? PALETTE[0]!,
    });
    prev = point;
  }
}
