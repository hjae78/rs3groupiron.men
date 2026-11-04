import { createHash } from 'node:crypto';

export const DELETION_SUPPRESSION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export const ACCESS_TOKEN_FRESHNESS_MS = 30 * 60 * 1000;

export const PLAYER_DELETION_GRACE_MS = 24 * 60 * 60 * 1000;

export type PlayerDeletionColumns = {
  deletionRequestedAt: Date | null;
  deleteAfter: Date | null;
};

export type PlayerDeletionStatus = {
  pending: boolean;
  requested_at: string | null;
  delete_after: string | null;
};

export function playerDeletionDueAt(from: Date): Date {
  return new Date(from.getTime() + PLAYER_DELETION_GRACE_MS);
}

export function playerDeletionStatus(
  player: PlayerDeletionColumns,
): PlayerDeletionStatus {
  return {
    pending: player.deleteAfter != null,
    requested_at: player.deletionRequestedAt?.toISOString() ?? null,
    delete_after: player.deleteAfter?.toISOString() ?? null,
  };
}

export function hashUsernameKey(usernameKey: string): string {
  return createHash('sha256').update(usernameKey, 'utf8').digest('hex');
}

export function suppressionCooldownUntil(from: Date): Date {
  return new Date(from.getTime() + DELETION_SUPPRESSION_COOLDOWN_MS);
}

export function isSuppressionActive(
  row: { cooldownUntil: Date },
  now: Date,
): boolean {
  return row.cooldownUntil.getTime() > now.getTime();
}

export function isCredentialFresh(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= ACCESS_TOKEN_FRESHNESS_MS;
}
