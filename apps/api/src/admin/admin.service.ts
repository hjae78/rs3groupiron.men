import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GroupVisibility, Prisma } from '@prisma/client';
import { GroupChangeNotifier } from '../groups/group-change-notifier.service';
import { deletionDueAt, deletionStatus } from '../groups/group-deletion';
import { playableCount } from '../groups/group-fields';
import { GroupPurgeService } from '../groups/group-purge.service';
import { SHARED_MEMBER } from '../groups/group.types';
import { PrismaService } from '../prisma/prisma.service';
import { DAY_MS, fillDays, startOfUtcDay } from './admin-days';
import {
  parseDailyDays,
  type AdminGroupRow,
  type AdminGroupsPage,
  type AdminGroupsQuery,
  type AdminOverview,
  type GroupSort,
  type SortDir,
} from './admin.types';

const rowSelect = {
  id: true,
  name: true,
  mode: true,
  appearance: true,
  visibility: true,
  memberSlots: true,
  viewsTotal: true,
  createdAt: true,
  deletionRequestedAt: true,
  deleteAfter: true,
  members: { select: { name: true } },
} satisfies Prisma.GroupSelect;

type GroupRow = Prisma.GroupGetPayload<{ select: typeof rowSelect }>;

function orderBy(
  sort: GroupSort,
  dir: SortDir,
): Prisma.GroupOrderByWithRelationInput[] {
  if (sort === 'name') return [{ nameKey: dir }];
  if (sort === 'views') return [{ viewsTotal: dir }, { createdAt: 'desc' }];
  if (sort === 'members') {
    return [{ members: { _count: dir } }, { createdAt: 'desc' }];
  }
  return [{ createdAt: dir }];
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: GroupChangeNotifier,
    private readonly purge: GroupPurgeService,
  ) {}

  async overview(daysRaw?: string, now = new Date()): Promise<AdminOverview> {
    const days = parseDailyDays(daysRaw);
    const today = startOfUtcDay(now);
    const since = new Date(today.getTime() - (days - 1) * DAY_MS);

    const [
      groupsTotal,
      groupsPublic,
      membersTotal,
      pendingDeletion,
      createdToday,
      created7d,
      created30d,
      daily,
    ] = await Promise.all([
      this.prisma.group.count(),
      this.prisma.group.count({
        where: { visibility: GroupVisibility.public },
      }),
      this.prisma.member.count({ where: { name: { not: SHARED_MEMBER } } }),
      this.prisma.group.count({ where: { deleteAfter: { not: null } } }),
      this.prisma.group.count({ where: { createdAt: { gte: today } } }),
      this.prisma.group.count({
        where: { createdAt: { gte: new Date(today.getTime() - 6 * DAY_MS) } },
      }),
      this.prisma.group.count({
        where: { createdAt: { gte: new Date(today.getTime() - 29 * DAY_MS) } },
      }),
      this.dailyCreated(since),
    ]);

    return {
      groups_total: groupsTotal,
      groups_public: groupsPublic,
      groups_private: groupsTotal - groupsPublic,
      members_total: membersTotal,
      pending_deletion: pendingDeletion,
      created_today: createdToday,
      created_7d: created7d,
      created_30d: created30d,
      daily: fillDays(since, days, daily),
      at: now.toISOString(),
    };
  }

  private async dailyCreated(since: Date): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ day: string; groups: number }>
    >`
      SELECT to_char("created_at", 'YYYY-MM-DD') AS "day",
             COUNT(*)::int AS "groups"
      FROM "groups"
      WHERE "created_at" >= ${since}
      GROUP BY 1
    `;
    return new Map(rows.map((row) => [row.day, Number(row.groups)]));
  }

  async listGroups(query: AdminGroupsQuery): Promise<AdminGroupsPage> {
    const where = groupsWhere(query);
    const [total, rows] = await Promise.all([
      this.prisma.group.count({ where }),
      this.prisma.group.findMany({
        where,
        orderBy: orderBy(query.sort, query.dir),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: rowSelect,
      }),
    ]);

    return {
      groups: await this.withActivity(rows),
      total,
      page: query.page,
      page_size: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
      sort: query.sort,
      dir: query.dir,
      filter: query.filter,
      q: query.query,
    };
  }

  private async withActivity(rows: GroupRow[]): Promise<AdminGroupRow[]> {
    if (rows.length === 0) return [];
    const activity = await this.prisma.member.groupBy({
      by: ['groupId'],
      where: { groupId: { in: rows.map((row) => row.id) } },
      _max: { lastUpdated: true },
    });
    const latest = new Map(
      activity.map((entry) => [entry.groupId, entry._max.lastUpdated]),
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mode: row.mode,
      appearance: row.appearance,
      visibility: row.visibility,
      member_count: playableCount(row.members),
      member_slots: row.memberSlots,
      member_names: row.members
        .filter((member) => member.name !== SHARED_MEMBER)
        .map((member) => member.name)
        .sort(),
      views_total: row.viewsTotal,
      created_at: row.createdAt.toISOString(),
      last_activity: latest.get(row.id)?.toISOString() ?? null,
      deletion: deletionStatus(row),
    }));
  }

  async deleteGroup(id: string) {
    const group = await this.requireGroup(id);
    await this.purge.purgeGroup(group.id);
    this.logger.warn(`admin deleted group "${group.name}" (${group.id})`);
    return { ok: true, id: group.id, name: group.name };
  }

  async scheduleDeletion(id: string, now = new Date()) {
    const group = await this.requireGroup(id);
    if (group.deleteAfter) {
      return { ok: true, id: group.id, ...deletionStatus(group) };
    }
    const updated = await this.prisma.group.update({
      where: { id: group.id },
      data: { deletionRequestedAt: now, deleteAfter: deletionDueAt(now) },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
    this.notifier.notify(group.id, 'settings');
    this.logger.warn(
      `admin scheduled deletion of group "${group.name}" (${group.id})`,
    );
    return { ok: true, id: group.id, ...deletionStatus(updated) };
  }

  async cancelDeletion(id: string) {
    const group = await this.requireGroup(id);
    if (!group.deleteAfter) {
      return { ok: true, id: group.id, ...deletionStatus(group) };
    }
    const updated = await this.prisma.group.update({
      where: { id: group.id },
      data: { deletionRequestedAt: null, deleteAfter: null },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
    this.notifier.notify(group.id, 'settings');
    return { ok: true, id: group.id, ...deletionStatus(updated) };
  }

  private async requireGroup(id: string) {
    const group = await this.prisma.group.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        deletionRequestedAt: true,
        deleteAfter: true,
      },
    });
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }
}

function groupsWhere(query: AdminGroupsQuery): Prisma.GroupWhereInput {
  const where: Prisma.GroupWhereInput = {};
  if (query.query) where.nameKey = { contains: query.query };
  if (query.filter === 'public') where.visibility = GroupVisibility.public;
  if (query.filter === 'private') where.visibility = GroupVisibility.private;
  if (query.filter === 'pending_deletion') where.deleteAfter = { not: null };
  return where;
}
