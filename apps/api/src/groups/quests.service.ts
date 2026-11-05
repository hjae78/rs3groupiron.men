import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AchievementKind } from '@prisma/client';
import { gamevalDedupeKey } from '../gamevals/gamevals.catalog';
import { GamevalsService } from '../gamevals/gamevals.service';
import { QuestCatalogService } from '../gamevals/quest-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService, requireShare } from './group-access.service';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { findMemberRef, validateDisplayName } from './group-fields';
import { SHARED_MEMBER, type UpdateMemberQuestsBody } from './group.types';
import { planQuestUpdate, resolveQuestInputs } from './quests';

@Injectable()
export class GroupQuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly gamevals: GamevalsService,
    private readonly questCatalog: QuestCatalogService,
    private readonly notifier: GroupChangeNotifier,
  ) {}

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

    this.notifier.notify(group.id, 'quests', 'achievements');
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
}
