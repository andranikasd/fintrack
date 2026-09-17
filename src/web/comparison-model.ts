import type { DashboardRecord } from './data';

/** Self-contained so the same aggregation runs in tests and offline reports. */
export function createComparisonModel() {
  const itemKey = (row: DashboardRecord) => JSON.stringify([row.kind, row.label.trim().toLowerCase()]);
  const categoryKey = (row: DashboardRecord) => JSON.stringify([row.kind, row.kind === 'expense' ? row.categoryId : row.category]);
  const recordKey = (row: DashboardRecord) => `${row.kind}:${row.id}`;
  type Choice = { mode: 'include' | 'exclude'; keys: string[] };
  type Scope = { categories: Choice; items: Choice; excluded: string[] };
  function matcher(scope: Scope) {
    const categories = new Set(scope.categories.keys), items = new Set(scope.items.keys), excluded = new Set(scope.excluded);
    return (row: DashboardRecord) => (categories.has(categoryKey(row)) === (scope.categories.mode === 'include'))
      && (items.has(itemKey(row)) === (scope.items.mode === 'include')) && !excluded.has(recordKey(row));
  }
  function matches(row: DashboardRecord, scope: Scope) {
    return matcher(scope)(row);
  }
  function compare(records: DashboardRecord[], from: string, to: string, group: 'category' | 'item', chosen: string[] | null = null, alignDays = false) {
    const months: Array<{ key: string; from: string; to: string; partial: boolean }> = [];
    for (let key = from.slice(0, 7); key <= to.slice(0, 7);) {
      const next = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 1)).toISOString().slice(0, 10);
      const end = new Date(Date.parse(next) - 86400000).toISOString().slice(0, 10);
      if (chosen === null || chosen.includes(key)) months.push({ key, from: from > key + '-01' ? from : key + '-01', to: to < end ? to : end, partial: from > key + '-01' || to < end });
      key = next.slice(0, 7);
    }
    if (alignDays && months.length) {
      const first = Math.max(...months.map(m => Number(m.from.slice(8))));
      const last = Math.min(...months.map(m => Number(m.to.slice(8))));
      for (const month of months) {
        month.from = month.key + '-' + String(first).padStart(2, '0');
        month.to = month.key + '-' + String(last).padStart(2, '0');
        month.partial = month.partial || first !== 1 || month.to !== new Date(Date.UTC(Number(month.key.slice(0, 4)), Number(month.key.slice(5)), 0)).toISOString().slice(0, 10);
      }
    }
    const rows = new Map<string, { key: string; label: string; values: number[]; counts: number[]; total: number }>();
    const indexes = new Map(months.map((m, i) => [m.key, i]));
    for (const record of records) {
      if (record.kind !== 'expense') continue;
      const i = indexes.get(record.day.slice(0, 7));
      if (i === undefined || record.day < months[i]!.from || record.day > months[i]!.to) continue;
      const key = group === 'category' ? categoryKey(record) : itemKey(record);
      const row = rows.get(key) ?? { key, label: group === 'category' ? record.category : record.label.trim(), values: months.map(() => 0), counts: months.map(() => 0), total: 0 };
      row.values[i]! += record.amountMinor;
      row.counts[i]!++;
      row.total += record.amountMinor;
      rows.set(key, row);
    }
    const sorted = [...rows.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    return { months, rows: sorted, totals: months.map((_, i) => sorted.reduce((sum, r) => sum + r.values[i]!, 0)), counts: months.map((_, i) => sorted.reduce((sum, r) => sum + r.counts[i]!, 0)) };
  }
  function change(current: number, previous: number) {
    return { amount: current - previous, percent: previous === 0 ? null : (current - previous) / previous * 100 };
  }
  return { itemKey, categoryKey, recordKey, matches, matcher, compare, change };
}
