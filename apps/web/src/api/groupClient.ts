import { clickDownload } from '../lib/download';
import type { WireEntry } from '../lib/items';

const DEMO_GROUP = 'Demo Group';

export type GroupMode = 'normal' | 'competitive';
export type AppearanceTheme = 'rs3' | 'modern';
export type XpHistoryPeriod = '24h' | '7d' | '30d' | '365d';
export type GroupVisibility = 'private' | 'public';

export type GroupShares = {
  map: boolean;
  skills: boolean;
  items: boolean;
  quests: boolean;
  achievements: boolean;
};

/**
 * A pending erasure request. Only returned to a caller that sent the token;
 * `pending` false means nothing is scheduled.
 */
export type GroupDeletion = {
  pending: boolean;
  requested_at: string | null;
  delete_after: string | null;
  grace_days: number;
};

export type GroupInfo = {
  ok: boolean;
  name: string;
  token?: string;
  mode: GroupMode;
  appearance: AppearanceTheme;
  member_count: number;
  member_slots: number;
  /** ISO instant the group was created; absent on older API builds. */
  created_at?: string;
  visibility?: GroupVisibility;
  shares?: GroupShares;
  visible?: GroupShares;
  /** Absent on a tokenless read, and on older API builds. */
  deletion?: GroupDeletion;
};

export type PublicGroup = {
  name: string;
  mode: GroupMode;
  views: number;
  member_count: number;
  verified_count: number;
  member_slots: number;
  member_names: string[];
  shares: GroupShares;
  created_at: string;
};

export type PublicGroupsResponse = {
  groups: PublicGroup[];
};

export type LeaderboardMetric = 'views' | 'total_level';
export type LeaderboardPeriod = '7d' | '30d' | 'all';

export type LeaderboardEntry = {
  rank: number;
  name: string;
  mode: GroupMode;
  member_count: number;
  verified_count: number;
  views: number;
  recent_views: number;
  total_level: number;
  created_at: string;
};

export type LeaderboardResponse = {
  metric: LeaderboardMetric;
  period: LeaderboardPeriod;
  entries: LeaderboardEntry[];
};

export type XpHistoryResponse = {
  period: XpHistoryPeriod;
  skill: string;
  from: string;
  to: string;
  series: Array<{
    name: string;
    points: Array<{ t: string; gain: number }>;
  }>;
  players: Array<{
    name: string;
    totalGain: number;
    skills: Array<{ id: string; name: string; gain: number }>;
  }>;
};

/** One shared-bank movement. `delta` > 0 deposited, < 0 withdrawn. */
export type BankLedgerEntry = {
  id: string;
  name: string;
  item_id: number;
  delta: number;
  at: string;
};

export type BankLedgerResponse = {
  entries: BankLedgerEntry[];
  has_more: boolean;
};

/**
 * Response of get-group-data. With `from_time`, members whose last_updated is
 * older than that timestamp come back as `{ name }` only, and members who moved
 * without their inventories changing come back as `partial` light-field
 * updates.
 */
export type GroupDataResponse = WireEntry[];

type ApiInit = RequestInit & { token?: string };

async function parseErrorMessage(res: Response) {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (typeof body.message === 'string') message = body.message;
    else if (Array.isArray(body.message)) message = body.message.join(', ');
  } catch {
    /* ignore non-JSON bodies */
  }
  return message;
}

/**
 * Carries the HTTP status alongside the server's message, so a caller can tell
 * "you may not see this" from "the request failed". The API answers the same
 * 401 for an unknown group and a wrong token on purpose, so `status` narrows it
 * to "no access" and never to a reason.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isAccessDenied(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

export async function api<T>(path: string, { token, ...init }: ApiInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { Authorization: token } : {}),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new ApiError(await parseErrorMessage(res), res.status);
  return (await res.json()) as T;
}

function groupPath(groupName: string, endpoint: string) {
  return `/api/group/${encodeURIComponent(groupName)}/${endpoint}`;
}

/**
 * Fetch group members. Pass `fromTime` (ISO) to get a delta: members not
 * updated since then are returned as `{ name }` stubs, and members whose
 * position or vitals moved without their inventories changing come back as
 * `partial` entries carrying only the light fields.
 *
 * `split=1` is what opts into those partial entries. Without it the server
 * resends a member's entire bank every time they take a step.
 */
export async function fetchGroupData(
  groupName = DEMO_GROUP,
  token = '',
  fromTime?: string,
): Promise<GroupDataResponse> {
  const query = fromTime
    ? `?${new URLSearchParams({ from_time: fromTime, split: '1' })}`
    : '';
  return api(`${groupPath(groupName, 'get-group-data')}${query}`, { token });
}

// playerMoved / setMemberOnline mirror the endpoints the game plugin calls;
// the web UI only uses them for demo/testing tooling.
export async function playerMoved(
  groupName: string,
  token: string,
  body: { name: string; coordinates: number[] },
) {
  return api<{
    ok: boolean;
    name: string;
    online: boolean;
    coordinates: number[];
    updated_at: string;
  }>(groupPath(groupName, 'player-moved'), {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function setMemberOnline(
  groupName: string,
  token: string,
  body: { name: string; online: boolean },
) {
  return api<{
    ok: boolean;
    name: string;
    online: boolean;
    updated_at: string;
  }>(groupPath(groupName, 'set-member-online'), {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function fetchGroupInfo(
  groupName = DEMO_GROUP,
  token = '',
  opts: { signal?: AbortSignal } = {},
): Promise<GroupInfo> {
  return api(groupPath(groupName, 'am-i-logged-in'), {
    token,
    signal: opts.signal,
  });
}

export async function fetchXpHistory(
  groupName = DEMO_GROUP,
  token = '',
  period: XpHistoryPeriod = '24h',
  skill = 'overall',
  signal?: AbortSignal,
): Promise<XpHistoryResponse> {
  const params = new URLSearchParams({ period, skill });
  return api(`${groupPath(groupName, 'xp-history')}?${params}`, { token, signal });
}

/**
 * Shared ("group") bank movements, newest first. Pass the `at` of the last
 * entry you hold as `before` to page backwards through history.
 */
export async function fetchBankLedger(
  groupName = DEMO_GROUP,
  token = '',
  opts: {
    limit?: number;
    before?: string;
    /** ISO instant, inclusive. With `to`, bounds one calendar day. */
    from?: string;
    /** ISO instant, exclusive. */
    to?: string;
    signal?: AbortSignal;
  } = {},
): Promise<BankLedgerResponse> {
  const { limit = 100, before, from, to, signal } = opts;
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return api(`${groupPath(groupName, 'bank-ledger')}?${params}`, { token, signal });
}

/** What kind of thing a member achieved. */
export type AchievementKind = 'level' | 'drop' | 'quest' | 'diary' | 'other';

/** One group achievement. Every field after `kind`/`title` may be absent. */
export type Achievement = {
  id: string;
  name: string;
  kind: AchievementKind;
  title: string;
  detail: string | null;
  skill_id: string | null;
  item_id: number | null;
  /** Stack size for drops; null on older entries, which the title still shows. */
  quantity?: number | null;
  /** RS3 gameval name for quests/diaries, e.g. quest_cooks_assistant. */
  gameval: string | null;
  image_url: string | null;
  at: string;
};

export type AchievementsResponse = {
  entries: Achievement[];
  has_more: boolean;
};

/**
 * Group achievement feed, newest first. Pass the `at` of the last entry you
 * hold as `before` to page backwards; `kind`/`member` filter server-side so
 * the paging stays correct across the whole history.
 */
export async function fetchAchievements(
  groupName = DEMO_GROUP,
  token = '',
  opts: {
    limit?: number;
    /** ISO instant of the oldest entry you hold (exclusive cursor). */
    before?: string;
    kind?: AchievementKind;
    member?: string;
    /** ISO instant, inclusive. With `to`, bounds one calendar day. */
    from?: string;
    /** ISO instant, exclusive. */
    to?: string;
    signal?: AbortSignal;
  } = {},
): Promise<AchievementsResponse> {
  const { limit = 50, before, kind, member, from, to, signal } = opts;
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  if (kind) params.set('kind', kind);
  if (member) params.set('member', member);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return api(`${groupPath(groupName, 'achievements')}?${params}`, { token, signal });
}

/** Per-member quest progress; only started/finished quests are listed. */
export type MemberQuests = {
  name: string;
  quests: Record<string, 'started' | 'finished'>;
};

export type QuestsResponse = {
  members: MemberQuests[];
};

export async function fetchQuests(
  groupName = DEMO_GROUP,
  token = '',
  signal?: AbortSignal,
): Promise<QuestsResponse> {
  return api(groupPath(groupName, 'quests'), { token, signal });
}

/** Shape returned by both member-profile writes. */
export type MemberProfileResult = {
  ok: boolean;
  name: string;
  nickname: string | null;
  discord_id: string | null;
  color: string | null;
  use_discord_avatar: boolean;
};

export async function addGroupMember(
  groupName: string,
  token: string,
  body: {
    name: string;
    nickname?: string;
    discord_id?: string;
    color?: string;
    use_discord_avatar?: boolean;
  },
) {
  return api<MemberProfileResult>(groupPath(groupName, 'add-group-member'), {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteGroupMember(
  groupName: string,
  token: string,
  name: string,
) {
  return api<{ ok: boolean }>(groupPath(groupName, 'delete-group-member'), {
    token,
    method: 'DELETE',
    body: JSON.stringify({ name }),
  });
}

export async function updateMemberProfile(
  groupName: string,
  token: string,
  body: {
    name: string;
    nickname?: string | null;
    discord_id?: string | null;
    color?: string | null;
    use_discord_avatar?: boolean;
  },
) {
  return api<MemberProfileResult>(groupPath(groupName, 'update-member-profile'), {
    token,
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** update-group-settings echoes the stored settings back; note: no member_count. */
export type GroupSettingsResult = {
  ok: boolean;
  name: string;
  token: string;
  mode: GroupMode;
  appearance: AppearanceTheme;
  member_slots: number;
  visibility: GroupVisibility;
  shares: GroupShares;
};

export async function fetchPublicGroups(
  query = '',
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<PublicGroupsResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (opts.limit) params.set('limit', String(opts.limit));
  const suffix = params.size ? `?${params}` : '';
  return api(`/api/public-groups${suffix}`, { signal: opts.signal });
}

export async function fetchLeaderboard(
  metric: LeaderboardMetric = 'views',
  opts: { period?: LeaderboardPeriod; limit?: number; signal?: AbortSignal } = {},
): Promise<LeaderboardResponse> {
  const params = new URLSearchParams({ metric });
  if (opts.period) params.set('period', opts.period);
  if (opts.limit) params.set('limit', String(opts.limit));
  return api(`/api/leaderboard?${params}`, { signal: opts.signal });
}

export async function recordGroupView(groupName: string): Promise<void> {
  try {
    await api(groupPath(groupName, 'view'), { method: 'POST' });
  } catch {
    /* a missed view is not worth a visible error */
  }
}

/** How many of each NPC each member has killed, biggest first. */
export type NpcKills = {
  members: Array<{
    name: string;
    total: number;
    kills: Array<{ npc: string; kills: number; last_at: string }>;
  }>;
};

export async function fetchNpcKills(
  groupName: string,
  token: string,
  signal?: AbortSignal,
): Promise<NpcKills> {
  return api(groupPath(groupName, 'npc-kills'), { token, signal });
}

/** RS3 achievements per member: finished ones, plus any counted progress. */
export type AchievementProgress = {
  members: Array<{
    name: string;
    completed: string[];
    in_progress: Array<{ gameval: string; progress: number; target: number }>;
  }>;
};

export async function fetchAchievementProgress(
  groupName: string,
  token: string,
  signal?: AbortSignal,
): Promise<AchievementProgress> {
  return api(groupPath(groupName, 'achievement-progress'), { token, signal });
}

/**
 * What a group announces when it drops: the shared list the API ships, plus
 * the group's own additions and silences, plus a value threshold for anything
 * nobody listed. `items` is the resolved set the plugin filters on.
 */
/** A stack-size window on a tracked item; null means that end is open. */
export type DropQuantity = {
  item_id: number;
  min: number | null;
  max: number | null;
};

export type DropRules = {
  threshold: number;
  include: number[];
  exclude: number[];
  /** Only the included items that carry a window. */
  quantities?: DropQuantity[];
  items: number[];
  shared_list_size: number;
};

export async function fetchDropRules(
  groupName: string,
  token: string,
  signal?: AbortSignal,
): Promise<DropRules> {
  return api(groupPath(groupName, 'drop-rules'), { token, signal });
}

/**
 * Partial update: omitted fields are left alone. `clear` runs first and
 * `quantities` last, so one call can move an item between lists, or add it and
 * give it a window. A null end on a window clears that end.
 */
export async function updateDropRules(
  groupName: string,
  token: string,
  body: {
    threshold?: number;
    include?: number[];
    exclude?: number[];
    clear?: number[];
    quantities?: Array<{ item_id: number; min: number | null; max: number | null }>;
  },
): Promise<DropRules> {
  return api(groupPath(groupName, 'drop-rules'), {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** The shared list itself, for showing what a group inherits by default. */
export type RareItemCatalogue = {
  updated: string;
  count: number;
  ids: number[];
};

export async function fetchRareItemCatalogue(
  signal?: AbortSignal,
): Promise<RareItemCatalogue> {
  return api('/api/items/rare', { signal });
}

/** Item id -> display name for every item in the game. */
export type ItemNameCatalogue = {
  updated: string;
  count: number;
  names: Record<number, string>;
};

export async function fetchItemNames(
  signal?: AbortSignal,
): Promise<ItemNameCatalogue> {
  return api('/api/items/names', { signal });
}

/** Items whose icon changes with stack size: id -> [[fromQuantity, file]]. */
export type ItemStackCatalogue = {
  updated: string;
  count: number;
  base: string;
  stacks: Record<number, Array<[number, string]>>;
};

export async function fetchItemStacks(
  signal?: AbortSignal,
): Promise<ItemStackCatalogue> {
  return api('/api/items/stacks', { signal });
}

/** High/low alchemy values: id -> [high, low?]. */
export type AlchCatalogue = {
  updated: string;
  count: number;
  alch: Record<number, [number, number?]>;
};

export async function fetchAlchValues(
  signal?: AbortSignal,
): Promise<AlchCatalogue> {
  return api('/api/items/alch', { signal });
}

/** Grand Exchange prices, refreshed server-side from the wiki feed. */
export type GePriceCatalogue = {
  updated: string;
  count: number;
  prices: Record<number, number>;
};

export async function fetchGePrices(
  signal?: AbortSignal,
): Promise<GePriceCatalogue> {
  return api('/api/items/prices', { signal });
}

export async function updateGroupSettings(
  groupName: string,
  token: string,
  body: {
    appearance?: AppearanceTheme;
    name?: string;
    visibility?: GroupVisibility;
    shares?: Partial<GroupShares>;
  },
): Promise<GroupSettingsResult> {
  return api(groupPath(groupName, 'update-group-settings'), {
    token,
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Downloads a group's own data. Both endpoints need the token in a header, so
 * neither can be a plain link — the response is pulled as a blob and handed to
 * the browser's download path.
 *
 * The ZIP is streamed by the server with no Content-Length, so there is no
 * progress to report; it is held in memory here only for as long as the save
 * dialog takes.
 */
async function downloadExport(
  groupName: string,
  token: string,
  endpoint: 'export' | 'export.zip',
): Promise<string> {
  const res = await fetch(groupPath(groupName, endpoint), {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res));
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  try {
    const filename =
      filenameFromDisposition(res.headers.get('Content-Disposition')) ??
      `rs3-group-ironman-export.${endpoint === 'export' ? 'json' : 'zip'}`;
    clickDownload(href, filename);
    return filename;
  } finally {
    // Revoking immediately would race the click on Safari, which reads the
    // object URL after the handler returns.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}

function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}

export function downloadGroupData(groupName: string, token: string) {
  return downloadExport(groupName, token, 'export');
}

export function downloadGroupArchive(groupName: string, token: string) {
  return downloadExport(groupName, token, 'export.zip');
}

type DeletionResult = GroupDeletion & { ok: boolean };

/**
 * Schedules erasure of everything this group holds. The name and token are
 * retyped into the body on top of the header the request already carries, so a
 * saved session alone cannot start it.
 */
export async function requestGroupDeletion(
  groupName: string,
  token: string,
  confirm: { confirm_name: string; confirm_token: string },
): Promise<DeletionResult> {
  return api(groupPath(groupName, 'request-deletion'), {
    token,
    method: 'POST',
    body: JSON.stringify(confirm),
  });
}

export async function cancelGroupDeletion(
  groupName: string,
  token: string,
): Promise<DeletionResult> {
  return api(groupPath(groupName, 'cancel-deletion'), {
    token,
    method: 'POST',
  });
}

export type CreateGroupResult = {
  name: string;
  mode: GroupMode;
  appearance: AppearanceTheme;
  member_slots: number;
  member_names: string[];
  visibility: GroupVisibility;
  shares: GroupShares;
  token: string;
};

export async function createGroup(body: {
  name: string;
  member_slots: number;
  member_names: string[];
  visibility?: GroupVisibility;
  shares?: Partial<GroupShares>;
}): Promise<CreateGroupResult> {
  return api('/api/create-group', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export { DEMO_GROUP };
