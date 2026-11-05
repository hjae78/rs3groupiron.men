import type { PlayerView } from '../../lib/items';

export function MapChips({
  players,
  activeName,
  attached,
  onSelect,
}: {
  players: PlayerView[];
  activeName: string | null;
  attached: boolean;
  onSelect: (player: PlayerView) => void;
}) {
  if (players.length === 0) return null;
  return (
    <div className={attached ? 'gms-map-chips gms-map-chips--attached' : 'gms-map-chips'}>
      <nav className="gms-map-chips-bar" aria-label="Player locations">
        {players.map((player) => {
          const hasLocation = player.coordinates.length >= 2;
          const active = activeName === player.name;
          return (
            <button
              key={player.name}
              type="button"
              className={active ? 'gms-map-chip gms-map-chip--active' : 'gms-map-chip'}
              title={
                player.inLobby
                  ? `${player.name} is in the lobby`
                  : !hasLocation
                    ? 'Location unknown'
                    : player.online
                      ? `Jump to ${player.name}`
                      : `Jump to last location (${player.name} offline)`
              }
              disabled={!hasLocation}
              onClick={() => onSelect(player)}
            >
              <span
                className="gms-map-chip-dot"
                style={{ background: player.online ? player.avatarColor : 'var(--dim)' }}
                aria-hidden
              />
              <span className="gms-map-chip-name">{player.displayName}</span>
              {!player.online && <span className="gms-map-chip-tag">offline</span>}
              {player.online && player.inLobby && (
                <span className="gms-map-chip-tag">lobby</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
