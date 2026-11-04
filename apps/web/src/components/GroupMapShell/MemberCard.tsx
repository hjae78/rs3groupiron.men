import { useState } from 'react';
import { discordAvatarUrl, type PlayerView } from '../../lib/items';
import { MIN_SLOTS } from '../../lib/constants';
import { MemberAvatarOptions } from './MemberAvatarOptions';
import { RemoveIcon, SaveIcon, VerifiedIcon } from './icons';

export type MemberDraft = {
  nickname: string;
  discordId: string;
  color: string;
  useDiscordAvatar: boolean;
};

type MemberCardProps = {
  player: PlayerView;
  canRemove: boolean;
  busy: boolean;
  onSave: (draft: MemberDraft) => void;
  onRemove: () => void;
};

/**
 * One editable member. Owns its own draft so in-progress edits survive live
 * group refreshes; the parent keys this by player name so a re-added member
 * starts fresh.
 */
export function MemberCard({ player, canRemove, busy, onSave, onRemove }: MemberCardProps) {
  const [draft, setDraft] = useState<MemberDraft>(() => ({
    nickname: player.nickname ?? '',
    discordId: player.discordId ?? '',
    color: player.avatarColor,
    useDiscordAvatar: player.useDiscordAvatar,
  }));

  const discordPreview = discordAvatarUrl(draft.discordId);
  const hasValidDiscord = !!discordPreview;
  const showDiscord = draft.useDiscordAvatar && hasValidDiscord;
  const removeTitle = canRemove
    ? `Remove ${player.name}`
    : `Groups need at least ${MIN_SLOTS} members`;

  function patch(next: Partial<MemberDraft>) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  return (
    <li className="gms-settings-member">
      <header className="gms-settings-member-head">
        {showDiscord ? (
          <img
            className="gms-settings-avatar"
            src={discordPreview}
            alt=""
            width={28}
            height={28}
            style={{ borderColor: draft.color }}
          />
        ) : (
          <span
            className="gms-settings-avatar gms-settings-avatar--dot"
            style={{ background: draft.color }}
          />
        )}
        <strong className="gms-settings-rsn">{player.name}</strong>
        {player.verified && (
          <span title="Verified RuneScape account owner">
            <VerifiedIcon />
          </span>
        )}
        <button
          type="button"
          className="gms-settings-icon-btn gms-settings-danger gms-settings-remove-top"
          disabled={!canRemove || busy}
          title={removeTitle}
          aria-label={removeTitle}
          onClick={onRemove}
        >
          <RemoveIcon />
        </button>
      </header>

      <div className="gms-settings-member-body">
        <input
          value={draft.nickname}
          placeholder="Nickname"
          aria-label={`Nickname for ${player.name}`}
          onChange={(e) => patch({ nickname: e.target.value })}
        />
        <input
          value={draft.discordId}
          placeholder="Discord user id"
          aria-label={`Discord id for ${player.name}`}
          inputMode="numeric"
          onChange={(e) => patch({ discordId: e.target.value.replace(/\D/g, '') })}
        />
        <MemberAvatarOptions
          color={draft.color}
          useDiscordAvatar={draft.useDiscordAvatar}
          hasDiscord={hasValidDiscord}
          busy={busy}
          colorLabel={`Colour for ${player.name}`}
          onColorChange={(color) => patch({ color })}
          onUseDiscordAvatarChange={(useDiscordAvatar) => patch({ useDiscordAvatar })}
        />
      </div>

      <footer className="gms-settings-member-actions">
        <button
          type="button"
          className="gms-settings-text-btn gms-settings-save gms-settings-save--full"
          disabled={busy}
          onClick={() =>
            onSave({
              ...draft,
              useDiscordAvatar: hasValidDiscord ? draft.useDiscordAvatar : false,
            })
          }
        >
          <SaveIcon />
          Save
        </button>
      </footer>
    </li>
  );
}
