/**
 * Calendar-day helpers for the ledger and achievement filters.
 *
 * Days are handled in the viewer's own timezone: the `<input type="date">`
 * value is local, and `dayBounds` converts it to the real instants the API
 * filters on, so a "day" means what the person looking at it expects.
 */

/** `YYYY-MM-DD` for a Date, in local time (not UTC). */
export function toDayInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight-to-midnight instants for a `YYYY-MM-DD` value. */
export function dayBounds(day: string): { from: string; to: string } | null {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return null;
  return {
    from: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    to: new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString(),
  };
}

const FULL_DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * Sticky day-header label. Today and yesterday keep their date alongside the
 * word, so a header is never ambiguous once it has scrolled away from the
 * picker: "Today · 16 Oct 2026", else "14 Oct 2026".
 */
export function dayLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = toDayInput(at);
  const date = FULL_DATE.format(at);
  if (day === toDayInput(now)) return `Today · ${date}`;
  if (day === shiftDay(toDayInput(now), -1)) return `Yesterday · ${date}`;
  return date;
}

/** `day` is whatever the calendar last picked; the rest are rolling windows. */
export type DateRange = '24h' | 'today' | '30d' | 'all' | 'day';

export const DATE_RANGES: DateRange[] = ['24h', 'today', '30d', 'all', 'day'];

const DAY_MS = 86_400_000;

/** Instants a range covers, or null for everything. */
export function rangeBounds(
  range: DateRange,
  day: string,
  today: string,
): { from: string; to?: string } | null {
  if (range === 'all') return null;
  if (range === 'today') return dayBounds(today);
  if (range === 'day') return day ? dayBounds(day) : null;
  const span = range === '24h' ? DAY_MS : 30 * DAY_MS;
  return { from: new Date(Date.now() - span).toISOString() };
}

/** Move a `YYYY-MM-DD` value by whole days, rolling months/years correctly. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return toDayInput(new Date(y, m - 1, d + days));
}

/** Buckets already-sorted (newest-first) entries under their day label. */
export function groupEntriesByDay<T extends { at: string }>(
  entries: readonly T[],
): Array<{ day: string; rows: T[] }> {
  const out: Array<{ day: string; rows: T[] }> = [];
  for (const entry of entries) {
    const day = dayLabel(entry.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(entry);
    else out.push({ day, rows: [entry] });
  }
  return out;
}
