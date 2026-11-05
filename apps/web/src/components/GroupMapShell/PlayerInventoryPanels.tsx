import {
  BACKPACK_SLOTS,
  formatQty,
  formatStack,
  itemName,
  qtyColorClass,
  type GroupItem,
  type ItemStack,
} from '../../lib/items';
import { useCoinPouch } from '../../hooks/useCoinPouch';
import { ItemIcon } from './ItemIcon';

const EQUIP_LAYOUT: Array<{ slot: number; label: string } | null> = [
  { slot: 14, label: 'Aura' },
  { slot: 0, label: 'Head' },
  { slot: 15, label: 'Pocket' },
  { slot: 1, label: 'Cape' },
  { slot: 2, label: 'Neck' },
  { slot: 13, label: 'Ammo' },
  { slot: 3, label: 'Weapon' },
  { slot: 4, label: 'Body' },
  { slot: 5, label: 'Off-hand' },
  null,
  { slot: 7, label: 'Legs' },
  null,
  { slot: 9, label: 'Hands' },
  { slot: 10, label: 'Feet' },
  { slot: 12, label: 'Ring' },
];

const EQUIP_SLOT_COUNT = EQUIP_LAYOUT.filter(Boolean).length;

const COINS_ITEM_ID = 995;

function asGroupItem(id: number, quantity: number): GroupItem {
  return { id, name: itemName(id), quantity, shares: [] };
}

export type SlotHover = {
  onHover: (item: GroupItem, rect: DOMRect) => void;
  onLeave: () => void;
};

export function StackPanel({
  title,
  slots,
  moneyPouch,
  onHover,
  onLeave,
}: SlotHover & {
  title: string;
  slots: Array<ItemStack | null>;
  moneyPouch?: number;
}) {
  const filled = slots.some((slot) => slot !== null);
  const used = slots.filter((slot) => slot !== null).length;
  return (
    <div className="gms-player-panel">
      <div className="gms-player-panel-title">{title}</div>
      <div className="gms-inv-grid" aria-label={filled ? undefined : 'Empty'}>
        {Array.from({ length: Math.max(slots.length, BACKPACK_SLOTS) }, (_, index) => {
          const stack = slots[index];
          return stack ? (
            <ItemSlot
              key={`${index}-${stack.id}`}
              stack={stack}
              onHover={onHover}
              onLeave={onLeave}
            />
          ) : (
            <div key={`${index}-empty`} className="gms-inv-slot gms-inv-slot--empty" />
          );
        })}
      </div>
      <div className="gms-inv-footer">
        <span>
          {used} / {BACKPACK_SLOTS} slots
        </span>
        {moneyPouch !== undefined && (
          <MoneyPouch total={moneyPouch} onHover={onHover} onLeave={onLeave} />
        )}
      </div>
    </div>
  );
}

function MoneyPouch({ total, onHover, onLeave }: SlotHover & { total: number }) {
  const { shown, deltas, bump, dismiss } = useCoinPouch(total);

  return (
    <span
      className="gms-money-pouch"
      onMouseEnter={(e) =>
        onHover(asGroupItem(COINS_ITEM_ID, total), e.currentTarget.getBoundingClientRect())
      }
      onMouseLeave={onLeave}
    >
      <img
        key={bump}
        className={
          bump > 0 ? 'gms-money-pouch-icon gms-money-pouch-icon--bump' : 'gms-money-pouch-icon'
        }
        src="/sprites/money_pouch.png"
        alt="Money pouch"
        width={20}
        height={20}
      />
      <strong className={qtyColorClass(shown)}>{formatQty(shown)}</strong>
      <span className="gms-coin-fx" aria-hidden>
        {deltas.map((delta) => (
          <span
            key={delta.id}
            className={
              delta.amount < 0 ? 'gms-coin-delta gms-coin-delta--out' : 'gms-coin-delta'
            }
            onAnimationEnd={() => dismiss(delta.id)}
          >
            {delta.amount > 0 ? '+' : '−'}
            {formatQty(Math.abs(delta.amount))} gp
          </span>
        ))}
      </span>
    </span>
  );
}

export function EquipmentPanel({
  slots,
  weight,
  onHover,
  onLeave,
}: SlotHover & { slots: Array<ItemStack | null>; weight: number }) {
  const worn = EQUIP_LAYOUT.filter(
    (cell): cell is { slot: number; label: string } => cell !== null,
  ).filter((cell) => slots[cell.slot]);

  return (
    <div className="gms-player-panel gms-gear-panel">
      <div className="gms-player-panel-title">Equipment</div>
      <div className="gms-gear-grid">
        {EQUIP_LAYOUT.map((cell, index) => {
          if (!cell) return <span key={`gap-${index}`} className="gms-gear-gap" aria-hidden />;
          const stack = slots[cell.slot];
          return (
            <div
              key={cell.label}
              className="gms-inv-slot gms-gear-slot"
              onMouseEnter={
                stack
                  ? (e) =>
                      onHover(
                        asGroupItem(stack.id, stack.quantity),
                        e.currentTarget.getBoundingClientRect(),
                      )
                  : undefined
              }
              onMouseLeave={stack ? onLeave : undefined}
            >
              {stack ? (
                <ItemIcon itemId={stack.id} quantity={stack.quantity} />
              ) : (
                <span className="gms-gear-slot-label">{cell.label}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="gms-gear-footer">
        <span>
          <strong>{worn.length}</strong> / {EQUIP_SLOT_COUNT} equipped
        </span>
        <span className="gms-gear-value" title="Carried weight">
          <WeightIcon />
          <strong>{formatWeight(weight)}</strong>
        </span>
      </div>
    </div>
  );
}

function ItemSlot({ stack, onHover, onLeave }: SlotHover & { stack: ItemStack }) {
  return (
    <div
      className="gms-inv-slot"
      onMouseEnter={(e) =>
        onHover(asGroupItem(stack.id, stack.quantity), e.currentTarget.getBoundingClientRect())
      }
      onMouseLeave={onLeave}
    >
      <ItemIcon itemId={stack.id} quantity={stack.quantity} />
      {stack.quantity > 1 && (
        <span className={`gms-inv-qty ${qtyColorClass(stack.quantity)}`}>
          {formatStack(stack.quantity)}
        </span>
      )}
    </div>
  );
}

function formatWeight(kg: number) {
  return `${kg.toFixed(1)} kg`;
}

function WeightIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M12 2a5 5 0 0 0-5 5v2.2h2.9V7a2.1 2.1 0 0 1 4.2 0v2.2H17V7a5 5 0 0 0-5-5Z" />
      <path d="M8.4 8.6h7.2c.9 0 1.7.6 1.9 1.5l1.7 7.6A3 3 0 0 1 16.3 22H7.7a3 3 0 0 1-2.9-4.3l1.7-7.6c.2-.9 1-1.5 1.9-1.5Z" />
    </svg>
  );
}
