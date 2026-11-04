import { memo, useEffect, useState } from 'react';
import {
  BACKPACK_SLOTS,
  formatQty,
  formatStack,
  itemName,
  qtyColorClass,
  type GroupItem,
  type ItemStack,
  type PlayerView,
} from '../../lib/items';
import { useItemNames } from '../../lib/itemNames';
import { useCoinPouch } from '../../hooks/useCoinPouch';
import type { CombinedXpDrop } from '../../lib/xpDrops';
import { totalXpAmount, xpPartsBackToFront } from '../../lib/xpDrops';
import type { MemberQuestStates } from '../../lib/quests';
import { ItemIcon } from './ItemIcon';
import { ItemTooltip, useItemTooltip } from './ItemTooltip';
import { VerifiedIcon } from './icons';
import { PlayerQuestsPanel } from './PlayerQuestsPanel';
import { SkillsPanel } from './SkillsPanel';

export type PlayerPanel = 'inventory' | 'equipment' | 'skills' | 'quests' | null;

type OpenPanel = Exclude<PlayerPanel, null>;

const TABS: Array<{ panel: OpenPanel; label: string; icon: string }> = [
  { panel: 'inventory', label: 'Inventory', icon: '/sprites/tab_inventory.png' },
  { panel: 'equipment', label: 'Equipment', icon: '/sprites/tab_equipment.png' },
  { panel: 'skills', label: 'Skills', icon: '/sprites/skill_tab_skills.png' },
  { panel: 'quests', label: 'Quests', icon: '/sprites/quest_icon_skill_tab.png' },
];

const LAST_SEEN_FMT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const STACK_PANEL_LABEL = { inventory: 'Inventory', equipment: 'Equipment' } as const;

/**
 * The worn-equipment grid, read row by row. Numbers are RS3 worn-container
 * slot indices; null is a spacer cell that keeps the cross shape.
 */
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

/** The pouch holds coins, so its hover names the item like any slot does. */
const COINS_ITEM_ID = 995;

/**
 * The shared tooltip is built around a group-wide item. Slots only show the
 * name, so there is nothing to spread across holders.
 */
function asGroupItem(id: number, quantity: number): GroupItem {
  return { id, name: itemName(id), quantity, shares: [] };
}

type SlotHover = {
  onHover: (item: GroupItem, rect: DOMRect) => void;
  onLeave: () => void;
};

export type PlayerCardProps = {
  player: PlayerView;
  xpDrop?: CombinedXpDrop | null;
  /** Called when the drop animation finishes; stable across renders. */
  onXpDropDone?: (playerName: string, id: string) => void;
  /** Quest points from the member's finished quests. */
  questPoints?: number;
  /** The member's quest states, for the quest book panel. */
  quests?: MemberQuestStates;
};

export const PlayerCard = memo(function PlayerCard({
  player,
  xpDrop = null,
  onXpDropDone,
  questPoints = 0,
  quests,
}: PlayerCardProps) {
  const [panel, setPanel] = useState<PlayerPanel>(null);

  // Inventory and equipment slots name their items on hover, so the card
  // subscribes to the catalogue rather than falling back to "Item <id>".
  useItemNames();

  const tooltip = useItemTooltip();
  const { hide } = tooltip;

  // Switching tabs unmounts the hovered slot, and a removed element never fires
  // mouseleave, which would otherwise strand the tooltip on screen.
  useEffect(() => {
    hide();
  }, [panel, hide]);

  // A member who has never synced has no vitals and no panels to show.
  const tracked = player.lastSeen !== null;

  return (
    <article
      className={[
        'gms-player',
        panel ? 'gms-player--open' : '',
        panel === 'skills' ? 'gms-player--skills' : '',
        panel === 'quests' ? 'gms-player--quests' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="gms-xp-drops" aria-hidden>
        {xpDrop ? (
          <div
            key={xpDrop.id}
            className="gms-xp-drop"
            onAnimationEnd={() => onXpDropDone?.(player.name, xpDrop.id)}
          >
            <span className="gms-xp-drop-icons">
              {xpPartsBackToFront(xpDrop.parts).map((part, index) => (
                <img
                  key={part.skillId}
                  className="gms-xp-drop-icon"
                  src={`/skills/${part.icon}`}
                  alt=""
                  width={16}
                  height={16}
                  title={`${part.skillName} +${formatQty(part.amount)}`}
                  style={{
                    zIndex: index + 1,
                    marginLeft: index === 0 ? 0 : -7,
                  }}
                />
              ))}
            </span>
            <span>
              {xpDrop.playerName ? `${xpDrop.playerName} ` : ''}
              +{formatQty(totalXpAmount(xpDrop))} xp
            </span>
          </div>
        ) : null}
      </div>
      <div className="gms-player-head">
        <div className="gms-player-name-row">
          <span
            className="gms-dot"
            style={{ background: player.avatarColor }}
            aria-hidden
          />
          <span className="gms-player-name">{player.displayName}</span>
          {player.verified && (
            <span title="Verified RuneScape account owner">
              <VerifiedIcon />
            </span>
          )}
          <Presence
            online={player.online}
            inLobby={player.inLobby}
            world={player.world}
          />
        </div>

        <span className="gms-player-seen">
          {tracked ? `Last seen ${formatLastSeen(player.lastSeen!)}` : 'Never synced'}
        </span>

        {!tracked && (
          <div className="gms-player-untracked">
            <ClockIcon />
            <span>
              <strong>Not tracked yet</strong>
              <em>Stats appear after they log in with the plugin.</em>
            </span>
          </div>
        )}

        {tracked && (
          <div className="gms-player-vitals">
            <VitalBar kind="hp" icon="/skills/constitution.png" label="Life points" value={player.health} />
            <VitalBar kind="pray" icon="/skills/prayer.png" label="Prayer" value={player.prayer} />
            <VitalBar kind="summon" icon="/sprites/summon_icon.png" label="Summoning" value={player.summoning} />
          </div>
        )}

        {tracked && <TargetBar target={player.target ?? null} />}
      </div>

      {tracked && (
        <div className="gms-player-tabs" role="tablist">
          {TABS.map((tab) => {
            const active = panel === tab.panel;
            return (
              <button
                key={tab.panel}
                type="button"
                role="tab"
                className={active ? 'gms-player-tab gms-player-tab--active' : 'gms-player-tab'}
                title={tab.label}
                aria-label={tab.label}
                aria-selected={active}
                onClick={() => setPanel((prev) => (prev === tab.panel ? null : tab.panel))}
              >
                <img src={tab.icon} alt="" width={24} height={24} draggable={false} />
              </button>
            );
          })}
        </div>
      )}

      {panel === 'skills' && (
        <SkillsPanel
          skills={player.skills}
          totalLevel={player.totalLevel}
          questPoints={questPoints}
        />
      )}

      {panel === 'quests' && <PlayerQuestsPanel states={quests} skills={player.skills} />}

      {panel === 'inventory' && (
        <StackPanel
          title={STACK_PANEL_LABEL.inventory}
          slots={player.inventorySlots}
          moneyPouch={player.moneyPouch}
          onHover={tooltip.show}
          onLeave={tooltip.hide}
        />
      )}

      {panel === 'equipment' && (
        <EquipmentPanel
          slots={player.equipmentSlots}
          weight={player.weight}
          onHover={tooltip.show}
          onLeave={tooltip.hide}
        />
      )}

      <ItemTooltip state={tooltip.state} nameOnly />
    </article>
  );
});

/** Weight as the game writes it, to one decimal. Goes negative with sculpting gear. */
function formatWeight(kg: number) {
  return `${kg.toFixed(1)} kg`;
}

/**
 * The kettlebell from the game's worn-equipment tab: a solid silhouette rather
 * than an outline, so it still reads at 16px. Drawn rather than a sprite so it
 * takes the panel's colour and stays sharp on any display.
 */
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
      {/* Handle: a thick ring, flattened where the body swallows it. */}
      <path d="M12 2a5 5 0 0 0-5 5v2.2h2.9V7a2.1 2.1 0 0 1 4.2 0v2.2H17V7a5 5 0 0 0-5-5Z" />
      {/* Body: straight shoulders flaring to a wide, round-cornered base. */}
      <path d="M8.4 8.6h7.2c.9 0 1.7.6 1.9 1.5l1.7 7.6A3 3 0 0 1 16.3 22H7.7a3 3 0 0 1-2.9-4.3l1.7-7.6c.2-.9 1-1.5 1.9-1.5Z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--gold)"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** Who the member is fighting, with whatever the target panel knows of it. */
function TargetBar({
  target,
}: {
  target: { name: string; hp: number | null; percent: number | null } | null;
}) {
  if (!target) {
    return (
      <div className="gms-target gms-target--none" title="No target">
        <div className="gms-target-row">
          <span className="gms-target-name">No Target</span>
        </div>
        <div className="gms-target-track">
          <div className="gms-target-fill" style={{ width: '0%' }} />
        </div>
      </div>
    );
  }

  const width = target.percent === null ? 100 : Math.max(0, Math.min(100, target.percent));
  return (
    <div
      className="gms-target"
      title={target.hp === null ? target.name : `${target.name}: ${target.hp.toLocaleString()} life points`}
    >
      <div className="gms-target-row">
        <span className="gms-target-name">{target.name}</span>
        {target.hp !== null && <span className="gms-target-hp">{formatQty(target.hp)}</span>}
      </div>
      <div className="gms-target-track">
        <div className="gms-target-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function formatLastSeen(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : LAST_SEEN_FMT.format(d);
}

function Presence({
  online,
  inLobby,
  world,
}: {
  online: boolean;
  inLobby: boolean;
  world: number;
}) {
  // The lobby has no world, so the world slot keeps whatever was last seen
  // in-game. Showing it next to "lobby" would read as still being there.
  const lobby = online && inLobby;
  const known = online && !lobby && world > 0;

  const state = lobby ? 'lobby' : online ? 'online' : 'offline';
  const label = lobby ? 'LOBBY' : online ? (known ? `W${world}` : 'ONLINE') : 'OFFLINE';
  const title = lobby
    ? 'In the lobby'
    : online
      ? known
        ? `Online — world ${world}`
        : 'Online'
      : 'Offline';

  return (
    <span className={`gms-player-status gms-player-status--${state}`} title={title}>
      {label}
    </span>
  );
}

function VitalBar({
  kind,
  icon,
  label,
  value,
}: {
  kind: 'hp' | 'pray' | 'summon';
  icon: string;
  label: string;
  value: { current: number; max: number };
}) {
  const text = `${value.current.toLocaleString()} / ${value.max.toLocaleString()}`;
  const pct = value.max
    ? Math.max(0, Math.min(100, Math.round((value.current / value.max) * 100)))
    : 0;

  return (
    <div className="gms-vital">
      <span className="gms-vital-icon" aria-hidden>
        <img src={icon} alt="" width={20} height={20} draggable={false} />
      </span>
      <div className={`gms-vital-track gms-vital-track--${kind}`} title={`${label}: ${text}`}>
        {/* Trail layer: same width as the fill but a slower, delayed transition,
            so a drop leaves a lighter streak that catches up a moment later. */}
        <div className="gms-vital-trail" style={{ width: `${pct}%` }} aria-hidden />
        <div className="gms-vital-fill" style={{ width: `${pct}%` }} />
        <span className="gms-vital-text">{text}</span>
      </div>
    </div>
  );
}

/**
 * Draws every slot, filled or not. The grid is fixed so an item keeps its place
 * as things around it are used, instead of the whole panel shuffling up.
 */
function StackPanel({
  title,
  slots,
  moneyPouch,
  onHover,
  onLeave,
}: SlotHover & {
  title: string;
  slots: Array<ItemStack | null>;
  /** Coin pouch total; only the inventory carries one. */
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

/**
 * The pouch total with its change made visible: the number eases to its new
 * value, the icon pops, and the difference floats up above it.
 */
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

/**
 * Worn equipment in the game's cross layout. Every slot is always drawn, so an
 * empty one reads as "nothing worn here" rather than vanishing.
 */
function EquipmentPanel({
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
          // An empty slot already names itself in the cell, so only a worn item
          // raises a tooltip.
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
