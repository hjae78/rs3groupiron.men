import { Injectable } from '@nestjs/common';
import { AchievementKind } from '@prisma/client';
import { detectSkillMilestones } from './achievements';
import type { SkillPayloadValue } from './group.types';
import {
  inventoryContentHash,
  pairsToRows,
  rowsToPairs,
} from './item-codec';
import { planItemChanges } from './item-changes';
import { normalizeSeedSkills } from './skill-codec';
import { type DbClient, XpHistoryService } from './xp-history.service';

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

type InventoryOwnerKind = 'member' | 'group';

/**
 * The only real difference between a member- and group-owned inventory: which
 * Prisma delegate to use and which field names its own-side owner key.
 *
 * The delegates differ by model, so Prisma's generated types can't express
 * "either one" without a cast — contained to the three generic methods below,
 * which is the trade cheaper than keeping the member/group pairs duplicated.
 */
function ownerDelegates(kind: InventoryOwnerKind, db: DbClient) {
  return kind === 'member'
    ? {
        inventory: db.memberInventory as any,
        items: db.memberInventoryItem as any,
        ownerField: 'memberId' as const,
      }
    : {
        inventory: db.groupInventory as any,
        items: db.groupInventoryItem as any,
        ownerField: 'groupId' as const,
      };
}

@Injectable()
export class InventoryStorageService {
  constructor(private readonly xpHistory: XpHistoryService) {}

  private async inventoryPairs(
    kind: InventoryOwnerKind,
    db: DbClient,
    ownerId: string,
    key: string,
  ) {
    const { items, ownerField } = ownerDelegates(kind, db);
    const rows = await items.findMany({
      where: { inventory: { [ownerField]: ownerId, key } },
      select: { slot: true, itemId: true, quantity: true },
    });
    return rowsToPairs(rows);
  }

  /**
   * Replace an inventory wholesale. The inventory row is created on first
   * sight and stamped on every write, so `updatedAt` says when the plugin
   * last reported it.
   */
  private async replaceInventory(
    kind: InventoryOwnerKind,
    db: DbClient,
    ownerId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    const { inventory, items, ownerField } = ownerDelegates(kind, db);
    const rows = pairsToRows(pairs, key);
    const contentHash = inventoryContentHash(rows);
    const uniqueWhere = { [`${ownerField}_key`]: { [ownerField]: ownerId, key } };

    const current = await inventory.findUnique({
      where: uniqueWhere,
      select: { contentHash: true },
    });
    // The plugin resends the whole inventory every sync even when nothing
    // changed. Bailing out here turns ~8000 row operations into one indexed
    // read, and for a group inventory also leaves updatedAt alone, which
    // keeps an unchanged shared bank out of every get-group-data delta too.
    if (current?.contentHash === contentHash) return false;

    const row = await inventory.upsert({
      where: uniqueWhere,
      create: { [ownerField]: ownerId, key, updatedAt: now, contentHash },
      update: { updatedAt: now, contentHash },
      select: { id: true },
    });
    await items.deleteMany({ where: { inventoryId: row.id } });
    if (rows.length) {
      await items.createMany({
        data: rows.map((item) => ({ ...item, inventoryId: row.id })),
      });
    }
    return true;
  }

  /** Apply [itemId, newTotal, ...] to an inventory, returning what changed. */
  private async applyInventoryChanges(
    kind: InventoryOwnerKind,
    db: DbClient,
    ownerId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<{ changed: boolean; movements: Array<{ itemId: number; delta: number }> }> {
    const { inventory, items, ownerField } = ownerDelegates(kind, db);
    const uniqueWhere = { [`${ownerField}_key`]: { [ownerField]: ownerId, key } };

    const row = await inventory.upsert({
      where: uniqueWhere,
      create: { [ownerField]: ownerId, key, updatedAt: now },
      update: {},
      select: { id: true },
    });
    const current = await items.findMany({
      where: { inventoryId: row.id },
      select: { slot: true, itemId: true, quantity: true },
    });
    const plan = planItemChanges(current, pairs);
    if (!plan.changed) return { changed: false, movements: [] };

    if (plan.deleteItemIds.length) {
      await items.deleteMany({
        where: { inventoryId: row.id, itemId: { in: plan.deleteItemIds } },
      });
    }
    if (plan.insert.length) {
      await items.createMany({
        data: plan.insert.map((r: unknown) => ({
          ...(r as object),
          inventoryId: row.id,
        })),
      });
    }
    await inventory.update({
      where: { id: row.id },
      data: { updatedAt: now, contentHash: inventoryContentHash(plan.rows) },
      select: { id: true },
    });
    return { changed: true, movements: plan.movements };
  }

  /** Current contents of a member inventory as wire pairs (empty if absent). */
  memberInventoryPairs(db: DbClient, memberId: string, key: string) {
    return this.inventoryPairs('member', db, memberId, key);
  }

  /** Current contents of a group inventory as wire pairs (empty if absent). */
  groupInventoryPairs(db: DbClient, groupId: string, key: string) {
    return this.inventoryPairs('group', db, groupId, key);
  }

  replaceMemberInventory(
    db: DbClient,
    memberId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    return this.replaceInventory('member', db, memberId, key, pairs, now);
  }

  /** Same as replaceMemberInventory, for group-owned inventories. */
  replaceGroupInventory(
    db: DbClient,
    groupId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    return this.replaceInventory('group', db, groupId, key, pairs, now);
  }

  async applyMemberInventoryChanges(
    db: DbClient,
    memberId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<boolean> {
    const { changed } = await this.applyInventoryChanges(
      'member',
      db,
      memberId,
      key,
      pairs,
      now,
    );
    return changed;
  }

  /** Same as above for a group-owned inventory; returns the ledger movements. */
  async applyGroupInventoryChanges(
    db: DbClient,
    groupId: string,
    key: string,
    pairs: number[],
    now: Date,
  ): Promise<Array<{ itemId: number; delta: number }>> {
    const { movements } = await this.applyInventoryChanges(
      'group',
      db,
      groupId,
      key,
      pairs,
      now,
    );
    return movements;
  }

  /**
   * Plugin skill sync. Replaces the member's skill rows and, by diffing the
   * previous snapshot against the incoming one, records level/XP milestone
   * achievements. The previous snapshot is one indexed read; achievements are
   * a single `skipDuplicates` insert only when something actually crossed.
   */
  async replaceSkills(
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
