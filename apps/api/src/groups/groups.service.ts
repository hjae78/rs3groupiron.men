import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppearanceTheme,
  GroupMode,
  GroupVisibility,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { groupBy } from '../common/group-by';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ledgerDateWindow,
  parseLedgerCursor,
  parseLedgerLimit,
} from './bank-ledger';
import {
  GroupChangeNotifier,
  type GroupChangeKind,
} from './group-change-notifier.service';
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
  parsePublicGroupsLimit,
  parseSearchQuery,
  parseVisibility,
  playableCount,
  sharesPatch,
  sharesToColumns,
  validateDisplayName,
  verifiedCount,
  validateGroupName,
  validateInventoriesPayload,
  validateSkillsPayload,
} from './group-fields';
import {
  AddMemberBody,
  ConfirmGroupDeletionBody,
  CreateGroupBody,
  MAX_MEMBERS,
  MIN_MEMBERS,
  RenameMemberBody,
  SHARED_MEMBER,
  UpdateGroupSettingsBody,
  UpdateMemberBody,
  UpdateMemberProfileBody,
} from './group.types';
import {
  WIRE_INVENTORIES,
  coordsFromArray,
  diffItemTotals,
  mergeItemPairs,
  statsFromArray,
} from './item-codec';
import { InventoryStorageService } from './inventory-storage.service';
import { hashTrackingId } from './player-verification';
import { PlayerVerificationService } from './player-verification.service';
import { type DbClient, XpHistoryService } from './xp-history.service';

const DEFAULT_STATS = [10, 10, 1, 1, 1, 1, 1];
const DEFAULT_COORDS = [3200, 3200, 0];

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
    private readonly verification: PlayerVerificationService,
    private readonly notifier: GroupChangeNotifier,
    private readonly inventoryStorage: InventoryStorageService,
  ) {}

  /**
   * Wakes any SSE subscribers for the group; a no-op when nobody is watching.
   *
   * The kinds say which of the separately-fetched endpoints a client should
   * re-read. Member state travels in the delta itself, so that is the default
   * and costs a client nothing extra.
   */
  notifyChanged(groupId: string, ...kinds: GroupChangeKind[]) {
    this.notifier.notify(groupId, ...kinds);
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
              player: {
                create: {
                  currentUsername: memberName,
                  usernameKey: memberName.toLowerCase(),
                  usernameHistory: { create: { username: memberName } },
                },
              },
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

  async amILoggedIn(
    groupName: string,
    token: string | undefined,
    memberName?: string,
    trackingId?: string,
  ) {
    const group = await this.access.read(groupName, token);

    let verified: boolean | undefined;
    if (memberName) {
      const member = findMemberRef(group.members, memberName);
      if (member) {
        const full = await this.prisma.member.findUnique({
          where: { id: member.id },
          select: {
            playerId: true,
            player: { select: { verificationStatus: true, usernameKey: true } },
          },
        });
        verified = full?.player?.verificationStatus === 'plugin_verified';
        if (!verified && trackingId && full?.playerId && full.player) {
          verified = await this.verification.tryAutoVerify(
            member.id,
            full.playerId,
            full.player.usernameKey,
            trackingId,
          );
        }
      }
    }

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
      ...(memberName ? { member_verified: verified === true } : {}),
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

    const identity = await this.prisma.member.findUnique({
      where: { id: existing.id },
      select: { player: { select: { trackingIdHash: true } } },
    });
    const knownTrackingIdHash = identity?.player?.trackingIdHash;
    if (knownTrackingIdHash) {
      const providedHash = body.tracking_id
        ? hashTrackingId(body.tracking_id)
        : null;
      if (providedHash !== knownTrackingIdHash) {
        throw new ForbiddenException(
          "Tracking id does not match this member's verified identity",
        );
      }
    }

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
        await tx.$executeRaw`UPDATE "members" SET "last_updated" = GREATEST("last_updated", ${now}) WHERE id = ${memberId}`;

        // Only true once a write below reports a real change.
        let heavyChanged = false;

        // Named wire fields first, then the generic map. A key present in
        // both is written twice and the generic one wins, which is harmless.
        if (body.inventory) {
          const changed = await this.inventoryStorage.replaceMemberInventory(
            tx,
            memberId,
            WIRE_INVENTORIES.inventory,
            body.inventory,
            now,
          );
          heavyChanged ||= changed;
        }
        if (body.equipment) {
          const changed = await this.inventoryStorage.replaceMemberInventory(
            tx,
            memberId,
            WIRE_INVENTORIES.equipment,
            body.equipment,
            now,
          );
          heavyChanged ||= changed;
        }

        // Compute the final bank once: full bank (+ deposits) or current + deposits.
        let finalBank: number[] | undefined;
        if (body.bank && hasDeposit) {
          finalBank = mergeItemPairs(body.bank, body.deposited!);
        } else if (body.bank) {
          finalBank = body.bank;
        } else if (hasDeposit) {
          const currentBank = await this.inventoryStorage.memberInventoryPairs(
            tx,
            memberId,
            WIRE_INVENTORIES.bank,
          );
          finalBank = mergeItemPairs(currentBank, body.deposited!);
        }
        if (finalBank) {
          const changed = await this.inventoryStorage.replaceMemberInventory(
            tx,
            memberId,
            WIRE_INVENTORIES.bank,
            finalBank,
            now,
          );
          heavyChanged ||= changed;
        }

        if (inventories) {
          for (const [key, pairs] of Object.entries(inventories)) {
            const changed = await this.inventoryStorage.replaceMemberInventory(
              tx,
              memberId,
              key,
              pairs,
              now,
            );
            heavyChanged ||= changed;
          }
        }

        if (skills) {
          const result = await this.inventoryStorage.replaceSkills(
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
          const previousShared = await this.inventoryStorage.groupInventoryPairs(
            tx,
            group.id,
            WIRE_INVENTORIES.bank,
          );
          await this.inventoryStorage.replaceGroupInventory(
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
              const movements = await this.inventoryStorage.applyGroupInventoryChanges(
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
            const changed = await this.inventoryStorage.applyMemberInventoryChanges(
              tx,
              memberId,
              key,
              pairs,
              now,
            );
            heavyChanged ||= changed;
          }
        }

        // One extra single-row update when the heavy payload really moved, in
        // exchange for not making every viewer of this group re-download the
        // member's bank after a no-op resend. Guarded by mayTouchHeavyData so a
        // position-only ping still cannot reach it.
        if (mayTouchHeavyData && heavyChanged) {
          await tx.$executeRaw`UPDATE "members" SET "data_updated_at" = GREATEST("data_updated_at", ${now}) WHERE id = ${memberId}`;
        }
        dataChanged = heavyChanged;
      },
      { maxWait: 5_000, timeout: 20_000 },
    );

    if (postedAchievements)
      this.notifyChanged(group.id, 'members', 'achievements');
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

    await this.prisma.$transaction(async (tx) => {
      const player = await tx.player.create({
        data: {
          currentUsername: name,
          usernameKey: name.toLowerCase(),
          usernameHistory: { create: { username: name } },
        },
        select: { id: true },
      });

      await tx.member.create({
        data: {
          groupId: group.id,
          name,
          nickname,
          discordId,
          color,
          useDiscordAvatar,
          ...statsFromArray(DEFAULT_STATS),
          ...coordsFromArray(DEFAULT_COORDS),
          playerId: player.id,
        },
        select: { id: true },
      });
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
        members: {
          select: {
            name: true,
            player: { select: { verificationStatus: true } },
          },
        },
      },
    });

    return {
      groups: rows.map((row) => ({
        name: row.name,
        mode: row.mode,
        views: row.viewsTotal,
        member_count: playableCount(row.members),
        verified_count: verifiedCount(row.members),
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
}
