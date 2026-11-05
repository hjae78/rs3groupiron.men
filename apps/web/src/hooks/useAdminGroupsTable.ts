import { useCallback, useEffect, useState } from 'react';
import {
  fetchAdminGroups,
  type AdminGroupFilter,
  type AdminGroupsPage,
  type AdminGroupSort,
  type AdminSortDir,
} from '../api/adminClient';
import { useLatestRequest } from './useLatestRequest';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;

export function useAdminGroupsTable({
  token,
  reloadKey,
  onFailure,
}: {
  token: string;
  reloadKey: number;
  onFailure: (err: unknown, fallback: string, setter: (message: string) => void) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AdminGroupFilter>('all');
  const [sort, setSort] = useState<AdminGroupSort>('created_at');
  const [dir, setDir] = useState<AdminSortDir>('desc');
  const [page, setPage] = useState(1);
  const [table, setTable] = useState<AdminGroupsPage | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const tableRequest = useLatestRequest();

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      const settled = await tableRequest((signal) =>
        fetchAdminGroups(token, {
          q: query,
          page,
          pageSize: PAGE_SIZE,
          sort,
          dir,
          filter,
          signal,
        }),
      );
      if (!settled || !live) return;
      setLoading(false);
      if (settled.ok) {
        setTable(settled.value);
        setTableError(null);
      } else {
        onFailure(settled.error, 'Could not load groups', setTableError);
      }
    })();
    return () => {
      live = false;
    };
  }, [token, query, page, sort, dir, filter, reloadKey, tableRequest, onFailure]);

  const onSort = useCallback(
    (next: AdminGroupSort) => {
      if (next === sort) {
        setDir((current) => (current === 'desc' ? 'asc' : 'desc'));
      } else {
        setSort(next);
        setDir(next === 'name' ? 'asc' : 'desc');
      }
      setPage(1);
    },
    [sort],
  );

  const onFilterChange = useCallback((value: AdminGroupFilter) => {
    setFilter(value);
    setPage(1);
  }, []);

  const total = table?.total ?? 0;
  const pages = table?.pages ?? 1;

  return {
    search,
    setSearch,
    query,
    filter,
    onFilterChange,
    sort,
    dir,
    onSort,
    page,
    setPage,
    pages,
    total,
    table,
    tableError,
    loading,
    pageSize: PAGE_SIZE,
  };
}
