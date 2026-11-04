import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { formatGp, getItemPrices } from '../../lib/itemPrices';
import { formatQty, qtyColorClass, type GroupItem } from '../../lib/items';
import { anyMenuOpen, subscribeMenuState } from '../../lib/menuState';

export type ItemTooltipState = {
  item: GroupItem;
  rect: DOMRect;
} | null;

const PAD = 8;
const GAP = 8;

/** Off-screen until measured, so the first frame never flashes in the corner. */
const HIDDEN: CSSProperties = { left: 0, top: 0, opacity: 0 };

/**
 * Sits beside the tile — right by default, left when there is no room. Its top
 * edge lines up with the tile's, so the tooltip only ever grows downwards and
 * never jumps up or down as the number of holders changes.
 */
function clamp(tip: HTMLElement, anchor: DOMRect): CSSProperties {
  const { width, height } = tip.getBoundingClientRect();

  const right = anchor.right + GAP;
  const left = right + width <= window.innerWidth - PAD ? right : anchor.left - width - GAP;

  const top = Math.max(PAD, Math.min(anchor.top, window.innerHeight - height - PAD));

  return {
    left: Math.max(PAD, Math.min(left, window.innerWidth - width - PAD)),
    top,
    opacity: 1,
  };
}

export function useItemTooltip() {
  const [state, setState] = useState<ItemTooltipState>(null);

  const hide = useCallback(() => setState(null), []);

  const show = useCallback((item: GroupItem, rect: DOMRect) => {
    // An open dropdown sits over the grid; pointing at its options must not
    // raise a tooltip for whatever happens to be behind it.
    if (anyMenuOpen()) return;
    setState({ item, rect });
  }, []);

  // A menu opening over the content dismisses whatever was already showing.
  useEffect(() => subscribeMenuState((open) => open && setState(null)), []);

  return { state, show, hide };
}

export function ItemTooltip({
  state,
  colorOf = () => 'var(--gold)',
  nameOnly = false,
}: {
  state: ItemTooltipState;
  colorOf?: (name: string) => string;
  /** Just the item's name, for places where the figures are already on screen. */
  nameOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>(HIDDEN);

  useLayoutEffect(() => {
    if (!state || !ref.current) {
      setStyle(HIDDEN);
      return;
    }
    setStyle(clamp(ref.current, state.rect));
  }, [state]);

  if (!state) return null;
  const { item } = state;
  const prices = getItemPrices(item.id);

  // Portalled to the body: the panel's backdrop-filter makes it a containing
  // block for fixed positioning, which would anchor the tooltip to the panel.
  if (nameOnly) {
    return createPortal(
      <div
        className="gms-item-tip gms-item-tip--name"
        style={style}
        role="tooltip"
        ref={ref}
      >
        <span className="gms-item-tip-title">{item.name}</span>
        {/* Slots abbreviate a stack to "2M", so the exact count belongs here. */}
        {item.quantity > 1 && (
          <span className={`gms-item-tip-amt ${qtyColorClass(item.quantity)}`}>
            {formatQty(item.quantity)}
          </span>
        )}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="gms-item-tip" style={style} role="tooltip" ref={ref}>
      <span className="gms-item-tip-title">{item.name}</span>
      <span className="gms-item-tip-total">
        <span className={qtyColorClass(item.quantity)}>{formatQty(item.quantity)}</span> total ·
        GE {formatGp(prices.ge * item.quantity)} · Alch {formatGp(prices.alch * item.quantity)}
      </span>
      {item.shares.length > 0 && (
        <ul className="gms-item-tip-rows">
          {item.shares.map((share) => {
            const pct = item.quantity ? Math.round((share.quantity / item.quantity) * 100) : 0;
            return (
              <li key={share.player} className={share.quantity ? undefined : 'is-empty'}>
                <span className="gms-item-tip-who">
                  <span
                    className="gms-dot"
                    style={{ background: colorOf(share.player) }}
                    aria-hidden
                  />
                  {share.player}
                </span>
                <span className={`gms-item-tip-qty ${qtyColorClass(share.quantity)}`}>
                  {formatQty(share.quantity)}
                </span>
                <span className="gms-item-tip-pct">{pct}%</span>
                <span className="gms-item-tip-bar" aria-hidden>
                  <span style={{ width: `${pct}%`, background: colorOf(share.player) }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  );
}
