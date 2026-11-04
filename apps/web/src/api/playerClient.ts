import { api } from './groupClient';
import { clickDownload } from '../lib/download';

export type VerifyTokenResult = {
  player_id: string;
  username: string;
  verification_status: 'unverified' | 'plugin_verified';
  access_token: string;
  access_token_expires_at: string;
};

export async function redeemVerificationToken(
  code: string,
  username: string,
): Promise<VerifyTokenResult> {
  return api('/api/players/verify', {
    method: 'POST',
    body: JSON.stringify({ code, username }),
  });
}

export type PlayerDeletionStatus = {
  pending: boolean;
  requested_at: string | null;
  delete_after: string | null;
};

export type PlayerProfile = {
  id: string;
  current_username: string;
  previous_usernames: string[];
  verification_status: 'unverified' | 'plugin_verified';
  verified_at: string | null;
  deletion: PlayerDeletionStatus;
};

export async function fetchMe(accessToken: string): Promise<PlayerProfile> {
  return api('/api/players/me', { token: `Bearer ${accessToken}` });
}

export async function logoutPlayer(accessToken: string): Promise<void> {
  await api('/api/players/logout', {
    method: 'POST',
    token: `Bearer ${accessToken}`,
  });
}

export type RotatedToken = {
  access_token: string;
  access_token_expires_at: string;
};

export async function rotateToken(accessToken: string): Promise<RotatedToken> {
  return api('/api/players/rotate', {
    method: 'POST',
    token: `Bearer ${accessToken}`,
  });
}

export async function requestPlayerDeletion(
  accessToken: string,
  confirmUsername: string,
): Promise<PlayerDeletionStatus> {
  return api('/api/players/request-deletion', {
    method: 'POST',
    token: `Bearer ${accessToken}`,
    body: JSON.stringify({ confirm_username: confirmUsername }),
  });
}

export async function cancelPlayerDeletion(
  accessToken: string,
): Promise<PlayerDeletionStatus> {
  return api('/api/players/cancel-deletion', {
    method: 'POST',
    token: `Bearer ${accessToken}`,
  });
}

export type PlayerSkill = {
  id: string;
  xp: string;
  level: number;
  base_level: number;
};

export type PlayerMembership = {
  group: string;
  skills: PlayerSkill[];
  inventories: Record<string, { updated_at: string; items: number[] }>;
  quests: Array<{ gameval: string; state: number; updated_at: string }>;
  achievements_completed: Array<{ gameval: string; updated_at: string }>;
  achievements_in_progress: Array<{
    gameval: string;
    progress: number;
    target: number;
    updated_at: string;
  }>;
  npc_kills: Array<{ npc: string; kills: number; last_at: string }>;
};

export type PlayerDataDocument = {
  export_version: number;
  generated_at: string;
  row_cap: number;
  matched_usernames: string[];
  player: {
    id: string;
    current_username: string;
    verification_status: 'unverified' | 'plugin_verified';
    verified_at: string | null;
    created_at: string;
  };
  memberships: PlayerMembership[];
  bank_ledger: Array<{
    at: string;
    group_id: string;
    member_name: string;
    item_id: number;
    delta: number;
  }>;
  achievement_feed: Array<Record<string, unknown>>;
  xp_samples: Array<{
    member_id: string;
    skill_id: string;
    xp: string;
    sampled_at: string;
  }>;
};

export async function fetchMyData(
  accessToken: string,
): Promise<PlayerDataDocument> {
  return api('/api/players/me/data', { token: `Bearer ${accessToken}` });
}

function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}

export async function downloadMyDataArchive(
  accessToken: string,
): Promise<string> {
  const res = await fetch('/api/players/me/export.zip', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Could not download your data (${res.status})`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  try {
    const filename =
      filenameFromDisposition(res.headers.get('Content-Disposition')) ??
      'rs3-group-ironman-my-data.zip';
    clickDownload(href, filename);
    return filename;
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}

export type PlayerSession = {
  id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  current: boolean;
};

export async function listSessions(
  accessToken: string,
): Promise<PlayerSession[]> {
  return api('/api/players/sessions', { token: `Bearer ${accessToken}` });
}

export async function revokeSession(
  accessToken: string,
  sessionId: string,
): Promise<void> {
  await api(`/api/players/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    token: `Bearer ${accessToken}`,
  });
}
