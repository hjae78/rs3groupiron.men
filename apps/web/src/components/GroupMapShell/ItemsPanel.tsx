import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUiPrefs } from '../../hooks/useUiPrefs';
import type { ItemsView } from '../../lib/uiPrefs';
import { useUrlState, useUrlText } from '../../hooks/useUrlState';
import { formatGp, getItemPrices } from '../../lib/itemPrices';
import {
  aggregateGroupItems,
  formatQty,
  formatQtyCompact,
  ITEM_SOURCES,
  qtyColorClass,
  type GroupItem,
  type ItemSource,
  type WireMember,
} from '../../lib/items';
import { useMemberColor } from '../../hooks/useMemberColor';
import { useAlchValues } from '../../lib/alchValues';
import { useGePrices } from '../../lib/gePrices';
import { useItemNames } from '../../lib/itemNames';
import { Dropdown, type DropdownOption } from './Dropdown';
import { ItemIcon } from './ItemIcon';
import { BoxGlyph, EmptyState, SearchGlyph } from './EmptyState';
import { memberDropdownOption, type MemberBadge } from './memberOptions';
import { LoadMoreButton } from './PanelChrome';
import { Segmented, type SegmentedOption } from './Segmented';
import { ItemTooltip, useItemTooltip } from './ItemTooltip';

type PriceMode = 'each' | 'stack';
type Sort = 'qty' | 'name' | 'ge' | 'alch';
type PricedItem = GroupItem & { stackGe: number; stackAlch: number };

/** Rows rendered at once; a huge maxed bank stays off the DOM until asked for. */
const PAGE_SIZE = 150;

const SORTS: Array<DropdownOption<Sort>> = [
  { id: 'qty', label: 'Sort: Quantity' },
  { id: 'ge', label: 'Sort: GE value' },
  { id: 'alch', label: 'Sort: Alch value' },
  { id: 'name', label: 'Sort: Name' },
];

const SORT_VALUES: Sort[] = SORTS.map((s) => s.id);
const PRICE_MODES: PriceMode[] = ['each', 'stack'];

const PRICE_OPTIONS: Array<SegmentedOption<PriceMode>> = [
  { id: 'stack', label: '× Qty', title: 'Price × quantity' },
  { id: 'each', label: 'Each', title: 'Unit price' },
];

const VIEW_OPTIONS: Array<SegmentedOption<Exclude<ItemsView, ''>>> = [
  { id: 'cards', label: 'Cards' },
  { id: 'tiles', label: 'Tiles' },
  { id: 'list', label: 'List' },
];

type Scope = 'all' | ItemSource | 'pouch';

const SCOPES: Array<DropdownOption<Scope>> = [
  { id: 'all', label: 'All items' },
  { id: 'bank', label: 'Banks' },
  { id: 'inventory', label: 'Inventories' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'pouch', label: 'Pouch' },
];

const SCOPE_VALUES: Scope[] = SCOPES.map((s) => s.id);

/** What the heading calls each scope, for one player and for the group. */
const SCOPE_TITLE: Record<Scope, { all: string; one: string }> = {
  all: { all: 'All items', one: 'items' },
  bank: { all: 'All banks', one: 'bank' },
  inventory: { all: 'All inventories', one: 'inventory' },
  equipment: { all: 'All equipment', one: 'equipment' },
  pouch: { all: 'All pouches', one: 'pouch' },
};

function scopeSources(scope: Scope): {
  sources: ItemSource[];
  includePouch: boolean;
} {
  if (scope === 'all') return { sources: ITEM_SOURCES, includePouch: true };
  if (scope === 'pouch') return { sources: [], includePouch: true };
  return { sources: [scope], includePouch: false };
}

/** Label the aggregation uses for the group's own bank. */
const SHARED_BANK = 'Shared bank';

function viewingTitle(playerFilter: string, scope: Scope) {
  const label = SCOPE_TITLE[scope];
  if (playerFilter === 'all') return `Viewing: ${label.all}`;
  if (playerFilter === SHARED_BANK) return `Viewing: ${SHARED_BANK}`;
  return `Viewing: ${playerFilter}’s ${label.one}`;
}

/** Tint colours are the handoff's, not the generic status palette. */
const BADGES = {
  qty: { label: 'Total quantity', src: '/item-prices/qty.png?v=3', accent: 'var(--gold)' },
  ge: { label: 'GE value', src: '/item-prices/ge.png?v=3', accent: '#c0803c' },
  alch: { label: 'High alch value', src: '/item-prices/high-alch.png?v=3', accent: 'var(--ok)' },
} as const;

type BadgeKind = keyof typeof BADGES;

type ItemsPanelProps = {
  /** Raw members, so the scope filter can re-aggregate without a round trip. */
  rawMembers: WireMember[];
  members?: ReadonlyArray<MemberBadge>;
};

export function ItemsPanel({ rawMembers, members = [] }: ItemsPanelProps) {
  const [query, setQuery] = useUrlText('q');
  const [playerFilter, setPlayerFilter] = useUrlState('member', 'all');
  const [scope, setScope] = useUrlState<Scope>('scope', 'all', { allowed: SCOPE_VALUES });
  const [sort, setSort] = useUrlState<Sort>('sort', 'qty', { allowed: SORT_VALUES });
  const [priceMode, setPriceMode] = useUrlState<PriceMode>('price', 'stack', {
    allowed: PRICE_MODES,
  });
  const { prefs, setPref } = useUiPrefs();

  const isSingleBank = playerFilter !== 'all';
  // Cards for the group, tiles for a single bank — until the viewer picks
  // something, which is remembered on this device.
  const view = prefs.itemsView || (isSingleBank ? 'tiles' : 'cards');

  // Switching player hands the view back to that context's default. Compared
  // against a remembered value rather than just letting the effect fire,
  // because setPref's identity is not stable across renders.
  const lastPlayer = useRef(playerFilter);
  useEffect(() => {
    if (lastPlayer.current === playerFilter) return;
    lastPlayer.current = playerFilter;
    setPref('itemsView', '');
  }, [playerFilter, setPref]);

  // Names, prices and alch values all land after the first render, so their
  // versions are memo dependencies or the list keeps its placeholder labels.
  const itemNamesVersion = useItemNames();
  const gePricesVersion = useGePrices();
  const alchVersion = useAlchValues();

  // The shared bank is only ever a bank, so the source choice is meaningless
  // there — it is pinned and the control disabled rather than left to offer
  // inventories and equipment that cannot exist.
  const sharedOnly = playerFilter === SHARED_BANK;
  const effectiveScope: Scope = sharedOnly ? 'bank' : scope;

  const items = useMemo(() => {
    const { sources, includePouch } = scopeSources(effectiveScope);
    return aggregateGroupItems(rawMembers, sources, includePouch);
  }, [rawMembers, effectiveScope, itemNamesVersion, gePricesVersion, alchVersion]);

  const colorOf = useMemberColor(members);

  const players = useMemo(() => {
    const names = new Set<string>();
    for (const item of items) {
      for (const share of item.shares) names.add(share.player);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const playerChoices = useMemo<Array<DropdownOption<string>>>(
    () => [
      { id: 'all', label: 'All players' },
      ...players.map((name) => memberDropdownOption(name, colorOf(name))),
    ],
    [players, colorOf],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items.filter((item) => {
      if (q && !item.name.toLowerCase().includes(q) && !String(item.id).includes(q)) return false;
      if (playerFilter !== 'all' && !item.shares.some((s) => s.player === playerFilter)) {
        return false;
      }
      return true;
    });

    if (playerFilter !== 'all') {
      list = list.map((item) => {
        const share = item.shares.find((s) => s.player === playerFilter);
        return { ...item, quantity: share?.quantity ?? 0, shares: share ? [share] : [] };
      });
    }

    // Price each item once; the comparator would otherwise re-price per compare.
    const priced: PricedItem[] = list.map((item) => {
      const prices = getItemPrices(item.id);
      return {
        ...item,
        stackGe: prices.ge * item.quantity,
        stackAlch: prices.alch * item.quantity,
      };
    });

    priced.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'ge') return b.stackGe - a.stackGe;
      if (sort === 'alch') return b.stackAlch - a.stackAlch;
      return b.quantity - a.quantity;
    });
    return priced;
  }, [items, query, playerFilter, sort]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, item) => ({
          types: acc.types + 1,
          quantity: acc.quantity + item.quantity,
          ge: acc.ge + item.stackGe,
          alch: acc.alch + item.stackAlch,
        }),
        { types: 0, quantity: 0, ge: 0, alch: 0 },
      ),
    [filtered],
  );

  // Keeps a maxed bank's thousands of rows off the DOM until asked for.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, playerFilter, effectiveScope, sort]);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const tooltip = useItemTooltip();
  const searching = query.trim().length > 0;

  // Removing a hovered element never fires mouseleave, so changing the source,
  // player or search would otherwise strand its tooltip on screen.
  const { hide } = tooltip;
  useEffect(() => {
    hide();
  }, [filtered, view, hide]);

  return (
    <section className="gms-items" aria-label="Group items">
      <div className="gms-panel-head">
        <div className="gms-panel-head-text">
          <h1 className="gms-page-title">{viewingTitle(playerFilter, effectiveScope)}</h1>
        </div>

        <div className="gms-items-totals" aria-label="Bank totals">
          <span className="gms-stat gms-stat--items" title="Items">
            <em>Items</em>
            <strong>{totals.types.toLocaleString()}</strong>
          </span>
          <StatBadge kind="qty" value={totals.quantity} format="qty" />
          <StatBadge kind="ge" value={totals.ge} />
          <StatBadge kind="alch" value={totals.alch} />
        </div>

        {!isSingleBank && players.length > 0 && (
          <ul className="gms-mkey" aria-label="Member colours">
            {players.map((name) => (
              <li key={name} className="gms-mkey-item">
                <span className="gms-mkey-sw" style={{ background: colorOf(name) }} aria-hidden />
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="gms-items-toolbar gms-panel-toolbar">
        <input
          className="gms-input gms-items-search"
          value={query}
          placeholder="Search items"
          aria-label="Search items"
          onChange={(e) => setQuery(e.target.value)}
        />

        <Segmented
          options={PRICE_OPTIONS}
          value={priceMode}
          ariaLabel="Price display"
          onChange={setPriceMode}
        />

        <Dropdown
          className="gms-items-scope"
          ariaLabel="Source"
          value={effectiveScope}
          options={SCOPES}
          disabled={sharedOnly}
          title={sharedOnly ? 'The shared bank only holds bank items' : undefined}
          onChange={setScope}
        />

        <Dropdown
          className="gms-items-sort"
          ariaLabel="Sort"
          value={sort}
          options={SORTS}
          onChange={setSort}
        />

        <Dropdown
          className="gms-items-player"
          ariaLabel="Player"
          value={playerFilter}
          options={playerChoices}
          onChange={setPlayerFilter}
        />

        <Segmented
          options={VIEW_OPTIONS}
          value={view}
          ariaLabel="Item view"
          onChange={(next) => setPref('itemsView', next)}
        />
      </div>

      <div className="gms-panel-body gms-items-body">
        {filtered.length === 0 &&
          (searching ? (
            <EmptyState
              icon={<SearchGlyph />}
              title={`No items match “${query.trim()}”`}
              body="Check the spelling or clear the search to see everything."
            />
          ) : (
            <EmptyState
              icon={<BoxGlyph />}
              title="Your bank is empty"
              body="Items appear here once a group member syncs with the plugin."
            />
          ))}

        {filtered.length > 0 && view === 'cards' && (
          <div className="gms-items-grid">
            {visible.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                priceMode={priceMode}
                colorOf={colorOf}
                compactQty={effectiveScope === 'all'}
              />
            ))}
          </div>
        )}

        {filtered.length > 0 && view === 'tiles' && (
          <div className="gms-items-tiles">
            {visible.map((item) => (
              <ItemTile
                key={item.id}
                item={item}
                priceMode={priceMode}
                onHover={tooltip.show}
                onLeave={tooltip.hide}
                compactQty={effectiveScope === 'all'}
              />
            ))}
          </div>
        )}

        {filtered.length > 0 && view === 'list' && (
          <table className="gms-items-list">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">GE</th>
                <th scope="col">Alch</th>
                <th scope="col">Held by</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  priceMode={priceMode}
                  colorOf={colorOf}
                  onHover={tooltip.show}
                  onLeave={tooltip.hide}
                  compactQty={effectiveScope === 'all'}
                />
              ))}
            </tbody>
          </table>
        )}

        {filtered.length > visibleCount && (
          <LoadMoreButton
            loading={false}
            onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
          />
        )}
      </div>

      <ItemTooltip state={tooltip.state} colorOf={colorOf} />
    </section>
  );
}

function displayPrices(item: GroupItem, priceMode: PriceMode) {
  const { ge, alch } = getItemPrices(item.id);
  const mult = priceMode === 'stack' ? item.quantity : 1;
  return { ge: ge * mult, alch: alch * mult };
}

function StatBadge({
  kind,
  value,
  format = 'gp',
}: {
  kind: BadgeKind;
  value: number;
  format?: 'gp' | 'qty';
}) {
  const meta = BADGES[kind];
  return (
    <span className={`gms-stat gms-stat--${kind}`} title={meta.label}>
      <img src={meta.src} alt="" width={16} height={16} />
      <strong>{format === 'qty' ? formatQty(value) : formatGp(value)}</strong>
    </span>
  );
}

/**
 * One segment per member, sized by their share of the stack — the only place
 * the split between banks is visible at a glance.
 */
function SplitBar({
  item,
  colorOf,
  inline = false,
}: {
  item: GroupItem;
  colorOf: (name: string) => string;
  /** Inline sits in a table cell; otherwise it pins to the card's bottom edge. */
  inline?: boolean;
}) {
  if (item.shares.length === 0) return null;
  return (
    <span
      className={inline ? 'gms-split-bar gms-split-bar--inline' : 'gms-split-bar'}
      aria-hidden
    >
      {item.shares.map((share) => (
        <span
          key={share.player}
          className="gms-split-seg"
          style={{ flex: share.quantity || 0.0001, background: colorOf(share.player) }}
        />
      ))}
    </span>
  );
}

/**
 * No tooltip here: a card already shows the totals, the prices and every
 * holder on its face, so hovering one would only repeat it back.
 */
const ItemCard = memo(function ItemCard({
  item,
  priceMode,
  colorOf,
  compactQty,
}: {
  item: GroupItem;
  priceMode: PriceMode;
  colorOf: (name: string) => string;
  compactQty: boolean;
}) {
  const prices = displayPrices(item, priceMode);
  const qty = compactQty ? formatQtyCompact : formatQty;
  return (
    <article className="gms-item-card">
      <div className="gms-item-card-row">
        <span className="gms-item-card-art">
          <ItemIcon itemId={item.id} quantity={item.quantity} size={34} />
        </span>
        <div className="gms-item-card-text">
          <h3 className="gms-item-card-name">{item.name}</h3>
          <p className="gms-item-card-prices">
            GE <span>{formatGp(prices.ge)}</span> · Alch <span>{formatGp(prices.alch)}</span>
          </p>
        </div>
        <span className={`gms-item-card-qty ${qtyColorClass(item.quantity)}`}>
          {qty(item.quantity)}
        </span>
      </div>
      <ShareBars item={item} colorOf={colorOf} />
    </article>
  );
});

/**
 * One bar per holder, each filled to that member's share of the stack and
 * labelled with their amount — so a card says who has what, not just how the
 * total splits.
 */
function ShareBars({
  item,
  colorOf,
}: {
  item: GroupItem;
  colorOf: (name: string) => string;
}) {
  if (item.shares.length === 0) return null;
  const top = Math.max(...item.shares.map((s) => s.quantity), 1);

  return (
    <ul className="gms-item-shares">
      {item.shares.map((share) => (
        <li key={share.player} className="gms-item-share">
          <span className="gms-item-share-name">{share.player}</span>
          <span className="gms-item-share-track">
            <span
              className="gms-item-share-fill"
              style={{
                width: `${Math.max(3, Math.round((share.quantity / top) * 100))}%`,
                background: colorOf(share.player),
              }}
            />
          </span>
          <span className={`gms-item-share-qty ${qtyColorClass(share.quantity)}`}>
            {formatQty(share.quantity)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const ItemTile = memo(function ItemTile({
  item,
  priceMode,
  onHover,
  onLeave,
  compactQty,
}: {
  item: GroupItem;
  priceMode: PriceMode;
  onHover: (item: GroupItem, rect: DOMRect) => void;
  onLeave: () => void;
  compactQty: boolean;
}) {
  const prices = displayPrices(item, priceMode);
  const qty = compactQty ? formatQtyCompact : formatQty;
  return (
    <article
      className="gms-item-tile"
      onMouseEnter={(e) => onHover(item, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={onLeave}
    >
      <span className="gms-item-tile-art">
        <ItemIcon itemId={item.id} quantity={item.quantity} />
      </span>
      <h3 className="gms-item-tile-name">{item.name}</h3>
      <TilePill kind="qty">
        <span className={qtyColorClass(item.quantity)}>{qty(item.quantity)}</span>
      </TilePill>
      <TilePill kind="ge">{formatGp(prices.ge)}</TilePill>
      <TilePill kind="alch">{formatGp(prices.alch)}</TilePill>
    </article>
  );
});

function TilePill({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  const meta = BADGES[kind];
  return (
    <span className={`gms-tile-pill gms-tile-pill--${kind}`} title={meta.label}>
      <img src={meta.src} alt="" width={14} height={14} />
      {children}
    </span>
  );
}

const ItemRow = memo(function ItemRow({
  item,
  priceMode,
  colorOf,
  onHover,
  onLeave,
  compactQty,
}: {
  item: GroupItem;
  priceMode: PriceMode;
  colorOf: (name: string) => string;
  onHover: (item: GroupItem, rect: DOMRect) => void;
  onLeave: () => void;
  compactQty: boolean;
}) {
  const prices = displayPrices(item, priceMode);
  const qty = compactQty ? formatQtyCompact : formatQty;
  // Past a couple of holders the exact numbers stop fitting, so the line
  // abbreviates and the full figures move to the hover title.
  const compact = item.shares.length > 2;
  return (
    <tr className="gms-items-row">
      <th scope="row" className="gms-items-cell-name">
        <ItemIcon itemId={item.id} quantity={item.quantity} />
        <span>{item.name}</span>
      </th>
      <td className={qtyColorClass(item.quantity)}>{qty(item.quantity)}</td>
      <td>{formatGp(prices.ge)}</td>
      <td>{formatGp(prices.alch)}</td>
      <td
        onMouseEnter={(e) => onHover(item, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={onLeave}
      >
        <span className="gms-items-held">
          <span className="gms-items-held-text">
            {item.shares.map((share, i) => (
              <span key={share.player}>
                {i > 0 && ' · '}
                {share.player}{' '}
                {compact ? (
                  formatGp(share.quantity)
                ) : (
                  <span className={qtyColorClass(share.quantity)}>{qty(share.quantity)}</span>
                )}
              </span>
            ))}
          </span>
          <SplitBar item={item} colorOf={colorOf} inline />
        </span>
      </td>
    </tr>
  );
});
