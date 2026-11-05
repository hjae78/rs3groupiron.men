import { memo, useEffect, useState } from 'react';
import { formatQty, type PlayerView } from '../../lib/items';
import { useItemNames } from '../../lib/itemNames';
import type { CombinedXpDrop } from '../../lib/xpDrops';
import { totalXpAmount, xpPartsBackToFront } from '../../lib/xpDrops';
import type { MemberQuestStates } from '../../lib/quests';
import { ItemTooltip, useItemTooltip } from './ItemTooltip';
import { VerifiedIcon } from './icons';
import { EquipmentPanel, StackPanel } from './PlayerInventoryPanels';
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
