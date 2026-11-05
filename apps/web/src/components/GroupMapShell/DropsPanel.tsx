import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEMO_GROUP,
  fetchAchievements,
  fetchDropRules,
  fetchRareItemCatalogue,
  updateDropRules,
  type Achievement,
  type DropRules,
} from '../../api/groupClient';
import { useDismiss } from '../../hooks/useDismiss';
import { useDayRangeHistory, type DayRangeFetchCtx } from '../../hooks/useDayRangeHistory';
import { useUrlState, useUrlText } from '../../hooks/useUrlState';
import { groupEntriesByDay, rangeBounds, toDayInput } from '../../lib/day';
import { exportRows } from '../../lib/exportTable';
import { colorForName, formatQty } from '../../lib/items';
import { getItemPrices, formatGp, parseGp } from '../../lib/itemPrices';
import { lookupItemName, searchItemNames, useItemNames } from '../../lib/itemNames';
import { useGePrices } from '../../lib/gePrices';
import { timestamp, toUnix } from '../../lib/time';
import { Modal } from '../Modal';
import { DayNav, RANGE_OPTIONS } from './DayNav';
import { Dropdown, type DropdownOption } from './Dropdown';
import { EmptyState, GemGlyph, SearchGlyph } from './EmptyState';
import { ExportMenu, type ExportFormat } from './ExportMenu';
import { ItemIcon } from './ItemIcon';
import { LoadMoreButton, PanelStatus } from './PanelChrome';
import { Segmented, type SegmentedOption } from './Segmented';
import { memberDropdownOption, type MemberBadge } from './memberOptions';

const PAGE_SIZE = 50;

const THRESHOLDS: Array<{ id: string; label: string; value: number }> = [
  { id: 'off', label: 'Off', value: 0 },
  { id: '100k', label: '100K', value: 100_000 },
  { id: '1m', label: '1M', value: 1_000_000 },
  { id: '5m', label: '5M', value: 5_000_000 },
  { id: '10m', label: '10M', value: 10_000_000 },
];

type DropsPanelProps = {
  groupName?: string;
  groupToken?: string;
  dataRevision?: number;
  members?: ReadonlyArray<MemberBadge>;
  /** ISO instant the group was created; the calendar stops there. */
  createdAt?: string;
  /** Synthetic demo entries to show alongside the API's; drops are kept. */
  injected?: ReadonlyArray<Achievement>;
};

const EXPORT_FORMATS: ExportFormat[] = ['csv', 'json'];

type DropsView = 'list' | 'grid';

const VIEW_VALUES: DropsView[] = ['list', 'grid'];

const VIEWS: Array<SegmentedOption<DropsView>> = [
  { id: 'list', label: 'List' },
  { id: 'grid', label: 'Grid' },
];

function itemLabel(itemId: number) {
  return lookupItemName(itemId) ?? `Item ${itemId}`;
}

type DropRulesBody = Parameters<typeof updateDropRules>[2];

/**
 * The shared list the group inherits, recovered from a resolved rule set: the
 * items it tracks that it didn't add itself, plus the ones it has silenced.
 */
function sharedListOf(rules: DropRules) {
  const own = new Set(rules.include);
  return [
    ...new Set([...rules.items.filter((id) => !own.has(id)), ...rules.exclude]),
  ];
}

/**
 * The server's merge run in the browser. The demo group has no token to write
 * with, so its tracking panel edits a local copy instead of being inert — the
 * rules behave exactly as they would on a real group, they just don't outlive
 * the page.
 */
function applyDropRules(
  rules: DropRules,
  shared: number[],
  body: DropRulesBody,
): DropRules {
  const include = new Set(rules.include);
  const exclude = new Set(rules.exclude);
  const windows = new Map(
    (rules.quantities ?? []).map((q) => [q.item_id, { min: q.min, max: q.max }]),
  );

  // Clear first, so one call can move an item from one list to the other.
  for (const id of body.clear ?? []) {
    include.delete(id);
    exclude.delete(id);
    windows.delete(id);
  }
  for (const id of body.include ?? []) {
    exclude.delete(id);
    include.add(id);
    windows.delete(id);
  }
  for (const id of body.exclude ?? []) {
    include.delete(id);
    exclude.add(id);
    windows.delete(id);
  }
  // Ranges last, so one call can add an item and give it a window.
  for (const range of body.quantities ?? []) {
    include.add(range.item_id);
    exclude.delete(range.item_id);
    if (range.min == null && range.max == null) windows.delete(range.item_id);
    else windows.set(range.item_id, { min: range.min, max: range.max });
  }

  const items = new Set(include);
  for (const id of shared) if (!exclude.has(id)) items.add(id);

  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return {
    threshold: body.threshold ?? rules.threshold,
    include: sorted(include),
    exclude: sorted(exclude),
    quantities: [...windows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([item_id, w]) => ({ item_id, ...w })),
    items: sorted(items),
    shared_list_size: rules.shared_list_size,
  };
}

type QtyWindow = { min: number | null; max: number | null };

/** "2+", "up to 10", "2–10" — or nothing at all when the window is open. */
function rangeLabel(window: QtyWindow | undefined) {
  if (!window) return '';
  const { min, max } = window;
  if (min != null && max != null) return `${formatQty(min)}–${formatQty(max)}`;
  if (min != null) return `${formatQty(min)}+`;
  if (max != null) return `up to ${formatQty(max)}`;
  return '';
}

/**
 * Demo edits live here rather than in component state so they survive leaving
 * the page and coming back, the way a saved rule set would.
 */
let demoRules: DropRules | null = null;

export function DropsPanel({
  groupName = DEMO_GROUP,
  groupToken = '',
  dataRevision,
  members = [],
  createdAt,
  injected,
}: DropsPanelProps) {
  return (
    <div className="gms-drops">
      <DropsFeed
        groupName={groupName}
        groupToken={groupToken}
        dataRevision={dataRevision}
        members={members}
        createdAt={createdAt}
        injected={injected}
      />
      <TrackingPanel groupName={groupName} groupToken={groupToken} />
    </div>
  );
}

function DropsFeed({
  groupName,
  groupToken,
  dataRevision,
  members,
  createdAt,
  injected,
}: Required<Pick<DropsPanelProps, 'groupName' | 'groupToken' | 'members'>> & {
  dataRevision?: number;
  createdAt?: string;
  injected?: ReadonlyArray<Achievement>;
}) {
  const [query, setQuery] = useUrlText('q');
  const [view, setView] = useUrlState<DropsView>('view', 'list', { allowed: VIEW_VALUES });
  const namesVersion = useItemNames();
  useGePrices();

  const fetchPage = useCallback(
    (
      { bounds, memberFilter }: DayRangeFetchCtx,
      { before, limit, signal }: { before?: string; limit: number; signal: AbortSignal },
    ) =>
      fetchAchievements(groupName, groupToken, {
        limit,
        before,
        kind: 'drop',
        member: memberFilter === 'all' ? undefined : memberFilter,
        from: bounds?.from,
        to: bounds?.to,
        signal,
      }),
    [groupName, groupToken],
  );

  const {
    today,
    day,
    setDay,
    range,
    setRange,
    memberFilter,
    setMemberFilter,
    entries: fetched,
    hasMore,
    error,
    loading,
    oldest,
    loadMore,
    earliest,
  } = useDayRangeHistory<Achievement>({
    fetchPage,
    pageSize: PAGE_SIZE,
    errorFallback: 'Failed to load rare drops',
    dataRevision,
    createdAt,
  });

  /**
   * Injected entries never went through the API, so the member and range
   * filters are applied here. They are merged by time rather than pinned to the
   * top: a seeded drop from this morning belongs under this morning's heading.
   */
  const entries = useMemo(() => {
    const mine = injected?.filter((entry) => entry.kind === 'drop') ?? [];
    if (!mine.length) return fetched;

    const bounds = rangeBounds(range, day, today);
    const kept = mine.filter((entry) => {
      if (memberFilter !== 'all' && entry.name !== memberFilter) return false;
      if (bounds?.from && entry.at < bounds.from) return false;
      if (bounds?.to && entry.at > bounds.to) return false;
      return true;
    });
    if (!kept.length) return fetched;

    return [...kept, ...fetched].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [injected, fetched, memberFilter, range, day, today]);

  const memberOpts = useMemo<Array<DropdownOption<string>>>(
    () => [
      { id: 'all', label: 'All members' },
      ...members.map((m) => memberDropdownOption(m.name, m.color)),
    ],
    [members],
  );

  // What a search matches: whoever got it, the item, and the source line. Built
  // once per page of drops rather than per keystroke. namesVersion is a
  // dependency because itemLabel reads a catalogue that arrives late — without
  // it this keeps matching on "Item 565" placeholders.
  const haystacks = useMemo(
    () =>
      entries.map((entry) => {
        const item = entry.item_id != null ? itemLabel(entry.item_id) : entry.title;
        return `${entry.name} ${item} ${entry.detail ?? ''}`.toLowerCase();
      }),
    [entries, namesVersion],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((_, i) => haystacks[i]!.includes(q));
  }, [entries, haystacks, query]);

  // Days with a drop get a dot in the calendar.
  const markedDays = useMemo(
    () => new Set(entries.map((entry) => toDayInput(new Date(entry.at)))),
    [entries],
  );

  /** Exports what is on screen: when, who and what dropped. */
  const runExport = useCallback(
    (format: ExportFormat) => {
      const rows = visible.map((entry) => ({
        at: toUnix(entry.at),
        member: entry.name,
        item: entry.item_id != null ? itemLabel(entry.item_id) : entry.title,
        item_id: entry.item_id ?? 0,
        source: entry.detail ?? '',
      }));
      exportRows(format === 'json' ? 'json' : 'csv', {
        filenameParts: [groupName, 'rare-drops', range],
        sheet: 'Rare drops',
        headers: ['Time (unix)', 'Member', 'Item', 'Item ID', 'Source'],
        rows,
        toCsvRow: (r) => [r.at, r.member, r.item, r.item_id, r.source],
      });
    },
    [visible, groupName, range],
  );

  const groups = useMemo(() => groupEntriesByDay(visible), [visible]);

  const summary =
    entries.length === 0
      ? 'Nothing logged yet'
      : `${entries.length} drop${entries.length === 1 ? '' : 's'} logged`;

  return (
    <section className="gms-panel gms-drops-feed" aria-label="Rare drops" aria-busy={loading}>
      <div className="gms-panel-head">
        <div className="gms-panel-head-text">
          <h1 className="gms-page-title">Rare drops</h1>
          <span className="gms-panel-sub">{summary}</span>
        </div>
        <input
          className="gms-input gms-drops-search"
          value={query}
          placeholder="Search drops"
          aria-label="Search drops"
          onChange={(e) => setQuery(e.target.value)}
        />

        <Dropdown
          ariaLabel="Member"
          value={memberFilter}
          options={memberOpts}
          onChange={setMemberFilter}
        />

        <Segmented
          options={RANGE_OPTIONS}
          value={range}
          ariaLabel="Range"
          onChange={setRange}
        />

        <DayNav
          day={day || today}
          today={today}
          earliest={earliest}
          marked={markedDays}
          picked={range === 'day'}
          onChange={(next) => {
            setDay(next);
            setRange('day');
          }}
        />

        <Segmented options={VIEWS} value={view} ariaLabel="View" onChange={setView} />

        <ExportMenu
          busy={null}
          disabled={visible.length === 0}
          formats={EXPORT_FORMATS}
          onExport={runExport}
        />
      </div>

      <div className="gms-panel-body gms-drops-body">
        <PanelStatus
          error={error}
          loading={loading && entries.length === 0}
        />

        {!loading && !error && visible.length === 0 && query.trim() && (
          <EmptyState
            icon={<SearchGlyph />}
            title={`Nothing matches “${query.trim()}”`}
            body="Check the spelling or clear the search to see every drop."
          >
            <button type="button" className="gms-btn" onClick={() => setQuery('')}>
              Clear search
            </button>
          </EmptyState>
        )}

        {!loading && !error && visible.length === 0 && !query.trim() && (
          <EmptyState
            icon={<GemGlyph />}
            title="No rare drops yet"
            body="Drops that match your tracking rules will show up here the moment someone gets one."
          />
        )}

        {groups.map((group) => (
          <div key={group.day} className="gms-drops-group">
            <div className="gms-day-head">{group.day}</div>
            {view === 'grid' ? (
              <div className="gms-drops-grid">
                {group.rows.map((entry) => (
                  <DropCard key={entry.id} entry={entry} />
                ))}
              </div>
            ) : (
              group.rows.map((entry) => <DropRow key={entry.id} entry={entry} />)
            )}
          </div>
        ))}

        {hasMore && <LoadMoreButton loading={loading} disabled={!oldest} onClick={loadMore} />}
      </div>
    </section>
  );
}

/** The same drop as a card: art first, then who got it and what it is worth. */
const DropCard = memo(function DropCard({ entry }: { entry: Achievement }) {
  const { stamp, absolute } = timestamp(entry.at, false);
  const name = entry.item_id != null ? itemLabel(entry.item_id) : entry.title;
  const value = entry.item_id != null ? getItemPrices(entry.item_id).ge : 0;

  return (
    <article className="gms-drop-card" title={`${entry.name} received ${name} · ${absolute}`}>
      <span className="gms-drop-card-art">
        {entry.item_id != null ? (
          <ItemIcon itemId={entry.item_id} quantity={entry.quantity ?? undefined} />
        ) : (
          <GemGlyph />
        )}
      </span>

      <span className="gms-drop-card-name">{name}</span>

      <span className="gms-drop-card-who" style={{ color: colorForName(entry.name) }}>
        {entry.name}
      </span>

      <span className="gms-drop-gp">
        <img src="/item-prices/ge.png" alt="GE" width={16} height={16} />
        {value > 0 ? formatGp(value) : '—'}
      </span>

      <span className="gms-drop-meta">
        {stamp}
        {entry.detail ? ` · ${entry.detail}` : ''}
      </span>
    </article>
  );
});

const DropRow = memo(function DropRow({ entry }: { entry: Achievement }) {
  const { stamp, absolute } = timestamp(entry.at, false);
  const name = entry.item_id != null ? itemLabel(entry.item_id) : entry.title;
  const value = entry.item_id != null ? getItemPrices(entry.item_id).ge : 0;

  return (
    <div className="gms-drop-row">
      <span className="gms-drop-icon">
        {entry.item_id != null ? (
          <ItemIcon itemId={entry.item_id} quantity={entry.quantity ?? undefined} />
        ) : (
          <GemGlyph />
        )}
      </span>
      <div className="gms-drop-main">
        <span className="gms-drop-headline">
          <strong style={{ color: colorForName(entry.name) }}>{entry.name}</strong> received{' '}
          <strong className="gms-drop-item">{name}</strong>
        </span>
        <span className="gms-drop-meta" title={absolute}>
          {stamp}
          {entry.detail ? ` · ${entry.detail}` : ''}
        </span>
      </div>
      <span className="gms-drop-value">
        <span className="gms-drop-gp">
          <img src="/item-prices/ge.png" alt="GE" width={16} height={16} />
          {value > 0 ? formatGp(value) : '—'}
        </span>
      </span>
    </div>
  );
});

function TrackingPanel({ groupName, groupToken }: { groupName: string; groupToken: string }) {
  const [rules, setRules] = useState<DropRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thresholdInput, setThresholdInput] = useState('');
  const [query, setQuery] = useState('');
  const [sugOpen, setSugOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const namesVersion = useItemNames();
  useGePrices();

  // The demo group has no token, so its rules are edited locally instead of
  // being locked: the panel is the point of the page.
  const demo = groupName === DEMO_GROUP && !groupToken;
  const readOnly = !groupToken && !demo;

  // The inherited list never changes, so it is captured from the first load
  // and reused to resolve every local edit.
  const sharedRef = useRef<number[]>([]);

  useEffect(() => {
    const ac = new AbortController();
    fetchDropRules(groupName, groupToken, ac.signal)
      .then((fetched) => {
        sharedRef.current = sharedListOf(fetched);
        const next = demo && demoRules ? demoRules : fetched;
        setRules(next);
        setThresholdInput(next.threshold ? String(next.threshold) : '');
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load rules');
      });
    return () => ac.abort();
  }, [groupName, groupToken, demo]);

  const save = useCallback(
    async (body: DropRulesBody) => {
      if (readOnly) {
        setError('This group is read-only. Create your own group to change tracking.');
        return;
      }
      if (demo) {
        setError(null);
        setRules((prev) => {
          if (!prev) return prev;
          demoRules = applyDropRules(prev, sharedRef.current, body);
          return demoRules;
        });
        return;
      }
      try {
        setError(null);
        setRules(await updateDropRules(groupName, groupToken, body));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save');
      }
    },
    [groupName, groupToken, readOnly, demo],
  );

  const parsedThreshold = thresholdInput ? parseGp(thresholdInput) : null;
  const thresholdError = thresholdInput !== '' && parsedThreshold === null;

  const activeChip = useMemo(() => {
    const current = rules?.threshold ?? 0;
    return THRESHOLDS.find((t) => t.value === current)?.id ?? 'custom';
  }, [rules?.threshold]);

  // Stable per fetched rules object, so the catalogue scan below does not
  // re-run on every keystroke-unrelated render.
  const include = useMemo(() => rules?.include ?? [], [rules]);
  const exclude = rules?.exclude ?? [];

  const windows = useMemo(
    () =>
      new Map(
        (rules?.quantities ?? []).map((q) => [q.item_id, { min: q.min, max: q.max }]),
      ),
    [rules],
  );

  const suggestions = useMemo(() => {
    if (!query.trim()) return [];
    const taken = new Set(include);
    return searchItemNames(query, 8)
      .filter((hit) => !taken.has(hit.id))
      .map((hit) => ({
        ...hit,
        pre: hit.name.slice(0, hit.at),
        hit: hit.name.slice(hit.at, hit.at + query.trim().length),
        post: hit.name.slice(hit.at + query.trim().length),
        value: getItemPrices(hit.id).ge,
      }));
  }, [query, include, namesVersion]);

  function addItem(itemId: number) {
    setQuery('');
    setSugOpen(false);
    void save({ include: [...include, itemId] });
  }

  function removeItem(itemId: number) {
    setMenuFor(null);
    void save({ clear: [itemId] });
  }

  if (error && !rules) {
    return (
      <aside className="gms-panel gms-tracking" aria-label="Tracking">
        <div className="gms-panel-head">
          <div className="gms-panel-head-text">
            <h2 className="gms-section-title">Tracking</h2>
            <span className="gms-panel-sub">Choose what counts as a rare drop for this group.</span>
          </div>
        </div>
        <div className="gms-panel-body">
          <PanelStatus error={error} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="gms-panel gms-tracking" aria-label="Tracking">
      <div className="gms-panel-head">
        <div className="gms-panel-head-text">
          <h2 className="gms-section-title">Tracking</h2>
          <span className="gms-panel-sub">Choose what counts as a rare drop for this group.</span>
        </div>
      </div>

      <div className="gms-panel-body gms-tracking-body">
        {error && <PanelStatus error={error} />}

        {demo && (
          <span className="gms-tracking-demo">
            Try it out — changes here stay in your browser and aren’t saved to
            the demo group.
          </span>
        )}

        <div className="gms-tracking-section">
          <span className="gms-micro">Value threshold</span>
          <span className="gms-tracking-hint">
            Any drop worth at least this much on the GE is logged.
          </span>
          <div className="gms-tracking-chips">
            {THRESHOLDS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={
                  activeChip === t.id ? 'gms-chip gms-chip--active' : 'gms-chip'
                }
                aria-pressed={activeChip === t.id}
                onClick={() => {
                  setThresholdInput(t.value ? String(t.value) : '');
                  void save({ threshold: t.value });
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="gms-tracking-threshold">
            <span className="gms-input-wrap">
              <img src="/item-prices/ge.png" alt="" width={16} height={16} />
              <input
                className="gms-input gms-input--icon"
                value={thresholdInput}
                inputMode="numeric"
                aria-label="Custom threshold in gp"
                aria-invalid={thresholdError}
                placeholder="Custom, e.g. 2.5m"
                onChange={(e) => setThresholdInput(e.target.value)}
                onBlur={() => {
                  if (parsedThreshold != null && parsedThreshold !== rules?.threshold) {
                    void save({ threshold: parsedThreshold });
                  }
                }}
              />
            </span>
            <span
              className={
                thresholdError ? 'gms-tracking-parsed gms-tracking-parsed--bad' : 'gms-tracking-parsed'
              }
            >
              {thresholdError
                ? 'Use a number like 50, 2k or 1.5m'
                : parsedThreshold
                  ? formatGp(parsedThreshold)
                  : 'Off'}
            </span>
          </div>
        </div>

        <div className="gms-tracking-section gms-tracking-section--grow">
          <div className="gms-tracking-section-head">
            <span className="gms-micro">Your items</span>
            <span className="gms-tracking-count">{include.length}</span>
          </div>
          <span className="gms-tracking-hint">
            Always log these, whatever they’re worth.
          </span>

          <form
            className="gms-tracking-add"
            onSubmit={(e) => {
              e.preventDefault();
              const first = suggestions[0];
              if (first) addItem(first.id);
            }}
          >
            <input
              className="gms-input"
              value={query}
              placeholder="Search or add an item"
              aria-label="Search or add an item"
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setSugOpen(true);
              }}
              onFocus={() => setSugOpen(true)}
              onBlur={() => window.setTimeout(() => setSugOpen(false), 120)}
            />
            <button
              type="submit"
              className="gms-btn"
              disabled={suggestions.length === 0 || readOnly}
            >
              Add
            </button>

            {sugOpen && suggestions.length > 0 && (
              <div className="gms-suggest" role="listbox">
                <span className="gms-suggest-head">ADD TO YOUR ITEMS</span>
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="gms-suggest-opt"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addItem(s.id);
                    }}
                  >
                    <ItemIcon itemId={s.id} />
                    <span className="gms-suggest-name">
                      {s.pre}
                      <strong>{s.hit}</strong>
                      {s.post}
                    </span>
                    <span className="gms-suggest-val">{s.value > 0 ? formatGp(s.value) : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </form>

          <div className="gms-tracking-list">
            {include.map((itemId) => (
              <div key={itemId} className="gms-tracking-item">
                <ItemIcon itemId={itemId} />
                <span className="gms-tracking-item-name">{itemLabel(itemId)}</span>
                {/* The window is on the row as well as in the menu: otherwise a
                    rule that silences most drops of an item is invisible. */}
                {rangeLabel(windows.get(itemId)) && (
                  <span className="gms-tracking-item-qty" title="Quantity range">
                    {rangeLabel(windows.get(itemId))}
                  </span>
                )}
                <button
                  type="button"
                  className="gms-tracking-item-menu"
                  aria-haspopup="menu"
                  aria-expanded={menuFor === itemId}
                  aria-label={`Options for ${itemLabel(itemId)}`}
                  onClick={() => setMenuFor(menuFor === itemId ? null : itemId)}
                >
                  ⋯
                </button>
                {menuFor === itemId && (
                  <QuantityMenu
                    itemId={itemId}
                    window={windows.get(itemId)}
                    readOnly={readOnly}
                    onClose={() => setMenuFor(null)}
                    onSave={(min, max) => {
                      setMenuFor(null);
                      void save({ quantities: [{ item_id: itemId, min, max }] });
                    }}
                    onRemove={() => removeItem(itemId)}
                  />
                )}
              </div>
            ))}
            {include.length === 0 && (
              <span className="gms-tracking-none">No items added yet.</span>
            )}
          </div>
        </div>
      </div>

      <div className="gms-tracking-foot">
        <button type="button" className="gms-tracking-presets" onClick={() => setPresetOpen(true)}>
          <span className="gms-tracking-presets-text">
            <strong>Manage suggested drops</strong>
            <em>
              {(rules?.shared_list_size ?? 0) - exclude.length} of{' '}
              {rules?.shared_list_size ?? 0} on
            </em>
          </span>
          <span className="gms-tracking-presets-caret" aria-hidden>
            ›
          </span>
        </button>
      </div>

      <PresetModal
        open={presetOpen}
        rules={rules}
        readOnly={readOnly}
        onClose={() => setPresetOpen(false)}
        onToggle={(itemId, on) => void save(on ? { clear: [itemId] } : { exclude: [itemId] })}
        onSetMany={(itemIds, on) => {
          if (itemIds.length) void save(on ? { clear: itemIds } : { exclude: itemIds });
        }}
      />
    </aside>
  );
}

function PresetModal({
  open,
  rules,
  readOnly,
  onClose,
  onToggle,
  onSetMany,
}: {
  open: boolean;
  rules: DropRules | null;
  readOnly: boolean;
  onClose: () => void;
  onToggle: (itemId: number, on: boolean) => void;
  onSetMany: (itemIds: number[], on: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<DropsView>('list');
  const [catalogue, setCatalogue] = useState<number[] | null>(null);
  const namesVersion = useItemNames();
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * The shared list straight from the API, so the modal shows every suggested
   * drop rather than only the ones still visible in the group's resolved set.
   * Fetched once the modal is first opened; if it fails the list is recovered
   * from the rules, which is the same set minus anything the group has added
   * to its own list.
   */
  useEffect(() => {
    if (!open || catalogue) return;
    const ac = new AbortController();
    fetchRareItemCatalogue(ac.signal)
      .then((c) => setCatalogue(c.ids))
      .catch(() => {
        if (!ac.signal.aborted && rules) setCatalogue(sharedListOf(rules));
      });
    return () => ac.abort();
  }, [open, catalogue, rules]);

  const preset = useMemo(() => {
    const ids = catalogue ?? (rules ? sharedListOf(rules) : []);
    // Anything the group added itself is managed in "Your items"; listing it
    // here too would let one switch quietly delete it from the other list.
    const own = new Set(rules?.include ?? []);
    return ids
      .filter((id) => !own.has(id))
      .map((id) => ({ id, name: itemLabel(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [catalogue, rules, namesVersion]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return preset;
    return preset.filter((p) => p.name.toLowerCase().includes(q));
  }, [preset, query]);

  const off = new Set(rules?.exclude ?? []);
  const onCount = preset.length - off.size;

  return (
    <Modal
      open={open}
      onClose={onClose}
      titleId="gms-presets-title"
      title="Suggested drops"
      className="gms-modal--presets"
    >
      <div className="gms-modal-body gms-presets">
        <p className="gms-presets-sub">
          Our list of notable RS3 drops. Switch off any you don’t care about.
        </p>

        <div className="gms-presets-bar">
          <input
            className="gms-input"
            value={query}
            placeholder="Search drops"
            aria-label="Search drops"
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* One call for the lot: the rules endpoint takes id arrays (up to
              500 per field), so switching the whole list is a single request
              rather than one per item. */}
          <button
            type="button"
            className="gms-btn"
            disabled={readOnly}
            onClick={() =>
              onSetMany(
                shown.filter((p) => off.has(p.id)).map((p) => p.id),
                true,
              )
            }
          >
            All on
          </button>
          <button
            type="button"
            className="gms-btn"
            disabled={readOnly}
            onClick={() =>
              onSetMany(
                shown.filter((p) => !off.has(p.id)).map((p) => p.id),
                false,
              )
            }
          >
            All off
          </button>

          <Segmented options={VIEWS} value={view} ariaLabel="View" onChange={setView} />
        </div>

        <div
          className={
            view === 'grid'
              ? 'gms-presets-list gms-presets-list--grid'
              : 'gms-presets-list'
          }
          ref={listRef}
        >
          {shown.map((p) => (
            <PresetRow
              key={p.id}
              id={p.id}
              name={p.name}
              on={!off.has(p.id)}
              grid={view === 'grid'}
              readOnly={readOnly}
              onToggle={onToggle}
            />
          ))}
          {shown.length === 0 && <span className="gms-tracking-none">No drops match.</span>}
        </div>

        <div className="gms-presets-foot">
          <span className="gms-tracking-count">
            {onCount} of {preset.length} on
          </span>
          <button type="button" className="gms-btn gms-btn--gold" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The quantity window for one tracked item, plus the destructive actions.
 *
 * Amounts accept the same shorthand as the value threshold ("2k", "1.5m"),
 * because a window on a stackable item is usually a round number nobody wants
 * to type in full. Edits are held locally and committed on Save, so a
 * half-typed "1" never briefly becomes the rule.
 */
function QuantityMenu({
  itemId,
  window: current,
  readOnly,
  onClose,
  onSave,
  onRemove,
}: {
  itemId: number;
  window: QtyWindow | undefined;
  readOnly: boolean;
  onClose: () => void;
  onSave: (min: number | null, max: number | null) => void;
  onRemove: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [min, setMin] = useState(current?.min == null ? '' : String(current.min));
  const [max, setMax] = useState(current?.max == null ? '' : String(current.max));

  useDismiss(true, rootRef, onClose);

  const parsedMin = min.trim() ? parseGp(min) : null;
  const parsedMax = max.trim() ? parseGp(max) : null;
  const badNumber =
    (min.trim() !== '' && parsedMin == null) || (max.trim() !== '' && parsedMax == null);
  const inverted = parsedMin != null && parsedMax != null && parsedMin > parsedMax;
  const error = badNumber
    ? 'Use a number like 50, 2k or 1.5m'
    : inverted
      ? 'Min is higher than max'
      : '';

  return (
    <div className="gms-qty-menu" role="menu" aria-label={itemLabel(itemId)} ref={rootRef}>
      <div className="gms-qty-head">
        <ItemIcon itemId={itemId} size={22} />
        <strong>{itemLabel(itemId)}</strong>
      </div>

      <span className="gms-qty-label">QUANTITY RANGE</span>
      <span className="gms-qty-hint">
        Only log drops within this amount. Handy for noted or stackable items.
        Leave blank for any.
      </span>

      <div className="gms-qty-fields">
        <label>
          Min
          <input
            value={min}
            inputMode="numeric"
            placeholder="Any"
            disabled={readOnly}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label>
          Max
          <input
            value={max}
            inputMode="numeric"
            placeholder="Any"
            disabled={readOnly}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
      </div>

      {error && <span className="gms-qty-error">{error}</span>}

      <div className="gms-qty-actions">
        <button
          type="button"
          role="menuitem"
          className="gms-btn gms-btn--gold"
          disabled={readOnly || Boolean(error)}
          onClick={() => onSave(parsedMin, parsedMax)}
        >
          Save range
        </button>
        <button
          type="button"
          role="menuitem"
          className="gms-btn"
          disabled={readOnly || (!current?.min && !current?.max)}
          onClick={() => onSave(null, null)}
        >
          Clear range
        </button>
      </div>

      <div className="gms-qty-rule" />

      <button
        type="button"
        role="menuitem"
        className="gms-btn gms-btn--danger-text"
        disabled={readOnly}
        onClick={onRemove}
      >
        Remove item
      </button>
    </div>
  );
}

/**
 * One suggested drop with a switch. A button rather than a checkbox so the two
 * layouts can place the control where each needs it, and so the state reads at
 * a glance from across the grid.
 */
function PresetRow({
  id,
  name,
  on,
  grid,
  readOnly,
  onToggle,
}: {
  id: number;
  name: string;
  on: boolean;
  grid: boolean;
  readOnly: boolean;
  onToggle: (itemId: number, on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={readOnly}
      title={name}
      className={[
        grid ? 'gms-presets-tile' : 'gms-presets-row',
        on ? '' : 'is-off',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => onToggle(id, !on)}
    >
      <ItemIcon itemId={id} />
      <span className="gms-presets-name">{name}</span>
      <span className="gms-switch" aria-hidden>
        <span className="gms-switch-knob" />
      </span>
    </button>
  );
}
