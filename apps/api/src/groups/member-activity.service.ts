import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { groupBy } from '../common/group-by';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService, requireShare } from './group-access.service';
import { GroupChangeNotifier } from './group-change-notifier.service';
import {
  findMemberRef,
  parseGroupMode,
  validateDisplayName,
} from './group-fields';
import {
  type PlayerMovedBody,
  type ReportKillsBody,
  SHARED_MEMBER,
  type SetLocationSharingBody,
  type SetMemberOnlineBody,
  type SetTargetBody,
  type SyncGroupModeBody,
} from './group.types';

@Injectable()
export class MemberActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly notifier: GroupChangeNotifier,
  ) {}

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
      this.notifier.notify(group.id);
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

    this.notifier.notify(group.id);
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

    this.notifier.notify(group.id);
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

    const byMember = groupBy(
      rows,
      (row) => row.memberId,
      (row) => ({
        npc: row.npcName,
        kills: row.kills,
        last_at: row.lastAt.toISOString(),
      }),
    );

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

    this.notifier.notify(group.id);
    return {
      ok: true,
      name,
      target: target ?? null,
      updated_at: now.toISOString(),
    };
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

    this.notifier.notify(group.id);
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

    this.notifier.notify(group.id);
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

    this.notifier.notify(group.id);
    return {
      ok: true,
      name,
      online,
      in_lobby: inLobby,
      updated_at: now.toISOString(),
    };
  }
}
