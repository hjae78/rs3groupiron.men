import { useCallback, useMemo, useState } from 'react';
import { DATE_RANGES, rangeBounds, toDayInput, type DateRange } from '../lib/day';
import { usePagedHistory, type HistoryPage } from './usePagedHistory';
import { useUrlState } from './useUrlState';

export type DayRangeBounds = { from: string; to?: string } | null;

export type DayRangeFetchCtx = {
  bounds: DayRangeBounds;
  memberFilter: string;
  range: DateRange;
  day: string;
  today: string;
};

type Options<T> = {
  fetchPage: (
    ctx: DayRangeFetchCtx,
    args: { before: string | undefined; limit: number; signal: AbortSignal },
  ) => Promise<HistoryPage<T>>;
  pageSize: number;
  errorFallback: string;
  dataRevision?: number;
  refreshMs?: number;
  /** ISO instant the group was created; the calendar stops there. */
  createdAt?: string;
};

/**
 * The day/range/member URL-state triple shared by the history panels (Drops,
 * Achievements, Ledger), wired straight into usePagedHistory. Callers still
 * own merging injected/demo entries and deriving markedDays from the result,
 * since both differ per panel.
 */
export function useDayRangeHistory<T extends { at: string }>({
  fetchPage,
  pageSize,
  errorFallback,
  dataRevision,
  refreshMs,
  createdAt,
}: Options<T>) {
  const [memberFilter, setMemberFilter] = useUrlState('member', 'all');
  const [today] = useState(() => toDayInput(new Date()));
  const [day, setDay] = useUrlState('day', today);
  const [range, setRange] = useUrlState<DateRange>('range', '24h', { allowed: DATE_RANGES });

  const bounds = useMemo(() => rangeBounds(range, day, today), [range, day, today]);

  const boundFetchPage = useCallback(
    (args: { before: string | undefined; limit: number; signal: AbortSignal }) =>
      fetchPage({ bounds, memberFilter, range, day, today }, args),
    [fetchPage, bounds, memberFilter, range, day, today],
  );

  const paged = usePagedHistory<T>({
    fetchPage: boundFetchPage,
    pageSize,
    errorFallback,
    dataRevision,
    refreshMs,
  });

  const earliest = useMemo(() => {
    if (!createdAt) return undefined;
    const at = new Date(createdAt);
    return Number.isNaN(at.getTime()) ? undefined : toDayInput(at);
  }, [createdAt]);

  return {
    today,
    day,
    setDay,
    range,
    setRange,
    memberFilter,
    setMemberFilter,
    bounds,
    earliest,
    ...paged,
  };
}
