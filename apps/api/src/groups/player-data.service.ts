import { Injectable } from '@nestjs/common';
import type { Writable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { ZipWriter } from '../common/zip';
import { GroupExportService } from './group-export.service';
import { rowsToPairs } from './item-codec';

export const PLAYER_DATA_PAGE = 2000;

@Injectable()
export class PlayerDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groupExport: GroupExportService,
  ) {}

  async buildDocument(playerId: string) {
    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
      include: { usernameHistory: true },
    });

    const members = await this.prisma.member.findMany({
      where: { playerId },
      include: {
        group: { select: { id: true, name: true } },
        skills: { orderBy: { skillId: 'asc' } },
        inventories: { include: { items: true }, orderBy: { key: 'asc' } },
        quests: { orderBy: { gameval: 'asc' } },
        completedAchievements: { orderBy: { gameval: 'asc' } },
        achievementTallies: { orderBy: { gameval: 'asc' } },
        npcKills: { orderBy: { kills: 'desc' } },
      },
    });

    const matchedUsernames = [
      ...new Set([
        player.currentUsername,
        ...player.usernameHistory.map((h) => h.username),
      ]),
    ];
    const groupIds = [...new Set(members.map((m) => m.groupId))];
    const memberIds = members.map((m) => m.id);

    const [ledger, feed, xpSamples] = await Promise.all([
      groupIds.length
        ? this.prisma.sharedBankEntry.findMany({
            where: {
              groupId: { in: groupIds },
              memberName: { in: matchedUsernames, mode: 'insensitive' },
            },
            orderBy: { createdAt: 'desc' },
            take: PLAYER_DATA_PAGE,
          })
        : Promise.resolve([]),
      groupIds.length
        ? this.prisma.achievement.findMany({
            where: {
              groupId: { in: groupIds },
              memberName: { in: matchedUsernames, mode: 'insensitive' },
            },
            orderBy: { achievedAt: 'desc' },
            take: PLAYER_DATA_PAGE,
          })
        : Promise.resolve([]),
      memberIds.length
        ? this.prisma.skillXpSample.findMany({
            where: { memberId: { in: memberIds } },
            orderBy: { sampledAt: 'desc' },
            take: PLAYER_DATA_PAGE,
          })
        : Promise.resolve([]),
    ]);

    return {
      export_version: 1,
      generated_at: new Date().toISOString(),
      row_cap: PLAYER_DATA_PAGE,
      matched_usernames: matchedUsernames,
      player: {
        id: player.id,
        current_username: player.currentUsername,
        verification_status: player.verificationStatus,
        verified_at: player.verifiedAt?.toISOString() ?? null,
        created_at: player.createdAt.toISOString(),
      },
      memberships: members.map((m) => ({
        group: m.group.name,
        skills: m.skills.map((s) => ({
          id: s.skillId,
          xp: s.xp.toString(),
          level: s.level,
          base_level: s.baseLevel,
        })),
        inventories: Object.fromEntries(
          m.inventories.map((inv) => [
            inv.key,
            {
              updated_at: inv.updatedAt.toISOString(),
              items: rowsToPairs(inv.items),
            },
          ]),
        ),
        quests: m.quests.map((q) => ({
          gameval: q.gameval,
          state: q.state,
          updated_at: q.updatedAt.toISOString(),
        })),
        achievements_completed: m.completedAchievements.map((a) => ({
          gameval: a.gameval,
          updated_at: a.updatedAt.toISOString(),
        })),
        achievements_in_progress: m.achievementTallies.map((t) => ({
          gameval: t.gameval,
          progress: t.progress,
          target: t.target,
          updated_at: t.updatedAt.toISOString(),
        })),
        npc_kills: m.npcKills.map((k) => ({
          npc: k.npcName,
          kills: k.kills,
          last_at: k.lastAt.toISOString(),
        })),
      })),
      bank_ledger: ledger.map((e) => ({
        at: e.createdAt.toISOString(),
        group_id: e.groupId,
        member_name: e.memberName,
        item_id: e.itemId,
        delta: e.delta,
      })),
      achievement_feed: feed.map((a) => ({
        at: a.achievedAt.toISOString(),
        group_id: a.groupId,
        member_name: a.memberName,
        kind: a.kind,
        title: a.title,
        detail: a.detail,
        skill_id: a.skillId,
        item_id: a.itemId,
        quantity: a.quantity,
        gameval: a.gameval,
        image_url: a.imageUrl,
      })),
      xp_samples: xpSamples.map((s) => ({
        member_id: s.memberId,
        skill_id: s.skillId,
        xp: s.xp.toString(),
        sampled_at: s.sampledAt.toISOString(),
      })),
    };
  }

  async writeExportArchive(out: Writable, playerId: string): Promise<void> {
    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
      include: { usernameHistory: true },
    });
    const members = await this.prisma.member.findMany({
      where: { playerId },
      include: { group: { select: { name: true } } },
    });
    const usernames = [
      ...new Set([
        player.currentUsername,
        ...player.usernameHistory.map((h) => h.username),
      ]),
    ];

    const zip = new ZipWriter(out);
    const at = new Date();
    const seenDirs = new Set<string>();

    for (const member of members) {
      const filter = { memberId: member.id, usernames };
      const state = await this.groupExport.buildStateDocument(
        member.group.name,
        filter,
      );
      if (!state) continue;

      await this.groupExport.writeGroupEntries(
        zip,
        member.group.name,
        state,
        at,
        {
          filter,
          pathPrefix: `${uniqueDirName(member.group.name, seenDirs)}/`,
          scope: 'player',
        },
      );
    }

    await zip.finish();
  }
}

function uniqueDirName(groupName: string, seen: Set<string>): string {
  const safe =
    groupName
      .trim()
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/^\.+/, '_') || 'group';

  let candidate = safe;
  let n = 2;
  while (seen.has(candidate.toLowerCase())) {
    candidate = `${safe}-${n}`;
    n += 1;
  }
  seen.add(candidate.toLowerCase());
  return candidate;
}
