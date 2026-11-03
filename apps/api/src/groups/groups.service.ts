import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AchievementKind,
  AppearanceTheme,
  GroupMode,
  GroupVisibility,
  Prisma,
  type MemberInventory,
  type MemberInventoryItem,
  type MemberSkill,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import {
  ACHIEVEMENT_KIND_TO_GAMEVAL,
  gamevalDedupeKey,
  isGamevalName,
} from '../gamevals/gamevals.catalog';
import { GamevalsService } from '../gamevals/gamevals.service';
import { QuestCatalogService } from '../gamevals/quest-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { RareItemsService } from '../items/rare-items.service';
import { SKILL_BY_ID, type SkillId } from '../skills/skills.catalog';
import {
  detectSkillMilestones,
  parseAchievedAt,
  parseAchievementKind,
  parseAchievementLimit,
  parseAchievementMember,
  toAchievementEntry,
  validateImageUrl,
} from './achievements';
import {
  ledgerDateWindow,
  parseLedgerCursor,
  parseLedgerLimit,
} from './bank-ledger';
import {
  confirmationMatches,
  deletionDueAt,
  deletionStatus,
} from './group-deletion';
import {
  GroupAccessService,
  groupNameKey,
  isPublicGroup,
  requireShare,
  sharesScope,
} from './group-access.service';
import {
  leaderboardQuery,
  parseLeaderboardLimit,
  parseLeaderboardMetric,
  parseLeaderboardPeriod,
  periodStart,
  startOfUtcDay,
  toLeaderboardEntries,
  type LeaderboardRow,
} from './leaderboard';
import {
  findMemberRef,
  normalizeColor,
  normalizeDiscordId,
  normalizeNickname,
  normalizeUseDiscordAvatar,
  parseAppearance,
  parseGroupMode,
  parsePublicGroupsLimit,
  parseSearchQuery,
  parseVisibility,
  playableCount,
  sharesPatch,
  sharesToColumns,
  validateDisplayName,
  validateGroupName,
  validateInventoriesPayload,
  validateSkillsPayload,
} from './group-fields';
import {
  redactWireEntries,
  toPartialWireMember,
  toSharedWireMember,
  toWireMember,
  type WireEntry,
} from './group-wire';
import {
  AddMemberBody,
  ConfirmGroupDeletionBody,
  CreateAchievementBody,
  CreateGroupBody,
  DropRulesBody,
  MAX_MEMBERS,
  MIN_MEMBERS,
  PlayerMovedBody,
  RenameMemberBody,
  ReportKillsBody,
  ReportDropBody,
  SHARED_MEMBER,
  SetLocationSharingBody,
  SetTargetBody,
  SetMemberOnlineBody,
  SyncGroupModeBody,
  type SkillPayloadValue,
  UpdateGroupSettingsBody,
  UpdateMemberAchievementsBody,
  UpdateMemberBody,
  UpdateMemberProfileBody,
  UpdateMemberQuestsBody,
} from './group.types';
import {
  WIRE_INVENTORIES,
  coordsFromArray,
  diffItemTotals,
  inventoryContentHash,
  mergeItemPairs,
  pairsToRows,
  rowsToPairs,
  statsFromArray,
} from './item-codec';
import {
  achievementTitle,
  isFeedWorthyAchievement,
  planAchievementUpdate,
  resolveAchievementRefs,
  resolveAchievementTallies,
} from './achievement-sync';
import { planItemChanges } from './item-changes';
import { planQuestUpdate, resolveQuestInputs } from './quests';
import { normalizeSeedSkills } from './skill-codec';
import { type DbClient, XpHistoryService } from './xp-history.service';

type InventoryWithItems = MemberInventory & { items: MemberInventoryItem[] };

type SkillRow = {
  skillId: string;
  xp: bigint;
  level: number;
  baseLevel: number;
};

/** True when any incoming skill differs from what is stored for it. */
function skillsDiffer(before: SkillRow[], after: SkillRow[]): boolean {
  const byId = new Map(before.map((row) => [row.skillId, row]));
  return after.some((row) => {
    const previous = byId.get(row.skillId);
    return (
      !previous ||
      previous.xp !== row.xp ||
      previous.level !== row.level ||
      previous.baseLevel !== row.baseLevel
    );
  });
}

/**
 * How long a full group payload may be reused. Deltas are never cached, so this
 * only bounds how stale a periodic re-sync can be, well inside the 1.5s poll
 * cadence it serves. 0 disables sharing.
 */
const SNAPSHOT_CACHE_MS = Number(process.env.SNAPSHOT_CACHE_MS ?? 1_000);

/** Groups held in the snapshot cache before expired entries are swept. */
const SNAPSHOT_CACHE_MAX = 256;

const DEFAULT_STATS = [10, 10, 1, 1, 1, 1, 1];
const DEFAULT_COORDS = [3200, 3200, 0];

/**
 * Which separately-fetched endpoint a change invalidates. `members` is the
 * delta payload itself and needs no refetch; the rest are endpoints a client
 * would otherwise have to poll blindly.
 */
export type GroupChangeKind = 'members' | 'achievements' | 'quests' | 'settings';

export type GroupChange = { groupId: string; kind: GroupChangeKind };

/** `inventory_changes` key for the group storage, matching the snapshot field. */
const SHARED_BANK_FIELD = 'shared_bank';

/** Fields an update-group-member body may carry, echoed back as `applied`. */
const UPDATE_FIELDS = [
  'stats',
  'coordinates',
  'world',
  'inventory',
  'equipment',
  'bank',
  'inventories',
  'skills',
  'shared_bank',
  'deposited',
  'inventory_changes',
] as const;

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly xpHistory: XpHistoryService,
    private readonly gamevals: GamevalsService,
    private readonly questCatalog: QuestCatalogService,
    private readonly rareItems: RareItemsService,
  ) {}

  /**
   * Emits a group id whenever something about that group changes.
   *
   * Owned here rather than in GroupEventsService so the dependency runs one
   * way: the events service reads this, and nothing in this file needs to know
   * that SSE exists. Writes stay synchronous — emitting is just a function
   * call, and nobody may be listening.
   */
  private readonly changed = new Subject<GroupChange>();
  readonly changed$ = this.changed.asObservable();

  /** Recent full payloads, shared between concurrent readers of a group. */
  private readonly snapshots = new Map<
    string,
    { at: number; payload: Promise<WireEntry[]> }
  >();

  /**
   * Wakes any SSE subscribers for the group; a no-op when nobody is watching.
   *
   * The kinds say which of the separately-fetched endpoints a client should
   * re-read. Member state travels in the delta itself, so that is the default
   * and costs a client nothing extra.
   */
  notifyChanged(groupId: string, ...kinds: GroupChangeKind[]) {
    const list = kinds.length > 0 ? kinds : (['members'] as GroupChangeKind[]);
    for (const kind of list) {
      this.changed.next({ groupId, kind });
    }
  }

  async createGroup(body: CreateGroupBody) {
    const name = validateGroupName(body.name);

    const existing = await this.access.findGroup(name);
    if (existing) throw new ConflictException('Group already exists');

    const rawMembers = (body.member_names ?? [])
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && n !== SHARED_MEMBER);
    const seen = new Set<string>();
    const memberNames: string[] = [];
    for (const raw of rawMembers) {
      const memberName = validateDisplayName(raw, 'Player username');
      const key = memberName.toLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException('Player usernames must be unique');
      }
      seen.add(key);
      memberNames.push(memberName);
    }

    if (memberNames.length < MIN_MEMBERS || memberNames.length > MAX_MEMBERS) {
      throw new BadRequestException(
        `Groups must have ${MIN_MEMBERS}-${MAX_MEMBERS} players`,
      );
    }

    const slots =
      body.member_slots != null
        ? Number(body.member_slots)
        : memberNames.length;
    if (
      !Number.isInteger(slots) ||
      slots < MIN_MEMBERS ||
      slots > MAX_MEMBERS
    ) {
      throw new BadRequestException(
        `Group size must be ${MIN_MEMBERS}-${MAX_MEMBERS}`,
      );
    }
    if (memberNames.length !== slots) {
      throw new BadRequestException(
        `Add exactly ${slots} unique player usernames`,
      );
    }

    const visibility = parseVisibility(body.visibility);
    const shares = sharesToColumns(body.shares);
    const token = randomUUID();
    const defaults = statsFromArray(DEFAULT_STATS);
    const coords = coordsFromArray(DEFAULT_COORDS);

    try {
      await this.prisma.group.create({
        data: {
          name,
          nameKey: groupNameKey(name),
          token,
          appearance: AppearanceTheme.rs3,
          memberSlots: slots,
          visibility,
          ...shares,
          members: {
            create: memberNames.map((memberName) => ({
              name: memberName,
              ...defaults,
              ...coords,
            })),
          },
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Group already exists');
      }
      throw err;
    }

    return {
      name,
      mode: GroupMode.normal,
      appearance: 'rs3' as const,
      member_slots: slots,
      member_names: memberNames,
      visibility,
      shares: sharesScope(shares),
      token,
    };
  }

  async amILoggedIn(groupName: string, token: string | undefined) {
    const group = await this.access.read(groupName, token);
    return {
      ok: true,
      name: group.name,
      // Only echoed back to a caller that already proved it holds the token,
      // so the tokenless demo read never publishes one.
      ...(token ? { token: group.token } : {}),
      mode: group.mode,
      appearance: group.appearance,
      member_count: playableCount(group.members),
      member_slots: group.memberSlots,
      visibility: group.visibility,
      shares: sharesScope(group),
      visible: group.scope,
      // Bounds the ledger's day picker — there is nothing to show before it.
      // Optional rather than asserted: the client treats a missing date as "no
      // lower bound", which beats a 500 if a read ever lands without one.
      created_at: group.createdAt?.toISOString(),
      ...(token ? { deletion: deletionStatus(group) } : {}),
    };
  }

  async requestGroupDeletion(
    groupName: string,
    token: string | undefined,
    body: ConfirmGroupDeletionBody,
  ) {
    const group = await this.access.write(groupName, token);
    if (!confirmationMatches(group, body)) {
      throw new BadRequestException(
        'The group name and token must match this group exactly',
      );
    }
    // Re-requesting must not push the date back, or a stuck client could keep
    // the data alive indefinitely.
    if (group.deleteAfter) {
      return { ok: true, ...deletionStatus(group) };
    }

    const now = new Date();
    const updated = await this.prisma.group.update({
      where: { id: group.id },
      data: { deletionRequestedAt: now, deleteAfter: deletionDueAt(now) },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
    this.notifyChanged(group.id, 'settings');
    return { ok: true, ...deletionStatus(updated) };
  }

  async cancelGroupDeletion(groupName: string, token: string | undefined) {
    const group = await this.access.write(groupName, token);
    if (!group.deleteAfter) {
      return { ok: true, ...deletionStatus(group) };
    }
    const updated = await this.prisma.group.update({
      where: { id: group.id },
      data: { deletionRequestedAt: null, deleteAfter: null },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
    this.notifyChanged(group.id, 'settings');
    return { ok: true, ...deletionStatus(updated) };
  }

  async getGroupData(
    groupName: string,
    token: string | undefined,
    fromTime?: string,
    split = false,
  ) {
    // Deliberately the no-members variant: the member rows are re-read in full
    // below, so loading the relation here is a wasted round trip on the
    // hottest endpoint in the API.
    const group = await this.access.readWithoutMembers(groupName, token);
    const data = await this.buildGroupData(
      group.id,
      fromTime ? Date.parse(fromTime) : 0,
      split,
    );
    return redactWireEntries(data, group.scope);
  }

  /**
   * The group payload with no authentication.
   *
   * Split out so the SSE stream can authenticate once when a client connects
   * and then rebuild the payload on every change without repeating the auth
   * query — and, more importantly, so one build can be fanned out to every
   * subscriber of a group instead of one per connection.
   *
   * Callers are responsible for having proved access to `groupId`.
   */
  async buildGroupData(groupId: string, since: number, split = false) {
    // A full build is the same bytes for every caller of a group (`split` is
    // only consulted once `since` is set) and it is the expensive one: every
    // member's whole bank, serialised. Measured at ~2s of server time once a few
    // hundred viewers hit their periodic re-sync together, which blocks the
    // event loop and is what makes the cheap delta polls queue behind it.
    //
    // Deltas stay uncached, so the live map is unaffected.
    if (since === 0) return this.cachedSnapshot(groupId);
    return this.readGroupData(groupId, since, split);
  }

  /** Shares one in-flight or recent full build between concurrent callers. */
  private cachedSnapshot(groupId: string): Promise<WireEntry[]> {
    const now = Date.now();
    const hit = this.snapshots.get(groupId);
    if (hit && now - hit.at < SNAPSHOT_CACHE_MS) return hit.payload;

    const payload = this.readGroupData(groupId, 0, false).catch((err) => {
      // A failed build must not be served to everyone for the rest of the window.
      this.snapshots.delete(groupId);
      throw err;
    });
    this.snapshots.set(groupId, { at: now, payload });

    // Otherwise one entry accumulates for every group ever read.
    if (this.snapshots.size > SNAPSHOT_CACHE_MAX) {
      for (const [id, entry] of this.snapshots) {
        if (now - entry.at >= SNAPSHOT_CACHE_MS) this.snapshots.delete(id);
      }
    }
    return payload;
  }

  private async readGroupData(groupId: string, since: number, split = false) {
    const members = await this.prisma.member.findMany({
      where: { groupId },
    });

    /**
     * Whether this member's inventories and skills have to travel.
     *
     * Without `split` that is any change at all, which is why a position ping
     * used to drag the member's whole bank along with it. With `split` the
     * client can merge light fields onto what it already has, so only a real
     * data change needs the expensive payload.
     */
    const needsHeavy = (member: (typeof members)[number]) => {
      if (!since) return true;
      if (member.lastUpdated.getTime() < since) return false;
      return split ? member.dataUpdatedAt.getTime() >= since : true;
    };

    // Loading is driven by the same predicate, so skipped payloads are never
    // read out of the database in the first place.
    const freshIds = members.filter(needsHeavy).map((m) => m.id);

    const [inventories, skills, sharedEntry] = await Promise.all([
      freshIds.length
        ? this.prisma.memberInventory.findMany({
            where: { memberId: { in: freshIds } },
            include: { items: true },
          })
        : ([] as InventoryWithItems[]),
      freshIds.length
        ? this.prisma.memberSkill.findMany({
            where: { memberId: { in: freshIds } },
          })
        : ([] as MemberSkill[]),
      this.sharedBankWireEntry(groupId, since),
    ]);

    const inventoriesByMember = new Map<string, InventoryWithItems[]>();
    for (const inventory of inventories) {
      const list = inventoriesByMember.get(inventory.memberId);
      if (list) list.push(inventory);
      else inventoriesByMember.set(inventory.memberId, [inventory]);
    }
    const skillsByMember = new Map<string, MemberSkill[]>();
    for (const skill of skills) {
      const list = skillsByMember.get(skill.memberId);
      if (list) list.push(skill);
      else skillsByMember.set(skill.memberId, [skill]);
    }

    const wire: WireEntry[] = members.map((member) => {
      if (since && member.lastUpdated.getTime() < since) {
        return { name: member.name };
      }
      // Moved but nothing expensive changed: send the light fields only and
      // let the client keep the inventories and skills it already holds.
      if (!needsHeavy(member)) {
        return toPartialWireMember(member);
      }
      return toWireMember({
        ...member,
        inventories: inventoriesByMember.get(member.id) ?? [],
        skills: skillsByMember.get(member.id) ?? [],
      });
    });

    if (sharedEntry) wire.push(sharedEntry);
    return wire;
  }

  /**
   * The shared bank is group-owned but travels as the "@SHARED" pseudo-member
   * so existing clients keep working, following the same delta rule as a real
   * member.
   *
   * On a delta poll its contents are usually unchanged, so the timestamps are
   * read first and the items — up to 4000 rows — are only fetched when they
   * will actually be sent. Previously every poll loaded the whole shared bank
   * and discarded it, which at a 1.5s cadence is the single largest pointless
   * read in the API.
   */
  private async sharedBankWireEntry(groupId: string, since: number) {
    if (since) {
      const meta = await this.prisma.groupInventory.findMany({
        where: { groupId },
        select: { updatedAt: true },
      });
      if (!meta.length) return null;
      const updatedAt = Math.max(...meta.map((i) => i.updatedAt.getTime()));
      if (updatedAt < since) return { name: SHARED_MEMBER };
    }

    const inventories = await this.prisma.groupInventory.findMany({
      where: { groupId },
      include: { items: true },
    });
    if (!inventories.length) return null;
    const updatedAt = Math.max(
      ...inventories.map((i) => i.updatedAt.getTime()),
    );
    return toSharedWireMember(inventories, new Date(updatedAt));
  }

  async getXpHistory(
    groupName: string,
    token: string | undefined,
    period?: string,
    skill?: string,
  ) {
    return this.xpHistory.getXpHistory(
      groupName,
      token,
      async (g, t) => {
        const group = await this.access.read(g, t);
        requireShare(group, 'skills');
        return group;
      },
      period,
      skill,
    );
  }

  /**
   * Shared bank movement log, newest first. Cursor paging via `before`
   * (ISO timestamp). Bad input is clamped/ignored rather than rejected.
   */
  async getBankLedger(
    groupName: string,
    token: string | undefined,
    limitRaw?: string,
    beforeRaw?: string,
    fromRaw?: string,
    toRaw?: string,
  ) {
    // Only group.id is needed, so skip loading the members relation.
    const group = await this.access.readWithoutMembers(groupName, token);
    requireShare(group, 'items');
    const limit = parseLedgerLimit(limitRaw);
    const before = parseLedgerCursor(beforeRaw);
    // `from`/`to` bound a calendar day. The client sends real instants so the
    // day boundaries follow the viewer's timezone, not the server's.
    const from = parseLedgerCursor(fromRaw);
    const to = parseLedgerCursor(toRaw);

    const createdAt = ledgerDateWindow(before, from, to);

    const rows = await this.prisma.sharedBankEntry.findMany({
      where: {
        groupId: group.id,
        ...(createdAt ? { createdAt } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        memberName: true,
        itemId: true,
        delta: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      id: row.id,
      name: row.memberName,
      item_id: row.itemId,
      delta: row.delta,
      at: row.createdAt.toISOString(),
    }));

    return { entries, has_more: hasMore };
  }

  /**
   * Group achievement feed, newest first. Cursor paging via `before` (ISO
   * timestamp). Bad input is clamped/ignored rather than rejected.
   */
  async getAchievements(
    groupName: string,
    token: string | undefined,
    limitRaw?: string,
    beforeRaw?: string,
    kindRaw?: string,
    memberRaw?: string,
    fromRaw?: string,
    toRaw?: string,
  ) {
    // Only group.id is needed, so skip loading the members relation.
    const group = await this.access.readWithoutMembers(groupName, token);
    requireShare(group, 'achievements');
    const limit = parseAchievementLimit(limitRaw);
    const before = parseLedgerCursor(beforeRaw);
    const kind = parseAchievementKind(kindRaw);
    const member = parseAchievementMember(memberRaw);
    // Same calendar-day window as the bank ledger: the client sends real
    // instants so day boundaries follow the viewer's timezone.
    const achievedAt = ledgerDateWindow(
      before,
      parseLedgerCursor(fromRaw),
      parseLedgerCursor(toRaw),
    );

    const rows = await this.prisma.achievement.findMany({
      where: {
        groupId: group.id,
        ...(achievedAt ? { achievedAt } : {}),
        ...(kind ? { kind } : {}),
        ...(member ? { memberName: member } : {}),
      },
      orderBy: [{ achievedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        memberName: true,
        kind: true,
        title: true,
        detail: true,
        skillId: true,
        itemId: true,
        quantity: true,
        gameval: true,
        imageUrl: true,
        achievedAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const entries = (hasMore ? rows.slice(0, limit) : rows).map(
      toAchievementEntry,
    );

    return { entries, has_more: hasMore };
  }

  /** Manually posted achievement (plugin drop notifier / web form). */
  async createAchievement(
    groupName: string,
    token: string | undefined,
    body: CreateAchievementBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');

    const title = body.title?.trim();
    if (!title) throw new BadRequestException('title is required');
    const detail = body.detail?.trim() || null;

    let skillId: string | null = null;
    if (body.skill_id != null && body.skill_id.trim() !== '') {
      const candidate = body.skill_id.trim().toLowerCase();
      if (!SKILL_BY_ID[candidate as SkillId]) {
        throw new BadRequestException('skill_id is not a known RS3 skill');
      }
      skillId = candidate;
    }

    const imageUrl = validateImageUrl(body.image_url, process.env.CDN_BASE_URL);
    const achievedAt = parseAchievedAt(body.achieved_at);

    // Quest/diary posts may carry a gameval so the completion has a stable
    // key. A repeat post for the same member + gameval returns the existing
    // row instead of adding a duplicate to the feed.
    const gameval = this.resolveAchievementGameval(body);
    const gamevalKind = ACHIEVEMENT_KIND_TO_GAMEVAL[body.kind];
    const dedupeKey =
      gameval && gamevalKind
        ? gamevalDedupeKey(name, gamevalKind, gameval)
        : // Plain manual posts are never deduped: NULL never collides in a
          // Postgres unique index, so many may coexist per group.
          null;

    const select = {
      id: true,
      memberName: true,
      kind: true,
      title: true,
      detail: true,
      skillId: true,
      itemId: true,
      quantity: true,
      gameval: true,
      imageUrl: true,
      achievedAt: true,
    } as const;

    if (dedupeKey) {
      const existing = await this.prisma.achievement.findUnique({
        where: { groupId_dedupeKey: { groupId: group.id, dedupeKey } },
        select,
      });
      if (existing) return toAchievementEntry(existing);
    }

    const row = await this.prisma.achievement.create({
      data: {
        groupId: group.id,
        memberName: name,
        kind: body.kind,
        title,
        detail,
        skillId,
        itemId: body.item_id ?? null,
        gameval,
        imageUrl,
        dedupeKey,
        achievedAt,
      },
      select,
    });

    this.notifyChanged(group.id, 'achievements');
    return toAchievementEntry(row);
  }

  /**
   * A drop the plugin saw. The list of what counts lives here rather than in
   * the client, so it can be corrected without a plugin release; a client
   * running an older copy of the list cannot post something off it.
   */
  async reportDrop(
    groupName: string,
    token: string | undefined,
    body: ReportDropBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');

    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const itemId = Math.round(body.item_id);
    const value = body.value && body.value > 0 ? Math.round(body.value) : 0;
    const quantity = body.quantity && body.quantity > 1 ? Math.round(body.quantity) : 1;
    if (!(await this.dropCounts(group.id, itemId, value, quantity))) {
      return { ok: true, recorded: false, item_id: itemId };
    }

    const itemName = body.item_name?.trim() || `Item ${itemId}`;
    const title = quantity > 1 ? `${itemName} x${quantity}` : itemName;
    const source = body.source?.trim();
    const now = new Date();

    const row = await this.prisma.achievement.create({
      data: {
        groupId: group.id,
        memberName: name,
        kind: AchievementKind.drop,
        title,
        detail: source ? `Dropped by ${source}` : null,
        itemId,
        quantity,
        achievedAt: now,
      },
      select: {
        id: true,
        memberName: true,
        kind: true,
        title: true,
        detail: true,
        skillId: true,
        itemId: true,
        quantity: true,
        gameval: true,
        imageUrl: true,
        achievedAt: true,
      },
    });

    this.notifyChanged(group.id, 'achievements');
    return { ok: true, recorded: true, achievement: toAchievementEntry(row) };
  }

  /**
   * Whether a drop is worth announcing for this group. The group's own word
   * comes first either way, then the shared list, then the group's value
   * threshold — so a group can add what the list misses, silence what it has,
   * and still catch anything expensive.
   */
  private async dropCounts(
    groupId: string,
    itemId: number,
    value: number,
    quantity: number,
  ): Promise<boolean> {
    const [override, group] = await Promise.all([
      this.prisma.groupRareItem.findUnique({
        where: { groupId_itemId: { groupId, itemId } },
        select: { include: true, minQty: true, maxQty: true },
      }),
      this.prisma.group.findUnique({
        where: { id: groupId },
        select: { dropThreshold: true },
      }),
    ]);
    if (override) {
      if (!override.include) return false;
      // A range narrows the group's own opinion: outside it, this drop is not
      // the one they asked for, so it falls through to nothing rather than
      // back to the shared list — they have already overridden that.
      if (override.minQty != null && quantity < override.minQty) return false;
      if (override.maxQty != null && quantity > override.maxQty) return false;
      return true;
    }
    if (this.rareItems.has(itemId)) return true;
    const threshold = group?.dropThreshold ?? 0;
    return threshold > 0 && value >= threshold;
  }

  /** The group's drop rules, with the shared list's size for context. */
  async getDropRules(groupName: string, token: string | undefined) {
    const group = await this.access.readWithoutMembers(groupName, token);
    requireShare(group, 'achievements');
    const rows = await this.prisma.groupRareItem.findMany({
      where: { groupId: group.id },
      select: { itemId: true, include: true, minQty: true, maxQty: true },
      orderBy: { itemId: 'asc' },
    });
    const full = await this.prisma.group.findUnique({
      where: { id: group.id },
      select: { dropThreshold: true },
    });
    const include = rows.filter((r) => r.include).map((r) => r.itemId);
    const exclude = rows.filter((r) => !r.include).map((r) => r.itemId);

    // The resolved list, so a client can decide locally and stop reporting
    // every bone it picks up. The rules still run here on arrival.
    const silenced = new Set(exclude);
    const items = new Set<number>(include);
    for (const itemId of this.rareItems.list()) {
      if (!silenced.has(itemId)) items.add(itemId);
    }

    // Only rows that actually carry a window, so an untouched group sends an
    // empty array rather than a null for every item it tracks.
    const quantities = rows
      .filter((r) => r.include && (r.minQty != null || r.maxQty != null))
      .map((r) => ({ item_id: r.itemId, min: r.minQty, max: r.maxQty }));

    return {
      threshold: full?.dropThreshold ?? 0,
      include,
      exclude,
      quantities,
      items: [...items].sort((a, b) => a - b),
      shared_list_size: this.rareItems.count,
    };
  }

  async updateDropRules(
    groupName: string,
    token: string | undefined,
    body: DropRulesBody,
  ) {
    const group = await this.access.write(groupName, token);

    await this.prisma.$transaction(async (tx) => {
      if (body.threshold !== undefined) {
        await tx.group.update({
          where: { id: group.id },
          data: { dropThreshold: Math.round(body.threshold!) },
        });
      }
      // Clear first, so one request may move an item between the two lists.
      const clear = body.clear ?? [];
      if (clear.length) {
        await tx.groupRareItem.deleteMany({
          where: { groupId: group.id, itemId: { in: clear.map(Math.round) } },
        });
      }
      for (const [ids, include] of [
        [body.include ?? [], true],
        [body.exclude ?? [], false],
      ] as Array<[number[], boolean]>) {
        for (const raw of ids) {
          const itemId = Math.round(raw);
          await tx.groupRareItem.upsert({
            where: { groupId_itemId: { groupId: group.id, itemId } },
            // A row switching lists keeps no window: a range set while the item
            // was tracked would silently narrow it again if it came back.
            update: { include, minQty: null, maxQty: null },
            create: { groupId: group.id, itemId, include },
          });
        }
      }

      // Ranges last, so one request can add an item and give it a window.
      for (const range of body.quantities ?? []) {
        const itemId = Math.round(range.item_id);
        const minQty = range.min == null ? null : Math.round(range.min);
        const maxQty = range.max == null ? null : Math.round(range.max);
        if (minQty != null && maxQty != null && minQty > maxQty) {
          throw new BadRequestException(
            `Minimum quantity is above the maximum for item ${itemId}`,
          );
        }
        await tx.groupRareItem.upsert({
          where: { groupId_itemId: { groupId: group.id, itemId } },
          update: { minQty, maxQty },
          create: { groupId: group.id, itemId, include: true, minQty, maxQty },
        });
      }
    });

    this.notifyChanged(group.id, 'settings');
    return this.getDropRules(groupName, token);
  }

  /**
   * Gameval name for a posted achievement, or null when none was supplied.
   * `gameval` (name) wins over `gameval_id`; either must exist in the table
   * for the achievement kind, and kinds without a table (level/drop) reject
   * both so a client can't attach a meaningless key.
   */
  private resolveAchievementGameval(
    body: CreateAchievementBody,
  ): string | null {
    const rawName = body.gameval?.trim().toLowerCase();
    const hasName = !!rawName;
    const hasId = body.gameval_id != null;
    if (!hasName && !hasId) return null;

    const kind = ACHIEVEMENT_KIND_TO_GAMEVAL[body.kind];
    if (!kind) {
      throw new BadRequestException(
        `gameval is only accepted for quest, diary and other achievements`,
      );
    }

    if (hasName) {
      if (!isGamevalName(rawName) || !this.gamevals.hasName(kind, rawName)) {
        throw new BadRequestException(`gameval is not a known ${kind} name`);
      }
      return rawName;
    }

    const resolved = this.gamevals.nameOf(kind, body.gameval_id!);
    if (!resolved) {
      throw new BadRequestException(`gameval_id is not a known ${kind} id`);
    }
    return resolved;
  }

  /**
   * Quest progress for every playable member: `{ gameval: state }` with only
   * started/finished quests present. Static quest data (names, points) is
   * the web's job, so the payload stays small.
   */
  async getMemberQuests(groupName: string, token: string | undefined) {
    const group = await this.access.read(groupName, token);
    requireShare(group, 'quests');
    const members = group.members.filter((m) => m.name !== SHARED_MEMBER);
    const rows = members.length
      ? await this.prisma.memberQuest.findMany({
          where: { memberId: { in: members.map((m) => m.id) } },
          select: { memberId: true, gameval: true, state: true },
        })
      : [];

    const byMember = new Map<string, Record<string, string>>();
    for (const row of rows) {
      let quests = byMember.get(row.memberId);
      if (!quests) {
        quests = {};
        byMember.set(row.memberId, quests);
      }
      quests[row.gameval] = row.state;
    }

    return {
      members: members.map((m) => ({
        name: m.name,
        quests: byMember.get(m.id) ?? {},
      })),
    };
  }

  /**
   * Plugin quest sync. Quests are stored by gameval name; ids in the body
   * are resolved through the gameval table first. A member's very first
   * sync is the baseline (like skills), so it records state but does not
   * flood the feed with one achievement per already-finished quest.
   */
  async updateMemberQuests(
    groupName: string,
    token: string | undefined,
    body: UpdateMemberQuestsBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');
    if (name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    // Validate everything before opening a transaction.
    const { states: next, skipped } = resolveQuestInputs(
      body.quests,
      this.gamevals,
    );
    const full = body.full === true;
    const now = new Date();

    const plan = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.memberQuest.findMany({
        where: { memberId: member.id },
        select: { gameval: true, state: true },
      });
      const previous = new Map(stored.map((r) => [r.gameval, r.state]));
      const plan = planQuestUpdate(previous, next, full);

      // Changed rows are replaced rather than upserted one by one: two
      // statements regardless of how many quests a full sync touches.
      const replaced = [...plan.remove, ...plan.write.map((w) => w.gameval)];
      if (replaced.length) {
        await tx.memberQuest.deleteMany({
          where: { memberId: member.id, gameval: { in: replaced } },
        });
      }
      if (plan.write.length) {
        await tx.memberQuest.createMany({
          data: plan.write.map((w) => ({
            memberId: member.id,
            gameval: w.gameval,
            state: w.state,
            updatedAt: now,
          })),
        });
      }

      const isBaseline = previous.size === 0;
      const recordAchievements = body.achievements !== false;
      if (plan.finished.length && !isBaseline && recordAchievements) {
        await tx.achievement.createMany({
          data: plan.finished.map((gameval) => ({
            groupId: group.id,
            memberName: member.name,
            kind: AchievementKind.quest,
            title: this.questCatalog.nameOf(gameval),
            detail: 'Quest complete',
            gameval,
            // Same key a manual quest post would use, so the two never double up.
            dedupeKey: gamevalDedupeKey(member.name, 'quest', gameval),
            achievedAt: now,
          })),
          skipDuplicates: true,
        });
      }
      return { ...plan, isBaseline };
    });

    this.notifyChanged(group.id, 'quests', 'achievements');
    return {
      ok: true,
      name: member.name,
      written: plan.write.length,
      removed: plan.remove.length,
      finished: plan.finished,
      baseline: plan.isBaseline,
      skipped,
    };
  }

  /** Completed achievements per member, keyed by gameval. */
  async getMemberAchievements(groupName: string, token: string | undefined) {
    const group = await this.access.read(groupName, token);
    requireShare(group, 'quests');
    const members = group.members.filter((m) => m.name !== SHARED_MEMBER);
    const rows = members.length
      ? await this.prisma.memberAchievement.findMany({
          where: { memberId: { in: members.map((m) => m.id) } },
          select: { memberId: true, gameval: true },
        })
      : [];

    const tallyRows = members.length
      ? await this.prisma.memberAchievementTally.findMany({
          where: { memberId: { in: members.map((m) => m.id) } },
          select: {
            memberId: true,
            gameval: true,
            progress: true,
            target: true,
          },
          orderBy: { gameval: 'asc' },
        })
      : [];

    const byMember = new Map<string, string[]>();
    for (const row of rows) {
      const list = byMember.get(row.memberId);
      if (list) list.push(row.gameval);
      else byMember.set(row.memberId, [row.gameval]);
    }

    const talliesByMember = new Map<
      string,
      Array<{ gameval: string; progress: number; target: number }>
    >();
    for (const row of tallyRows) {
      const entry = {
        gameval: row.gameval,
        progress: row.progress,
        target: row.target,
      };
      const list = talliesByMember.get(row.memberId);
      if (list) list.push(entry);
      else talliesByMember.set(row.memberId, [entry]);
    }

    return {
      members: members.map((m) => ({
        name: m.name,
        completed: (byMember.get(m.id) ?? []).sort(),
        in_progress: talliesByMember.get(m.id) ?? [],
      })),
    };
  }

  /**
   * Plugin achievement sync. Newly completed achievements also land in the
   * group feed, except on a member's first ever sync: that establishes the
   * baseline, and posting thousands of historical completions would bury it.
   */
  async updateMemberAchievements(
    groupName: string,
    token: string | undefined,
    body: UpdateMemberAchievementsBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');
    if (name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const { completed: next, skipped } = resolveAchievementRefs(
      body.completed,
      this.gamevals,
    );
    const full = body.full === true;
    const recordFeed = body.achievements !== false;
    const tallies = resolveAchievementTallies(body.tallies ?? [], this.gamevals);
    const now = new Date();

    const plan = await this.prisma.$transaction(
      async (tx) => {
        const stored = await tx.memberAchievement.findMany({
          where: { memberId: member.id },
          select: { gameval: true },
        });
        const previous = new Set(stored.map((row) => row.gameval));
        const plan = planAchievementUpdate(previous, next, full);
        const isBaseline = previous.size === 0;

        if (plan.remove.length) {
          await tx.memberAchievement.deleteMany({
            where: { memberId: member.id, gameval: { in: plan.remove } },
          });
        }
        if (plan.add.length) {
          await tx.memberAchievement.createMany({
            data: plan.add.map((gameval) => ({
              memberId: member.id,
              gameval,
              updatedAt: now,
            })),
            skipDuplicates: true,
          });

          const feed =
            recordFeed && !isBaseline
              ? plan.add.filter(isFeedWorthyAchievement)
              : [];
          if (feed.length) {
            await tx.achievement.createMany({
              data: feed.map((gameval) => ({
                groupId: group.id,
                memberName: member.name,
                kind: AchievementKind.other,
                title: achievementTitle(gameval),
                detail: 'Achievement complete',
                gameval,
                dedupeKey: gamevalDedupeKey(
                  member.name,
                  'achievement',
                  gameval,
                ),
                achievedAt: now,
              })),
              skipDuplicates: true,
            });
          }
        }
        // Tallies are a snapshot of what is in progress. A full update owns
        // the set, so anything missing from it has finished or been abandoned;
        // a partial one only writes what it carries.
        if (body.tallies) {
          const keep = tallies.map((t) => t.gameval);
          await tx.memberAchievementTally.deleteMany({
            where: full
              ? { memberId: member.id, gameval: { notIn: keep } }
              : { memberId: member.id, gameval: { in: next ? [...next] : [] } },
          });
          for (const tally of tallies) {
            await tx.memberAchievementTally.upsert({
              where: {
                memberId_gameval: { memberId: member.id, gameval: tally.gameval },
              },
              update: {
                progress: tally.progress,
                target: tally.target,
                updatedAt: now,
              },
              create: {
                memberId: member.id,
                gameval: tally.gameval,
                progress: tally.progress,
                target: tally.target,
                updatedAt: now,
              },
            });
          }
        }

        // A completed achievement is no longer in progress.
        if (plan.add.length) {
          await tx.memberAchievementTally.deleteMany({
            where: { memberId: member.id, gameval: { in: plan.add } },
          });
        }

        return { ...plan, isBaseline, tallies: tallies.length };
      },
      { maxWait: 5_000, timeout: 20_000 },
    );

    this.notifyChanged(group.id, 'achievements');
    return {
      ok: true,
      name: member.name,
      added: plan.add.length,
      removed: plan.remove.length,
      baseline: plan.isBaseline,
      tallies: plan.tallies,
      // A count, not the list: a client built against a newer cache dump than
      // this server's can legitimately skip thousands.
      skipped: skipped.length,
    };
  }

  async updateGroupMember(
    groupName: string,
    token: string | undefined,
    body: UpdateMemberBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');
    if (name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }

    // Validate before touching the DB so bad payloads never open a transaction.
    const skills = body.skills ? validateSkillsPayload(body.skills) : undefined;
    const inventories = body.inventories
      ? validateInventoriesPayload(body.inventories, (key) =>
          this.gamevals.hasName('inv', key),
        )
      : undefined;
    // Changes are per-item totals, so the positional backpack is excluded.
    const changes = body.inventory_changes
      ? validateInventoriesPayload(
          body.inventory_changes,
          (key) =>
            key !== 'inventory' &&
            key !== WIRE_INVENTORIES.inventory &&
            (key in WIRE_INVENTORIES ||
              key === SHARED_BANK_FIELD ||
              this.gamevals.hasName('inv', key)),
        )
      : undefined;

    // Pushes only update roster members. The token is shared by the whole
    // group, so a holder logged into another account must not be able to add
    // it; the roster is managed through add-group-member.
    const existing = findMemberRef(group.members, name);
    if (!existing) throw new NotFoundException('Member not found');

    const now = new Date();
    const vitals = body.stats ? statsFromArray(body.stats) : undefined;
    const coords = body.coordinates
      ? coordsFromArray(body.coordinates)
      : undefined;
    const hasDeposit = !!body.deposited?.length;

    // Whether the request even mentions the expensive payload. Carrying it is
    // necessary but not sufficient to bump dataUpdatedAt: the plugin resends the
    // whole bank on a schedule whether or not anything moved, and bumping on an
    // identical resend makes every viewer re-download that member's bank on
    // their next delta. The writes below report what actually changed.
    const mayTouchHeavyData =
      !!body.inventory ||
      !!body.equipment ||
      !!body.bank ||
      !!body.inventories ||
      !!body.skills ||
      !!changes ||
      hasDeposit;

    let dataChanged = false;
    let postedAchievements = false;
    await this.prisma.$transaction(
      async (tx) => {
        const memberId = existing.id;
        // dataUpdatedAt is set afterwards, once the writes below have said
        // whether the heavy payload really moved.
        await tx.member.update({
          where: { id: memberId },
          data: {
            lastUpdated: now,
            online: true,
            inLobby: false,
            ...(vitals ?? {}),
            ...(coords ?? {}),
            ...(body.world === undefined
              ? {}
              : { world: Math.round(body.world) }),
            ...(body.baseline === true ? { baselineAt: now } : {}),
          },
          select: { id: true },
        });

        // Only true once a write below reports a real change.
        let heavyChanged = false;

        // Named wire fields first, then the generic map. A key present in
        // both is written twice and the generic one wins, which is harmless.
        if (body.inventory) {
          heavyChanged ||= await this.replaceMemberInventory(
            tx,
            memberId,
            WIRE_INVENTORIES.inventory,
            body.inventory,
            now,
          );
        }
        if (body.equipment) {
          heavyChanged ||= await this.replaceMemberInventory(
            tx,
            memberId,
            WIRE_INVENTORIES.equipment,
            body.equipment,
            now,
          );
        }

        // Compute the final bank once: full bank (+ deposits) or current + deposits.
        let finalBank: number[] | undefined;
        if (body.bank && hasDeposit) {
          finalBank = mergeItemPairs(body.bank, body.deposited!);
        } else if (body.bank) {
          finalBank = body.bank;
        } else if (hasDeposit) {
          const currentBank = await this.memberInventoryPairs(
            tx,
            memberId,
            WIRE_INVENTORIES.bank,
          );
          finalBank = mergeItemPairs(currentBank, body.deposited!);
        }
        if (finalBank) {
          heavyChanged ||= await this.replaceMemberInventory(
            tx,
            memberId,
            WIRE_INVENTORIES.bank,
            finalBank,
            now,
          );
        }

        if (inventories) {
          for (const [key, pairs] of Object.entries(inventories)) {
            heavyChanged ||= await this.replaceMemberInventory(
              tx,
              memberId,
              key,
              pairs,
              now,
            );
          }
        }

        if (skills) {
          const result = await this.replaceSkills(
            tx,
            group.id,
            memberId,
            name,
            skills,
            now,
            body.achievements !== false,
          );
          heavyChanged ||= result.changed;
          postedAchievements ||= result.posted;
        }

        // An empty list is a real snapshot (the group emptied its storage), so
        // only an absent field skips this.
        if (body.shared_bank) {
          // The shared bank is the group's own `bank` inventory. Snapshot
          // BEFORE replacing so the ledger can diff against it.
          const previousShared = await this.groupInventoryPairs(
            tx,
            group.id,
            WIRE_INVENTORIES.bank,
          );
          await this.replaceGroupInventory(
            tx,
            group.id,
            WIRE_INVENTORIES.bank,
            body.shared_bank,
            now,
          );

          await this.recordSharedMovements(
            tx,
            group.id,
            name,
            diffItemTotals(previousShared, body.shared_bank),
            now,
          );
        }

        // Per-item deltas. A full snapshot of the same inventory in this
        // request already holds the final state, so its deltas are skipped.
        if (changes) {
          const snapshotKeys = new Set<string>(Object.keys(inventories ?? {}));
          if (body.inventory) snapshotKeys.add(WIRE_INVENTORIES.inventory);
          if (body.equipment) snapshotKeys.add(WIRE_INVENTORIES.equipment);
          if (finalBank) snapshotKeys.add(WIRE_INVENTORIES.bank);

          for (const [field, pairs] of Object.entries(changes)) {
            if (field === SHARED_BANK_FIELD) {
              if (body.shared_bank) continue;
              const movements = await this.applyGroupInventoryChanges(
                tx,
                group.id,
                WIRE_INVENTORIES.bank,
                pairs,
                now,
              );
              await this.recordSharedMovements(
                tx,
                group.id,
                name,
                movements,
                now,
              );
              continue;
            }
            const key =
              (WIRE_INVENTORIES as Record<string, string>)[field] ?? field;
            if (snapshotKeys.has(key)) continue;
            heavyChanged ||= await this.applyMemberInventoryChanges(
              tx,
              memberId,
              key,
              pairs,
              now,
            );
          }
        }

        // One extra single-row update when the heavy payload really moved, in
        // exchange for not making every viewer of this group re-download the
        // member's bank after a no-op resend. Guarded by mayTouchHeavyData so a
        // position-only ping still cannot reach it.
        if (mayTouchHeavyData && heavyChanged) {
          await tx.member.update({
            where: { id: memberId },
            data: { dataUpdatedAt: now },
            select: { id: true },
          });
        }
        dataChanged = heavyChanged;
      },
      { maxWait: 5_000, timeout: 20_000 },
    );

    if (postedAchievements) this.notifyChanged(group.id, 'members', 'achievements');
    else this.notifyChanged(group.id);
    return {
      ok: true,
      name: existing.name,
      updated_at: now.toISOString(),
      applied: UPDATE_FIELDS.filter((field) => body[field] !== undefined),
      data_changed: dataChanged,
    };
  }

  private async recordSharedMovements(
    db: DbClient,
    groupId: string,
    memberName: string,
    movements: Array<{ itemId: number; delta: number }>,
    now: Date,
  ) {
    if (!movements.length) return;
    await db.sharedBankEntry.createMany({
      data: movements.map((m) => ({
        groupId,
        memberName,
        itemId: m.itemId,
        delta: m.delta,
        createdAt: now,
      })),
    });
  }

  /** Apply [itemId, newTotal, ...] to a member inventory; true when it changed. */
  private async applyMemberInventoryChanges(
    db: DbClient,
    memberId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    const inventory = await db.memberInventory.upsert({
      where: { memberId_key: { memberId, key } },
      create: { memberId, key, updatedAt: now },
      update: {},
      select: { id: true },
    });
    const current = await db.memberInventoryItem.findMany({
      where: { inventoryId: inventory.id },
      select: { slot: true, itemId: true, quantity: true },
    });
    const plan = planItemChanges(current, pairs);
    if (!plan.changed) return false;

    if (plan.deleteItemIds.length) {
      await db.memberInventoryItem.deleteMany({
        where: {
          inventoryId: inventory.id,
          itemId: { in: plan.deleteItemIds },
        },
      });
    }
    if (plan.insert.length) {
      await db.memberInventoryItem.createMany({
        data: plan.insert.map((row) => ({ ...row, inventoryId: inventory.id })),
      });
    }
    await db.memberInventory.update({
      where: { id: inventory.id },
      data: { updatedAt: now, contentHash: inventoryContentHash(plan.rows) },
      select: { id: true },
    });
    return true;
  }

  /** Same as above for a group-owned inventory; returns the ledger movements. */
  private async applyGroupInventoryChanges(
    db: DbClient,
    groupId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<Array<{ itemId: number; delta: number }>> {
    const inventory = await db.groupInventory.upsert({
      where: { groupId_key: { groupId, key } },
      create: { groupId, key, updatedAt: now },
      update: {},
      select: { id: true },
    });
    const current = await db.groupInventoryItem.findMany({
      where: { inventoryId: inventory.id },
      select: { slot: true, itemId: true, quantity: true },
    });
    const plan = planItemChanges(current, pairs);
    if (!plan.changed) return [];

    if (plan.deleteItemIds.length) {
      await db.groupInventoryItem.deleteMany({
        where: {
          inventoryId: inventory.id,
          itemId: { in: plan.deleteItemIds },
        },
      });
    }
    if (plan.insert.length) {
      await db.groupInventoryItem.createMany({
        data: plan.insert.map((row) => ({ ...row, inventoryId: inventory.id })),
      });
    }
    await db.groupInventory.update({
      where: { id: inventory.id },
      data: { updatedAt: now, contentHash: inventoryContentHash(plan.rows) },
      select: { id: true },
    });
    return plan.movements;
  }

  /** Fast path for live map — coordinates only. */
  async playerMoved(
    groupName: string,
    token: string | undefined,
    body: PlayerMovedBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = body.name?.trim();
    if (!name || name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const coords = body.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      throw new BadRequestException(
        'coordinates must be [x, y] or [x, y, plane]',
      );
    }
    const x = Number(coords[0]);
    const y = Number(coords[1]);
    const hasPlane = coords.length >= 3;
    const plane = hasPlane ? Number(coords[2]) : 0;
    if (![x, y, plane].every((n) => Number.isFinite(n))) {
      throw new BadRequestException('coordinates must be finite numbers');
    }

    const now = new Date();
    const rounded = {
      x: Math.round(x),
      y: Math.round(y),
      ...(hasPlane ? { plane: Math.round(plane) } : {}),
    };

    // A member who opted out keeps their presence but stores no position, so
    // an old tile cannot resurface if they share again later.
    const current = await this.prisma.member.findUnique({
      where: { id: member.id },
      select: { shareLocation: true },
    });
    if (current && !current.shareLocation) {
      await this.prisma.member.update({
        where: { id: member.id },
        data: { online: true, inLobby: false, lastUpdated: now },
        select: { id: true },
      });
      this.notifyChanged(group.id);
      return {
        ok: true,
        name,
        online: true,
        coordinates: [],
        share_location: false,
        updated_at: now.toISOString(),
      };
    }

    // Single write; the returned row gives us the (possibly unchanged) plane.
    // A position proves they are in game, so the lobby flag clears itself.
    const updated = await this.prisma.member.update({
      where: { id: member.id },
      data: {
        ...rounded,
        online: true,
        inLobby: false,
        lastUpdated: now,
      },
      select: { plane: true },
    });

    this.notifyChanged(group.id);
    return {
      ok: true,
      name,
      online: true,
      coordinates: [rounded.x, rounded.y, updated.plane],
      share_location: true,
      updated_at: now.toISOString(),
    };
  }

  /**
   * Kills a member has made since their last report, added to the running
   * totals. Counts are deltas, not absolutes, so a client that reconnects
   * mid-session cannot reset anyone's tally by sending a smaller number.
   */
  async reportKills(
    groupName: string,
    token: string | undefined,
    body: ReportKillsBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    // Fold repeats so one name is written once per request.
    const byName = new Map<string, number>();
    for (const entry of body.kills) {
      const npc = entry.npc?.trim();
      const kills = Math.round(entry.kills);
      if (!npc || kills <= 0) continue;
      byName.set(npc, (byName.get(npc) ?? 0) + kills);
    }
    if (byName.size === 0) {
      return { ok: true, name, recorded: 0, total: 0 };
    }

    const now = new Date();
    let recorded = 0;
    const total = await this.prisma.$transaction(async (tx) => {
      for (const [npcName, kills] of byName) {
        recorded += kills;
        await tx.memberNpcKill.upsert({
          where: { memberId_npcName: { memberId: member.id, npcName } },
          update: { kills: { increment: kills }, lastAt: now },
          create: { memberId: member.id, npcName, kills, lastAt: now },
        });
      }
      const updated = await tx.member.update({
        where: { id: member.id },
        data: { npcKillsTotal: { increment: recorded }, lastUpdated: now },
        select: { npcKillsTotal: true },
      });
      return updated.npcKillsTotal;
    });

    this.notifyChanged(group.id);
    return { ok: true, name, recorded, total };
  }

  /** Every member's kill counts, biggest first. */
  async getNpcKills(groupName: string, token: string | undefined) {
    const group = await this.access.read(groupName, token);
    requireShare(group, 'achievements');
    const members = group.members.filter((m) => m.name !== SHARED_MEMBER);
    const rows = members.length
      ? await this.prisma.memberNpcKill.findMany({
          where: { memberId: { in: members.map((m) => m.id) } },
          select: { memberId: true, npcName: true, kills: true, lastAt: true },
          orderBy: { kills: 'desc' },
        })
      : [];

    const byMember = new Map<
      string,
      Array<{ npc: string; kills: number; last_at: string }>
    >();
    for (const row of rows) {
      const entry = {
        npc: row.npcName,
        kills: row.kills,
        last_at: row.lastAt.toISOString(),
      };
      const list = byMember.get(row.memberId);
      if (list) list.push(entry);
      else byMember.set(row.memberId, [entry]);
    }

    return {
      members: members.map((m) => {
        const kills = byMember.get(m.id) ?? [];
        return {
          name: m.name,
          total: kills.reduce((sum, k) => sum + k.kills, 0),
          kills,
        };
      }),
    };
  }

  /** What a member is fighting, or nothing when the fight is over. */
  async setTarget(
    groupName: string,
    token: string | undefined,
    body: SetTargetBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = body.name?.trim();
    if (!name || name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const target = body.target?.trim();
    const now = new Date();
    const result = await this.prisma.member.updateMany({
      where: { id: member.id, groupId: group.id },
      data: target
        ? {
            targetName: target,
            targetHp: body.hp ?? null,
            targetPercent: body.percent ?? null,
            targetAt: now,
            lastUpdated: now,
          }
        : {
            targetName: null,
            targetHp: null,
            targetPercent: null,
            targetAt: null,
            lastUpdated: now,
          },
    });
    if (result.count === 0) throw new NotFoundException('Member not found');

    this.notifyChanged(group.id);
    return { ok: true, name, target: target ?? null, updated_at: now.toISOString() };
  }

  /** Opt a member in or out of the live map without changing presence. */
  async setLocationSharing(
    groupName: string,
    token: string | undefined,
    body: SetLocationSharingBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = body.name?.trim();
    if (!name || name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const shared = Boolean(body.shared);
    const now = new Date();
    // Opting out clears the stored tile outright; hiding it only at the wire
    // would leave the last known position sitting in the database.
    const result = await this.prisma.member.updateMany({
      where: { id: member.id, groupId: group.id },
      data: {
        shareLocation: shared,
        lastUpdated: now,
        ...(shared ? {} : { x: 0, y: 0, plane: 0 }),
      },
    });
    if (result.count === 0) throw new NotFoundException('Member not found');

    this.notifyChanged(group.id);
    return {
      ok: true,
      name,
      share_location: shared,
      updated_at: now.toISOString(),
    };
  }

  /**
   * The plugin reports the ruleset it read from the account rather than the
   * group picking one by hand. Writes nothing when it already matches, so a
   * login by every member does not churn the row or wake every viewer.
   */
  async syncGroupMode(
    groupName: string,
    token: string | undefined,
    body: SyncGroupModeBody,
  ) {
    const group = await this.access.write(groupName, token);
    const mode = parseGroupMode(body.mode);

    if (group.mode === mode) {
      return { ok: true, mode, changed: false };
    }

    await this.prisma.group.update({
      where: { id: group.id },
      data: { mode },
    });

    this.notifyChanged(group.id);
    return { ok: true, mode, changed: true };
  }

  async setMemberOnline(
    groupName: string,
    token: string | undefined,
    body: SetMemberOnlineBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = body.name?.trim();
    if (!name || name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const online = Boolean(body.online);
    // Going offline cannot leave the lobby flag set, or a closed client would
    // read as "in lobby" forever.
    const inLobby = online && Boolean(body.in_lobby);
    const now = new Date();
    const result = await this.prisma.member.updateMany({
      where: { id: member.id, groupId: group.id },
      data: {
        online,
        inLobby,
        lastUpdated: now,
      },
    });
    if (result.count === 0) throw new NotFoundException('Member not found');

    this.notifyChanged(group.id);
    return {
      ok: true,
      name,
      online,
      in_lobby: inLobby,
      updated_at: now.toISOString(),
    };
  }

  async addGroupMember(
    groupName: string,
    token: string | undefined,
    body: AddMemberBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = validateDisplayName(body.name, 'Player username');
    if (name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    if (findMemberRef(group.members, name)) {
      throw new ConflictException('Member already exists');
    }
    if (playableCount(group.members) >= group.memberSlots) {
      throw new ConflictException(
        `Group is full (${group.memberSlots} players)`,
      );
    }

    const nickname = normalizeNickname(body.nickname);
    const discordId = normalizeDiscordId(body.discord_id);
    const color = normalizeColor(body.color);
    const useDiscordAvatar = normalizeUseDiscordAvatar(body.use_discord_avatar);

    await this.prisma.member.create({
      data: {
        groupId: group.id,
        name,
        nickname,
        discordId,
        color,
        useDiscordAvatar,
        ...statsFromArray(DEFAULT_STATS),
        ...coordsFromArray(DEFAULT_COORDS),
      },
      select: { id: true },
    });

    this.notifyChanged(group.id, 'settings');
    return {
      ok: true,
      name,
      nickname,
      discord_id: discordId,
      color,
      use_discord_avatar: useDiscordAvatar,
    };
  }

  async updateMemberProfile(
    groupName: string,
    token: string | undefined,
    body: UpdateMemberProfileBody,
  ) {
    const group = await this.access.write(groupName, token);
    const name = body.name?.trim();
    if (!name || name === SHARED_MEMBER) {
      throw new BadRequestException('Invalid member name');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');

    const data: {
      nickname?: string | null;
      discordId?: string | null;
      color?: string | null;
      useDiscordAvatar?: boolean;
    } = {};
    // `!== undefined` (not `in`): the DTO class instance always owns these keys.
    if (body.nickname !== undefined) {
      data.nickname = normalizeNickname(body.nickname);
    }
    if (body.discord_id !== undefined) {
      data.discordId = normalizeDiscordId(body.discord_id);
    }
    if (body.color !== undefined) data.color = normalizeColor(body.color);
    if (body.use_discord_avatar !== undefined) {
      data.useDiscordAvatar = normalizeUseDiscordAvatar(
        body.use_discord_avatar,
      );
    }

    // The updated row already holds the untouched fields for the response.
    const updated = await this.prisma.member.update({
      where: { id: member.id },
      // Bump lastUpdated so delta pollers (from_time) pick up the change.
      data: { ...data, lastUpdated: new Date() },
      select: {
        nickname: true,
        discordId: true,
        color: true,
        useDiscordAvatar: true,
      },
    });

    this.notifyChanged(group.id, 'settings');
    return {
      ok: true,
      name,
      nickname: updated.nickname,
      discord_id: updated.discordId,
      color: updated.color,
      use_discord_avatar: updated.useDiscordAvatar,
    };
  }

  async updateGroupSettings(
    groupName: string,
    token: string | undefined,
    body: UpdateGroupSettingsBody,
  ) {
    const group = await this.access.write(groupName, token);
    const data: {
      appearance?: AppearanceTheme;
      mode?: GroupMode;
      name?: string;
      nameKey?: string;
      visibility?: GroupVisibility;
      publicMap?: boolean;
      publicSkills?: boolean;
      publicItems?: boolean;
      publicQuests?: boolean;
      publicAchievements?: boolean;
    } = { ...sharesPatch(body.shares) };
    if (body.appearance) data.appearance = parseAppearance(body.appearance);
    if (body.visibility) data.visibility = parseVisibility(body.visibility);

    if (body.name !== undefined) {
      const nextName = validateGroupName(body.name);
      if (nextName !== group.name) {
        // Case-only renames are allowed (same nameKey, same row).
        const taken = await this.access.findGroup(nextName);
        if (taken && taken.id !== group.id) {
          throw new ConflictException('Group name already taken');
        }
        data.name = nextName;
        data.nameKey = groupNameKey(nextName);
      }
    }

    let updated: {
      name: string;
      token: string;
      mode: GroupMode;
      appearance: AppearanceTheme;
      memberSlots: number;
      visibility: GroupVisibility;
      publicMap: boolean;
      publicSkills: boolean;
      publicItems: boolean;
      publicQuests: boolean;
      publicAchievements: boolean;
    };
    try {
      updated = await this.prisma.group.update({
        where: { id: group.id },
        data,
        select: {
          name: true,
          token: true,
          mode: true,
          appearance: true,
          memberSlots: true,
          visibility: true,
          publicMap: true,
          publicSkills: true,
          publicItems: true,
          publicQuests: true,
          publicAchievements: true,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Group name already taken');
      }
      throw err;
    }

    this.notifyChanged(group.id, 'settings');
    return {
      ok: true,
      name: updated.name,
      token: updated.token,
      mode: updated.mode,
      appearance: updated.appearance,
      member_slots: updated.memberSlots,
      visibility: updated.visibility,
      shares: sharesScope(updated),
    };
  }

  async findPublicGroups(queryRaw?: string, limitRaw?: string) {
    const query = parseSearchQuery(queryRaw);
    const limit = parsePublicGroupsLimit(limitRaw);

    const rows = await this.prisma.group.findMany({
      where: {
        visibility: GroupVisibility.public,
        ...(query ? { nameKey: { contains: query } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        name: true,
        mode: true,
        createdAt: true,
        memberSlots: true,
        viewsTotal: true,
        publicMap: true,
        publicSkills: true,
        publicItems: true,
        publicQuests: true,
        publicAchievements: true,
        members: { select: { name: true } },
      },
    });

    return {
      groups: rows.map((row) => ({
        name: row.name,
        mode: row.mode,
        views: row.viewsTotal,
        member_count: playableCount(row.members),
        member_slots: row.memberSlots,
        member_names: row.members
          .filter((m) => m.name !== SHARED_MEMBER)
          .map((m) => m.name)
          .sort(),
        shares: sharesScope(row),
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  async recordGroupView(groupName: string, token: string | undefined) {
    const group = await this.access.readWithoutMembers(groupName, token);
    if (token || !isPublicGroup(group)) {
      return { ok: true, counted: false };
    }

    const day = startOfUtcDay(new Date());
    await this.prisma.$transaction([
      this.prisma.groupViewDay.upsert({
        where: { groupId_day: { groupId: group.id, day } },
        create: { groupId: group.id, day, views: 1 },
        update: { views: { increment: 1 } },
      }),
      this.prisma.group.update({
        where: { id: group.id },
        data: { viewsTotal: { increment: 1 } },
      }),
    ]);

    return { ok: true, counted: true };
  }

  async getLeaderboard(
    metricRaw?: string,
    periodRaw?: string,
    limitRaw?: string,
  ) {
    const metric = parseLeaderboardMetric(metricRaw);
    const period = parseLeaderboardPeriod(periodRaw);
    const limit = parseLeaderboardLimit(limitRaw);
    const since = periodStart(period);

    const rows = await this.prisma.$queryRaw<LeaderboardRow[]>(
      leaderboardQuery(metric, since, limit),
    );

    return {
      metric,
      period,
      entries: toLeaderboardEntries(rows),
    };
  }

  async deleteGroupMember(
    groupName: string,
    token: string | undefined,
    body: { name: string },
  ) {
    const group = await this.access.write(groupName, token);
    const name = body.name?.trim();
    if (!name || name === SHARED_MEMBER) {
      throw new BadRequestException('Cannot delete shared bank member');
    }
    const member = findMemberRef(group.members, name);
    if (!member) throw new NotFoundException('Member not found');
    if (playableCount(group.members) <= MIN_MEMBERS) {
      throw new ConflictException(
        `Groups must keep at least ${MIN_MEMBERS} players`,
      );
    }
    const result = await this.prisma.member.deleteMany({
      where: { id: member.id, groupId: group.id },
    });
    if (result.count === 0) throw new NotFoundException('Member not found');
    this.notifyChanged(group.id, 'settings');
    return { ok: true };
  }

  async renameGroupMember(
    groupName: string,
    token: string | undefined,
    body: RenameMemberBody,
  ) {
    const group = await this.access.write(groupName, token);
    const original = body.original_name?.trim();
    const next = validateDisplayName(body.new_name, 'Player username');
    if (!original || original === SHARED_MEMBER || next === SHARED_MEMBER) {
      throw new BadRequestException('Invalid rename');
    }
    const member = findMemberRef(group.members, original);
    if (!member) throw new NotFoundException('Member not found');
    const clash = findMemberRef(group.members, next);
    if (clash && clash.id !== member.id) {
      throw new ConflictException('Name already taken');
    }
    await this.prisma.member.update({
      where: { id: member.id },
      data: { name: next, lastUpdated: new Date() },
      select: { id: true },
    });
    this.notifyChanged(group.id, 'settings');
    return { ok: true, name: next };
  }

  /** Current contents of a member inventory as wire pairs (empty if absent). */
  private async memberInventoryPairs(
    db: DbClient,
    memberId: string,
    key: string,
  ) {
    const rows = await db.memberInventoryItem.findMany({
      where: { inventory: { memberId, key } },
      select: { slot: true, itemId: true, quantity: true },
    });
    return rowsToPairs(rows);
  }

  /** Current contents of a group inventory as wire pairs (empty if absent). */
  private async groupInventoryPairs(
    db: DbClient,
    groupId: string,
    key: string,
  ) {
    const rows = await db.groupInventoryItem.findMany({
      where: { inventory: { groupId, key } },
      select: { slot: true, itemId: true, quantity: true },
    });
    return rowsToPairs(rows);
  }

  /**
   * Replace a member inventory wholesale. The inventory row is created on
   * first sight and stamped on every write, so `updatedAt` says when the
   * plugin last reported it.
   */
  private async replaceMemberInventory(
    db: DbClient,
    memberId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    const rows = pairsToRows(pairs, key);
    const contentHash = inventoryContentHash(rows);

    const current = await db.memberInventory.findUnique({
      where: { memberId_key: { memberId, key } },
      select: { contentHash: true },
    });
    // The plugin resends the whole bank every sync even when nothing changed.
    // Bailing out here turns ~8000 row operations into one indexed read.
    if (current?.contentHash === contentHash) return false;

    const inventory = await db.memberInventory.upsert({
      where: { memberId_key: { memberId, key } },
      create: { memberId, key, updatedAt: now, contentHash },
      update: { updatedAt: now, contentHash },
      select: { id: true },
    });
    await db.memberInventoryItem.deleteMany({
      where: { inventoryId: inventory.id },
    });
    if (rows.length) {
      await db.memberInventoryItem.createMany({
        data: rows.map((item) => ({ ...item, inventoryId: inventory.id })),
      });
    }
    return true;
  }

  /** Same as replaceMemberInventory, for group-owned inventories. */
  private async replaceGroupInventory(
    db: DbClient,
    groupId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    const rows = pairsToRows(pairs, key);
    const contentHash = inventoryContentHash(rows);

    const current = await db.groupInventory.findUnique({
      where: { groupId_key: { groupId, key } },
      select: { contentHash: true },
    });
    // Skipping also leaves updatedAt alone, which keeps an unchanged shared
    // bank out of every get-group-data delta — not just out of the database.
    if (current?.contentHash === contentHash) return false;

    const inventory = await db.groupInventory.upsert({
      where: { groupId_key: { groupId, key } },
      create: { groupId, key, updatedAt: now, contentHash },
      update: { updatedAt: now, contentHash },
      select: { id: true },
    });
    await db.groupInventoryItem.deleteMany({
      where: { inventoryId: inventory.id },
    });
    if (rows.length) {
      await db.groupInventoryItem.createMany({
        data: rows.map((item) => ({ ...item, inventoryId: inventory.id })),
      });
    }
    return true;
  }

  /**
   * Plugin skill sync. Replaces the member's skill rows and, by diffing the
   * previous snapshot against the incoming one, records level/XP milestone
   * achievements. The previous snapshot is one indexed read; achievements are
   * a single `skipDuplicates` insert only when something actually crossed.
   */
  private async replaceSkills(
    db: DbClient,
    groupId: string,
    memberId: string,
    memberName: string,
    skills: Record<string, SkillPayloadValue>,
    sampledAt: Date,
    recordAchievements = true,
  ): Promise<{ changed: boolean; posted: boolean }> {
    // Read BEFORE writing so milestone crossings can be diffed.
    const previous = await db.memberSkill.findMany({
      where: { memberId },
      select: { skillId: true, xp: true, level: true, baseLevel: true },
    });

    // Merge, never replace: the plugin sends only the skills that changed
    // (all of them on login), so a partial map must leave the rest alone.
    const rows = normalizeSeedSkills(skills).map((skill) => ({
      ...skill,
      memberId,
    }));
    const changed = skillsDiffer(previous, rows);
    let posted = false;
    if (rows.length) {
      if (changed) {
        await db.memberSkill.deleteMany({
          where: { memberId, skillId: { in: rows.map((r) => r.skillId) } },
        });
        await db.memberSkill.createMany({ data: rows });
      }
      await this.xpHistory.recordXpSamples(
        memberId,
        rows.map((r) => ({ skillId: r.skillId, xp: r.xp })),
        sampledAt,
        db,
      );

      const milestones = recordAchievements
        ? detectSkillMilestones(memberName, previous, rows)
        : [];
      posted = milestones.length > 0;
      if (milestones.length) {
        await db.achievement.createMany({
          data: milestones.map((m) => ({
            groupId,
            memberName: m.memberName,
            kind: AchievementKind.level,
            title: m.title,
            detail: m.detail,
            skillId: m.skillId,
            dedupeKey: m.dedupeKey,
            achievedAt: sampledAt,
          })),
          // Repeated syncs re-detect nothing, but a concurrent sync might.
          skipDuplicates: true,
        });
      }
    }
    return { changed, posted };
  }
}
