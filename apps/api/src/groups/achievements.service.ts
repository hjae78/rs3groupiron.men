import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AchievementKind } from '@prisma/client';
import { groupBy } from '../common/group-by';
import {
  ACHIEVEMENT_KIND_TO_GAMEVAL,
  gamevalDedupeKey,
  isGamevalName,
} from '../gamevals/gamevals.catalog';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import { RareItemsService } from '../items/rare-items.service';
import { SKILL_BY_ID, type SkillId } from '../skills/skills.catalog';
import {
  parseAchievedAt,
  parseAchievementKind,
  parseAchievementLimit,
  parseAchievementMember,
  toAchievementEntry,
  validateImageUrl,
} from './achievements';
import {
  achievementTitle,
  isFeedWorthyAchievement,
  planAchievementUpdate,
  resolveAchievementRefs,
  resolveAchievementTallies,
} from './achievement-sync';
import { ledgerDateWindow, parseLedgerCursor } from './bank-ledger';
import { GroupAccessService, requireShare } from './group-access.service';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { findMemberRef, validateDisplayName } from './group-fields';
import {
  type CreateAchievementBody,
  type DropRulesBody,
  type ReportDropBody,
  SHARED_MEMBER,
  type UpdateMemberAchievementsBody,
} from './group.types';

@Injectable()
export class GroupAchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly gamevals: GamevalsService,
    private readonly rareItems: RareItemsService,
    private readonly notifier: GroupChangeNotifier,
  ) {}

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

    this.notifier.notify(group.id, 'achievements');
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
    const quantity =
      body.quantity && body.quantity > 1 ? Math.round(body.quantity) : 1;
    if (
      !(await this.dropCounts(
        group.id,
        group.dropThreshold,
        itemId,
        value,
        quantity,
      ))
    ) {
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

    this.notifier.notify(group.id, 'achievements');
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
    dropThreshold: number,
    itemId: number,
    value: number,
    quantity: number,
  ): Promise<boolean> {
    const override = await this.prisma.groupRareItem.findUnique({
      where: { groupId_itemId: { groupId, itemId } },
      select: { include: true, minQty: true, maxQty: true },
    });
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
    return dropThreshold > 0 && value >= dropThreshold;
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
        if (!ids.length) continue;
        const itemIds = [...new Set(ids.map(Math.round))];
        await tx.groupRareItem.createMany({
          data: itemIds.map((itemId) => ({
            groupId: group.id,
            itemId,
            include,
          })),
          skipDuplicates: true,
        });
        // A row switching lists keeps no window: a range set while the item
        // was tracked would silently narrow it again if it came back.
        await tx.groupRareItem.updateMany({
          where: { groupId: group.id, itemId: { in: itemIds } },
          data: { include, minQty: null, maxQty: null },
        });
      }

      // Ranges last, so one request can add an item and give it a window.
      // Later duplicates of the same item_id win, matching a sequential loop.
      const rangesByItem = new Map<
        number,
        { itemId: number; minQty: number | null; maxQty: number | null }
      >();
      for (const range of body.quantities ?? []) {
        const itemId = Math.round(range.item_id);
        const minQty = range.min == null ? null : Math.round(range.min);
        const maxQty = range.max == null ? null : Math.round(range.max);
        if (minQty != null && maxQty != null && minQty > maxQty) {
          throw new BadRequestException(
            `Minimum quantity is above the maximum for item ${itemId}`,
          );
        }
        rangesByItem.set(itemId, { itemId, minQty, maxQty });
      }

      if (rangesByItem.size) {
        const ranges = [...rangesByItem.values()];
        await tx.groupRareItem.createMany({
          data: ranges.map(({ itemId, minQty, maxQty }) => ({
            groupId: group.id,
            itemId,
            include: true,
            minQty,
            maxQty,
          })),
          skipDuplicates: true,
        });

        // Rows that already existed are untouched by the create above, so
        // batch the update by (min, max) window rather than one round trip
        // per range.
        const byWindow = groupBy(ranges, (r) => `${r.minQty}:${r.maxQty}`);
        for (const windowRanges of byWindow.values()) {
          const { minQty, maxQty } = windowRanges[0]!;
          await tx.groupRareItem.updateMany({
            where: {
              groupId: group.id,
              itemId: { in: windowRanges.map((r) => r.itemId) },
            },
            data: { minQty, maxQty },
          });
        }
      }
    });

    this.notifier.notify(group.id, 'settings');
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

    const byMember = groupBy(
      rows,
      (row) => row.memberId,
      (row) => row.gameval,
    );

    const talliesByMember = groupBy(
      tallyRows,
      (row) => row.memberId,
      (row) => ({
        gameval: row.gameval,
        progress: row.progress,
        target: row.target,
      }),
    );

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
    const tallies = resolveAchievementTallies(
      body.tallies ?? [],
      this.gamevals,
    );
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
          // Later duplicates of the same gameval win, matching a sequential loop.
          const talliesByGameval = new Map(tallies.map((t) => [t.gameval, t]));
          const dedupedTallies = [...talliesByGameval.values()];

          if (dedupedTallies.length) {
            await tx.memberAchievementTally.createMany({
              data: dedupedTallies.map((tally) => ({
                memberId: member.id,
                gameval: tally.gameval,
                progress: tally.progress,
                target: tally.target,
                updatedAt: now,
              })),
              skipDuplicates: true,
            });

            // Rows that already existed are untouched by the create above, so
            // batch the update by (progress, target) rather than one round
            // trip per tally.
            const byValue = groupBy(
              dedupedTallies,
              (t) => `${t.progress}:${t.target}`,
            );
            for (const valueTallies of byValue.values()) {
              const { progress, target } = valueTallies[0]!;
              await tx.memberAchievementTally.updateMany({
                where: {
                  memberId: member.id,
                  gameval: { in: valueTallies.map((t) => t.gameval) },
                },
                data: { progress, target, updatedAt: now },
              });
            }
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

    this.notifier.notify(group.id, 'achievements');
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
}
