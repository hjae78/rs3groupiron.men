import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AppearanceTheme, GroupMode, GroupVisibility } from '@prisma/client';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_SCOPE,
  FULL_SCOPE,
  GroupAccessService,
  isFullScope,
  requireShare,
  sharesScope,
} from './group-access.service';
import { sharesToColumns } from './group-fields';
import { redactWireEntries, type WireEntry } from './group-wire';
import { GroupsService } from './groups.service';
import { InventoryStorageService } from './inventory-storage.service';
import type { PlayerVerificationService } from './player-verification.service';
import { XpHistoryService } from './xp-history.service';

const PUBLIC_TOKEN = 'public-token-value';
const PRIVATE_TOKEN = 'secret-token-value';

type Shares = {
  publicMap: boolean;
  publicSkills: boolean;
  publicItems: boolean;
  publicQuests: boolean;
  publicAchievements: boolean;
};

const ALL_SHARED: Shares = {
  publicMap: true,
  publicSkills: true,
  publicItems: true,
  publicQuests: true,
  publicAchievements: true,
};

function groupRow(
  name: string,
  token: string,
  visibility: GroupVisibility,
  shares: Partial<Shares> = {},
) {
  return {
    id: `id-${name}`,
    name,
    nameKey: name.toLowerCase(),
    token,
    mode: GroupMode.normal,
    appearance: AppearanceTheme.rs3,
    memberSlots: 5,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    visibility,
    ...ALL_SHARED,
    ...shares,
    members: [{ id: 'm1', name: 'IronJackery' }],
  };
}

const GROUPS = {
  'open group': groupRow('Open Group', PUBLIC_TOKEN, GroupVisibility.public),
  'shy group': groupRow('Shy Group', PUBLIC_TOKEN, GroupVisibility.public, {
    publicMap: false,
    publicItems: false,
  }),
  'closed group': groupRow(
    'Closed Group',
    PRIVATE_TOKEN,
    GroupVisibility.private,
  ),
  'demo group': groupRow('Demo Group', 'demo-token', GroupVisibility.private),
};

function fakePrisma() {
  const prisma = {
    group: {
      findUnique: (args: { where: { nameKey: string } }) =>
        Promise.resolve(
          GROUPS[args.where.nameKey as keyof typeof GROUPS] ?? null,
        ),
      findMany: (args: {
        where: { visibility: GroupVisibility; nameKey?: { contains: string } };
      }) =>
        Promise.resolve(
          Object.values(GROUPS).filter(
            (group) =>
              group.visibility === args.where.visibility &&
              (!args.where.nameKey ||
                group.nameKey.includes(args.where.nameKey.contains)),
          ),
        ),
    },
    member: {
      findUnique: () =>
        Promise.resolve({
          playerId: 'p1',
          player: {
            verificationStatus: 'unverified',
            usernameKey: 'ironjackery',
          },
        }),
    },
  } as unknown as PrismaService;
  return prisma;
}

function service(
  prisma: PrismaService,
  verification?: PlayerVerificationService,
) {
  return new GroupsService(
    prisma,
    new GroupAccessService(prisma),
    {} as XpHistoryService,
    new GamevalsService(),
    verification ?? ({} as PlayerVerificationService),
    new GroupChangeNotifier(),
    new InventoryStorageService({} as XpHistoryService),
  );
}

describe('tokenless access to a public group', () => {
  let access: GroupAccessService;

  beforeEach(() => {
    access = new GroupAccessService(fakePrisma());
  });

  it('reads a public group with no token', async () => {
    const group = await access.read('Open Group', undefined);
    expect(group.name).toBe('Open Group');
  });

  it('is case-insensitive about the name', async () => {
    const group = await access.read('open GROUP', undefined);
    expect(group.name).toBe('Open Group');
  });

  it('still refuses a private group with no token', async () => {
    await expect(access.read('Closed Group', undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('uses the same message for a private group as for an unknown one', async () => {
    const unknown = await access
      .read('No Such Group', undefined)
      .catch((e: Error) => e.message);
    const privateGroup = await access
      .read('Closed Group', undefined)
      .catch((e: Error) => e.message);
    expect(privateGroup).toBe(unknown);
  });

  it('refuses a wrong token rather than falling back to the public view', async () => {
    await expect(
      access.read('Open Group', 'wrong-token-value'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('grants a tokenless viewer only what the group shares', async () => {
    const group = await access.read('Shy Group', undefined);
    expect(group.scope).toEqual({
      map: false,
      skills: true,
      items: false,
      quests: true,
      achievements: true,
    });
  });

  it('grants the token holder everything the group withholds from others', async () => {
    const group = await access.read('Shy Group', PUBLIC_TOKEN);
    expect(isFullScope(group.scope)).toBe(true);
  });

  it('enforces the same rules without the members relation', async () => {
    const open = await access.readWithoutMembers('Open Group', undefined);
    expect(open.scope.map).toBe(true);
    await expect(
      access.readWithoutMembers('Closed Group', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never grants write access without the token', async () => {
    await expect(access.write('Open Group', undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('requireShare', () => {
  it('passes when the part is shared', () => {
    expect(() => requireShare({ scope: FULL_SCOPE }, 'items')).not.toThrow();
  });

  it('is a 403, not a 404 — the group is readable, this part is not', () => {
    expect(() =>
      requireShare({ scope: { ...FULL_SCOPE, items: false } }, 'items'),
    ).toThrow(ForbiddenException);
  });
});

describe('share defaults', () => {
  it('shares everything but the live map when a request says nothing', () => {
    expect(sharesToColumns(undefined)).toEqual({
      publicMap: false,
      publicSkills: true,
      publicItems: true,
      publicQuests: true,
      publicAchievements: true,
    });
  });

  it('lets a group ask for the map explicitly', () => {
    expect(sharesToColumns({ map: true }).publicMap).toBe(true);
  });

  it('takes a false over the default rather than treating it as unsaid', () => {
    expect(sharesToColumns({ skills: false }).publicSkills).toBe(false);
  });

  it('matches the scope the rest of the API defaults to', () => {
    expect(sharesScope(sharesToColumns(undefined))).toEqual(DEFAULT_SCOPE);
  });
});

describe('redactWireEntries', () => {
  const member = {
    name: 'IronJackery',
    last_updated: '2026-02-01T00:00:00.000Z',
    stats: [70, 99, 30, 55, 6, 6, 84, 12.5],
    coordinates: [3200, 3200, 0],
    target: { name: 'Goblin', at: '2026-02-01T00:00:00.000Z' },
    inventory: [995, 10],
    bank: [995, 1000],
    equipment: [1215, 1],
    inventories: { money_pouch: [995, 5] },
    skills: { attack: { xp: 100, level: 10, baseLevel: 10 } },
  } as unknown as WireEntry;

  it('returns the very same array when nothing is withheld', () => {
    const entries = [member];
    expect(redactWireEntries(entries, FULL_SCOPE)).toBe(entries);
  });

  it('empties the position when the map is private', () => {
    const [out] = redactWireEntries([member], {
      ...FULL_SCOPE,
      map: false,
    }) as Array<Record<string, unknown>>;
    expect(out.coordinates).toEqual([]);
    expect(out.target).toBeUndefined();
    expect(out.bank).toEqual([995, 1000]);
  });

  it('hides the world along with the position', () => {
    const [out] = redactWireEntries([member], {
      ...FULL_SCOPE,
      map: false,
    }) as Array<Record<string, unknown>>;
    expect((out.stats as number[])[6]).toBe(0);
  });

  it('leaves the vitals alongside it alone', () => {
    const [out] = redactWireEntries([member], {
      ...FULL_SCOPE,
      map: false,
    }) as Array<Record<string, unknown>>;
    expect(out.stats).toEqual([70, 99, 30, 55, 6, 6, 0, 12.5]);
  });

  it('does not touch the stats of a group that shares its map', () => {
    const [out] = redactWireEntries([member], {
      ...FULL_SCOPE,
      items: false,
    }) as Array<Record<string, unknown>>;
    expect((out.stats as number[])[6]).toBe(84);
  });

  it('does not mutate the entry it was given', () => {
    redactWireEntries([member], { ...FULL_SCOPE, map: false });
    expect((member as unknown as { stats: number[] }).stats[6]).toBe(84);
  });

  it('empties every inventory field when items are private', () => {
    const [out] = redactWireEntries([member], {
      ...FULL_SCOPE,
      items: false,
    }) as Array<Record<string, unknown>>;
    expect(out.inventory).toEqual([]);
    expect(out.bank).toEqual([]);
    expect(out.equipment).toEqual([]);
    expect(out.inventories).toBeUndefined();
    expect(out).toHaveProperty('bank');
  });

  it('empties skills when skills are private', () => {
    const [out] = redactWireEntries([member], {
      ...FULL_SCOPE,
      skills: false,
    }) as Array<Record<string, unknown>>;
    expect(out.skills).toEqual({});
  });

  it('leaves a name-only stub alone', () => {
    const stub = { name: 'IronJackery' };
    const [out] = redactWireEntries([stub], {
      ...FULL_SCOPE,
      map: false,
      items: false,
    });
    expect(out).toEqual(stub);
  });
});

describe('scoped read endpoints', () => {
  let groups: GroupsService;

  beforeEach(() => {
    groups = service(fakePrisma());
  });

  it('refuses the bank ledger of a group that hides its items', async () => {
    await expect(
      groups.getBankLedger('Shy Group', undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('serves the owner the ledger of their own hidden items', async () => {
    await expect(
      groups.getBankLedger('Shy Group', PUBLIC_TOKEN),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('reports both the group settings and this viewer scope', async () => {
    const info = await groups.amILoggedIn('Shy Group', undefined);
    expect(info.visibility).toBe(GroupVisibility.public);
    expect(info.shares.items).toBe(false);
    expect(info.visible.items).toBe(false);
    expect(info).not.toHaveProperty('token');
  });

  it('reports the full scope to the token holder, flags untouched', async () => {
    const info = await groups.amILoggedIn('Shy Group', PUBLIC_TOKEN);
    expect(info.shares.items).toBe(false);
    expect(info.visible.items).toBe(true);
  });
});

describe('amILoggedIn tracking-id auto-verify', () => {
  it('asks verification to auto-verify an unverified member and reports its result', async () => {
    const tryAutoVerify = jest.fn(() => Promise.resolve(true));
    const verification = {
      tryAutoVerify,
    } as unknown as PlayerVerificationService;
    const groups = service(fakePrisma(), verification);

    const info = await groups.amILoggedIn(
      'Open Group',
      undefined,
      'IronJackery',
      'track-123',
    );

    expect(tryAutoVerify).toHaveBeenCalledWith(
      'm1',
      'p1',
      'ironjackery',
      'track-123',
    );
    expect(info.member_verified).toBe(true);
  });

  it('does not call verification when a tracking id is not provided', async () => {
    const tryAutoVerify = jest.fn(() => Promise.resolve(true));
    const verification = {
      tryAutoVerify,
    } as unknown as PlayerVerificationService;
    const groups = service(fakePrisma(), verification);

    const info = await groups.amILoggedIn(
      'Open Group',
      undefined,
      'IronJackery',
    );

    expect(tryAutoVerify).not.toHaveBeenCalled();
    expect(info.member_verified).toBe(false);
  });
});

describe('recordGroupView', () => {
  function viewPrisma() {
    const writes: string[] = [];
    const base = fakePrisma() as unknown as Record<string, unknown>;
    const prisma = {
      ...base,
      groupViewDay: {
        upsert: (args: { where: { groupId_day: { groupId: string } } }) => {
          writes.push(`day:${args.where.groupId_day.groupId}`);
          return Promise.resolve({});
        },
      },
      group: {
        ...(base.group as object),
        update: (args: { where: { id: string } }) => {
          writes.push(`total:${args.where.id}`);
          return Promise.resolve({});
        },
      },
      $transaction: (ops: unknown[]) => Promise.all(ops),
    } as unknown as PrismaService;
    return { prisma, writes };
  }

  it('counts a visit to a public group', async () => {
    const { prisma, writes } = viewPrisma();
    const result = await service(prisma).recordGroupView(
      'Open Group',
      undefined,
    );
    expect(result.counted).toBe(true);
    expect(writes).toEqual(['day:id-Open Group', 'total:id-Open Group']);
  });

  it('does not count the owner looking at their own group', async () => {
    const { prisma, writes } = viewPrisma();
    const result = await service(prisma).recordGroupView(
      'Open Group',
      PUBLIC_TOKEN,
    );
    expect(result.counted).toBe(false);
    expect(writes).toEqual([]);
  });

  it('refuses a private group exactly as every other read does', async () => {
    const { prisma } = viewPrisma();
    await expect(
      service(prisma).recordGroupView('Closed Group', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not count the demo group, which is sample data', async () => {
    const { prisma, writes } = viewPrisma();
    const result = await service(prisma).recordGroupView(
      'Demo Group',
      undefined,
    );
    expect(result.counted).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('findPublicGroups', () => {
  let groups: GroupsService;

  beforeEach(() => {
    groups = service(fakePrisma());
  });

  it('lists public groups and never a private one', async () => {
    const { groups: found } = await groups.findPublicGroups();
    expect(found.map((g) => g.name).sort()).toEqual([
      'Open Group',
      'Shy Group',
    ]);
  });

  it('matches on name, case-insensitively', async () => {
    const { groups: found } = await groups.findPublicGroups('SHY');
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Shy Group');
  });

  it('cannot be used to confirm a private group exists', async () => {
    const { groups: found } = await groups.findPublicGroups('Closed Group');
    expect(found).toEqual([]);
  });

  it('reports what each group shares, so the site can say so up front', async () => {
    const { groups: found } = await groups.findPublicGroups('Shy');
    expect(found[0].shares).toEqual({
      map: false,
      skills: true,
      items: false,
      quests: true,
      achievements: true,
    });
  });

  it('never exposes a token', async () => {
    const { groups: found } = await groups.findPublicGroups();
    for (const group of found) {
      expect(group).not.toHaveProperty('token');
    }
  });
});
