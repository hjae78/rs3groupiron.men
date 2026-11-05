import type { CSSProperties } from 'react';
import type { PlayerView } from '../../lib/items';
import type { MemberQuestStates } from '../../lib/quests';
import { questPointsFor } from '../../lib/quests';
import type { CombinedXpDrop } from '../../lib/xpDrops';
import { PlayerCard } from './PlayerCard';
import { PlayerCardSkeleton } from './PlayerCardSkeleton';

export function MembersSidebar({
  players,
  error,
  loading,
  memberSlots,
  membersCollapsed,
  onToggleCollapsed,
  xpDropsByPlayer,
  dismissXpDrop,
  questsByMember,
}: {
  players: PlayerView[];
  error: string | null;
  loading: boolean;
  memberSlots: number;
  membersCollapsed: boolean;
  onToggleCollapsed: () => void;
  xpDropsByPlayer: Record<string, CombinedXpDrop>;
  dismissXpDrop: (playerName: string, id: string) => void;
  questsByMember: Record<string, MemberQuestStates>;
}) {
  return (
    <aside className="gms-players" aria-label="Group members">
      <div className="gms-members-bar">
        <span className="gms-micro gms-members-label">Members · {players.length}</span>
        <button
          type="button"
          className="gms-members-toggle"
          aria-expanded={!membersCollapsed}
          title={membersCollapsed ? 'Expand members' : 'Collapse members'}
          aria-label={membersCollapsed ? 'Expand members' : 'Collapse members'}
          onClick={onToggleCollapsed}
        >
          {membersCollapsed ? '›' : '‹'}
        </button>
      </div>
      {error && <p className="gms-side-status gms-side-status--error">{error}</p>}
      {!error &&
        loading &&
        players.length === 0 &&
        Array.from({ length: memberSlots }, (_, i) => <PlayerCardSkeleton key={i} />)}
      {!error && !loading && players.length === 0 && (
        <p className="gms-side-status">No members yet</p>
      )}
      {players.map((player) =>
        membersCollapsed ? (
          <button
            key={player.name}
            type="button"
            className={
              player.online
                ? 'gms-members-avatar gms-members-avatar--online'
                : 'gms-members-avatar'
            }
            style={{ '--member': player.avatarColor } as CSSProperties}
            title={`${player.displayName} — ${player.online ? 'Online' : 'Offline'}`}
            aria-label={`Expand members (${player.displayName}, ${
              player.online ? 'online' : 'offline'
            })`}
            onClick={onToggleCollapsed}
          >
            <span className="gms-members-avatar-face">
              {player.avatarUrl ? (
                <img src={player.avatarUrl} alt="" width={48} height={48} />
              ) : (
                player.displayName.charAt(0).toUpperCase()
              )}
            </span>
            <span className="gms-members-avatar-dot" aria-hidden />
          </button>
        ) : (
          <PlayerCard
            key={player.name}
            player={player}
            xpDrop={xpDropsByPlayer[player.name] ?? null}
            onXpDropDone={dismissXpDrop}
            questPoints={questPointsFor(questsByMember[player.name])}
            quests={questsByMember[player.name]}
          />
        ),
      )}
    </aside>
  );
}
