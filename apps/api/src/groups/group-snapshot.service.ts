import { Injectable } from '@nestjs/common';
import type { MemberInventory, MemberInventoryItem, MemberSkill } from '@prisma/client';
import { groupBy } from '../common/group-by';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import {
  redactWireEntries,
  toPartialWireMember,
  toSharedWireMember,
  toWireMember,
  type WireEntry,
} from './group-wire';
import { SHARED_MEMBER } from './group.types';

type InventoryWithItems = MemberInventory & { items: MemberInventoryItem[] };

/**
 * How long a full group payload may be reused. Deltas are never cached, so this
 * only bounds how stale a periodic re-sync can be, well inside the 1.5s poll
 * cadence it serves. 0 disables sharing.
 */
const SNAPSHOT_CACHE_MS = Number(process.env.SNAPSHOT_CACHE_MS ?? 1_000);

/** Groups held in the snapshot cache before expired entries are swept. */
const SNAPSHOT_CACHE_MAX = 256;

/** Builds and caches the SSE/poll "whole group" payload. */
@Injectable()
export class GroupSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
  ) {}

  /** Recent full payloads, shared between concurrent readers of a group. */
  private readonly snapshots = new Map<
    string,
    { at: number; payload: Promise<WireEntry[]> }
  >();

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
      include: { player: { select: { verificationStatus: true } } },
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

    const inventoriesByMember = groupBy(
      inventories,
      (inventory) => inventory.memberId,
    );
    const skillsByMember = groupBy(skills, (skill) => skill.memberId);

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
}
