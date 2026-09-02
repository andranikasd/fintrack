import { describe, expect, it } from 'vitest';
import { paceLine, progressBar } from '../src/lib/alerts';

describe('progressBar', () => {
  it('fills proportionally and turns red past the limit', () => {
    expect(progressBar(0, 100)).toBe('⬜'.repeat(10));
    expect(progressBar(50, 100)).toBe(`${'🟩'.repeat(5)}${'⬜'.repeat(5)}`);
    expect(progressBar(150, 100)).toBe('🟥'.repeat(10));
    expect(progressBar(10, 0)).toBe('');
  });
});

describe('paceLine', () => {
  it('reports what is left and the daily allowance', () => {
    // 14 September: 17 days left including today.
    const line = paceLine(200_000, 400_000, '2026-09-14', '֏');
    expect(line).toContain('50%');
    expect(line).toContain('left 200,000 ֏');
    expect(line).toContain('for 17d');
  });

  it('reports the overshoot', () => {
    expect(paceLine(450_000, 400_000, '2026-09-14', '֏')).toContain('over by 50,000 ֏');
  });

  it('says nothing without a budget', () => {
    expect(paceLine(1000, 0, '2026-09-14', '֏')).toBeNull();
  });
});
