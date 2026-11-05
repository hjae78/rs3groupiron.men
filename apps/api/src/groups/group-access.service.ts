import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GroupVisibility, Prisma } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { demoWritable } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The seeded demo group is public sample data: readable with no Authorization
 * header and read-only, because its token ships in the web bundle.
 */
const DEMO_GROUP_KEY = 'demo group';

const shareSelect = {
  visibility: true,
  publicMap: true,
  publicSkills: true,
  publicItems: true,
  publicQuests: true,
  publicAchievements: true,
} satisfies Prisma.GroupSelect;

/** Group row + member ids/names. Used wherever a handler needs the member list. */
const groupLightSelect = {
  id: true,
  name: true,
  nameKey: true,
  token: true,
  mode: true,
  appearance: true,
  memberSlots: true,
  createdAt: true,
  deletionRequestedAt: true,
  deleteAfter: true,
  dropThreshold: true,
  ...shareSelect,
  members: { select: { id: true, name: true } },
} satisfies Prisma.GroupSelect;

export type GroupLight = Prisma.GroupGetPayload<{
  select: typeof groupLightSelect;
}> & { scope: ShareScope };

/**
 * groupLightSelect without the members relation. Prisma loads relations in a
 * second round trip, so handlers that never read `group.members` save a query
 * by asking for this — which matters on get-group-data and on the SSE connect.
 */
const groupAuthSelect = {
  id: true,
  name: true,
  nameKey: true,
  token: true,
  mode: true,
  appearance: true,
  memberSlots: true,
  ...shareSelect,
} satisfies Prisma.GroupSelect;

export type GroupAuth = Prisma.GroupGetPayload<{
  select: typeof groupAuthSelect;
}> & { scope: ShareScope };

export type ShareScope = {
  map: boolean;
  skills: boolean;
  items: boolean;
  quests: boolean;
  achievements: boolean;
};

export const SHARE_KEYS = [
  'map',
  'skills',
  'items',
  'quests',
  'achievements',
] as const;

export const FULL_SCOPE: ShareScope = {
  map: true,
  skills: true,
  items: true,
  quests: true,
  achievements: true,
};

export const DEFAULT_SCOPE: ShareScope = {
  ...FULL_SCOPE,
  map: false,
};

type ShareColumns = Prisma.GroupGetPayload<{ select: typeof shareSelect }>;

export function sharesScope(
  group: Omit<ShareColumns, 'visibility'>,
): ShareScope {
  return {
    map: group.publicMap,
    skills: group.publicSkills,
    items: group.publicItems,
    quests: group.publicQuests,
    achievements: group.publicAchievements,
  };
}

export function isPublicGroup(group: { visibility: GroupVisibility }) {
  return group.visibility === GroupVisibility.public;
}

export function isFullScope(scope: ShareScope) {
  return SHARE_KEYS.every((key) => scope[key]);
}

/**
 * Whether a change kind may be announced to this caller.
 *
 * The endpoint behind a withheld kind already answers 403, so sending the kind
 * anyway would tell a tokenless viewer that something happened without letting
 * them read what. `members` rides the delta, which is redacted separately, and
 * `settings` mirrors am-i-logged-in, which every reader may see.
 */
export function visibleChangeKind(
  kind: 'members' | 'achievements' | 'quests' | 'settings',
  scope: ShareScope,
): boolean {
  if (kind === 'achievements') return scope.achievements;
  if (kind === 'quests') return scope.quests;
  return true;
}

const SHARE_LABELS: Record<keyof ShareScope, string> = {
  map: 'location',
  skills: 'skills',
  items: 'items',
  quests: 'quest progress',
  achievements: 'achievements',
};

export function requireShare(
  group: { scope: ShareScope },
  key: keyof ShareScope,
) {
  if (!group.scope[key]) {
    throw new ForbiddenException(
      `This group does not share its ${SHARE_LABELS[key]}`,
    );
  }
}

export function groupNameKey(name: string) {
  return name.toLowerCase();
}

/** Constant time, so a wrong token leaks nothing about how wrong it was. */
function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Every access decision in the API.
 *
 * A group's token is its only credential — there are no user accounts — so
 * these four methods are the whole authorization model. They live apart from
 * GroupsService so that a caller needing nothing but a permission check (the
 * upload presigner, the SSE connect) does not depend on the write paths.
 *
 * An unknown group and a wrong token always produce the identical 401, so the
 * endpoints cannot be used to enumerate group names.
 */
@Injectable()
export class GroupAccessService {
  constructor(private readonly prisma: PrismaService) {}

  findGroup(groupName: string): Promise<GroupLight | null> {
    return this.prisma.group
      .findUnique({
        where: { nameKey: groupNameKey(groupName) },
        select: groupLightSelect,
      })
      .then((group) => (group ? { ...group, scope: FULL_SCOPE } : null));
  }

  /** Read access, with the member list loaded. */
  async read(
    groupName: string,
    token: string | undefined,
  ): Promise<GroupLight> {
    if (!token) {
      const group = this.readTokenless(await this.findGroup(groupName));
      return { ...group, scope: tokenlessScope(group) };
    }
    return this.authenticate(groupName, token);
  }

  /** read()'s rules for callers that only need the group row. */
  async readWithoutMembers(
    groupName: string,
    token: string | undefined,
  ): Promise<GroupAuth> {
    const group = await this.prisma.group.findUnique({
      where: { nameKey: groupNameKey(groupName) },
      select: groupAuthSelect,
    });
    if (!token) {
      const allowed = this.readTokenless(group);
      return { ...allowed, scope: tokenlessScope(allowed) };
    }
    if (!group || !tokensMatch(group.token, token)) {
      throw new UnauthorizedException('Invalid group or token');
    }
    return { ...group, scope: FULL_SCOPE };
  }

  private readTokenless<
    T extends { nameKey: string; visibility: GroupVisibility },
  >(group: T | null): T {
    if (group && (group.nameKey === DEMO_GROUP_KEY || isPublicGroup(group))) {
      return group;
    }
    throw new UnauthorizedException('Invalid group or token');
  }

  /** Write access: a valid token, and never the public demo group. */
  async write(
    groupName: string,
    token: string | undefined,
  ): Promise<GroupLight> {
    const group = await this.authenticate(groupName, token);
    if (group.nameKey === DEMO_GROUP_KEY && !demoWritable()) {
      throw new ForbiddenException('The demo group is read-only');
    }
    return group;
  }

  private async authenticate(
    groupName: string,
    token: string | undefined,
  ): Promise<GroupLight> {
    if (!token) throw new UnauthorizedException('Missing Authorization token');
    const group = await this.findGroup(groupName);
    if (!group || !tokensMatch(group.token, token)) {
      throw new UnauthorizedException('Invalid group or token');
    }
    return group;
  }
}

function tokenlessScope(group: ShareColumns & { nameKey: string }): ShareScope {
  if (group.nameKey === DEMO_GROUP_KEY) return FULL_SCOPE;
  return sharesScope(group);
}
