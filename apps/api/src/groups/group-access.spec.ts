import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import { InventoryStorageService } from './inventory-storage.service';
import { XpHistoryService } from './xp-history.service';
import type { PlayerVerificationService } from './player-verification.service';

const DEMO_TOKEN = 'demo-token-value';
const REAL_TOKEN = 'real-token-value';

function groupRow(name: string, token: string) {
  return {
    id: `id-${name}`,
    name,
    nameKey: name.toLowerCase(),
    token,
    mode: GroupMode.normal,
    appearance: AppearanceTheme.rs3,
    memberSlots: 5,
    createdAt: new Date('2026-01-15T12:00:00.000Z'),
    members: [{ id: 'm1', name: 'IronJackery' }],
  };
}

const GROUPS: Record<string, ReturnType<typeof groupRow>> = {
  'demo group': groupRow('Demo Group', DEMO_TOKEN),
  'real group': groupRow('Real Group', REAL_TOKEN),
};

/** Records the `select` of the last lookup so projections can be asserted. */
function fakePrisma() {
  const selects: Array<Record<string, unknown>> = [];
  const prisma = {
    group: {
      findUnique: (args: {
        where: { nameKey: string };
        select: Record<string, unknown>;
      }) => {
        selects.push(args.select);
        return Promise.resolve(GROUPS[args.where.nameKey] ?? null);
      },
    },
  } as unknown as PrismaService;
  return { prisma, selects };
}

describe('GroupAccessService', () => {
  const originalEnv = process.env.DEMO_WRITABLE;
  let access: GroupAccessService;
  let selects: Array<Record<string, unknown>>;

  beforeEach(() => {
    delete process.env.DEMO_WRITABLE;
    const fake = fakePrisma();
    selects = fake.selects;
    access = new GroupAccessService(fake.prisma);
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.DEMO_WRITABLE;
    else process.env.DEMO_WRITABLE = originalEnv;
  });

  describe('read', () => {
    it('serves the demo group with no token', async () => {
      const group = await access.read('Demo Group', undefined);
      expect(group.name).toBe('Demo Group');
    });

    it('is case-insensitive about the demo group name', async () => {
      const group = await access.read('demo group', undefined);
      expect(group.name).toBe('Demo Group');
    });

    it('rejects any other group without a token', async () => {
      await expect(access.read('Real Group', undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('uses the same message for an unknown group as for a bad token', async () => {
      const unknown = await access
        .read('Nope', undefined)
        .catch((e: Error) => e.message);
      const badToken = await access
        .read('Real Group', 'wrong')
        .catch((e: Error) => e.message);
      expect(unknown).toBe(badToken);
    });

    it('still accepts a valid token', async () => {
      const group = await access.read('Real Group', REAL_TOKEN);
      expect(group.name).toBe('Real Group');
    });
  });

  // Used by get-group-data and the SSE connect, so it must enforce exactly the
  // same rules as read() — only the members relation is left out.
  describe('readWithoutMembers', () => {
    it('serves the demo group with no token', async () => {
      const group = await access.readWithoutMembers('Demo Group', undefined);
      expect(group.name).toBe('Demo Group');
    });

    it('rejects any other group without a token', async () => {
      await expect(
        access.readWithoutMembers('Real Group', undefined),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong token', async () => {
      await expect(
        access.readWithoutMembers('Real Group', 'wrong'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('uses the same message for an unknown group as for a bad token', async () => {
      const unknown = await access
        .readWithoutMembers('Nope', undefined)
        .catch((e: Error) => e.message);
      const badToken = await access
        .readWithoutMembers('Real Group', 'wrong')
        .catch((e: Error) => e.message);
      expect(unknown).toBe(badToken);
    });

    it('accepts a valid token', async () => {
      const group = await access.readWithoutMembers('Real Group', REAL_TOKEN);
      expect(group.name).toBe('Real Group');
    });

    it('does not ask Prisma for the members relation', async () => {
      await access.readWithoutMembers('Real Group', REAL_TOKEN);

      expect(selects).toHaveLength(1);
      expect(selects[0].members).toBeUndefined();
      expect(selects[0].token).toBe(true);
    });
  });

  describe('write', () => {
    it('rejects the demo group even with its real token', async () => {
      await expect(
        access.write('Demo Group', DEMO_TOKEN),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects the demo group with no token', async () => {
      await expect(
        access.write('Demo Group', undefined),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('allows demo writes when DEMO_WRITABLE=1', async () => {
      process.env.DEMO_WRITABLE = '1';
      const group = await access.write('Demo Group', DEMO_TOKEN);
      expect(group.name).toBe('Demo Group');
    });

    it('allows a normal group with its token', async () => {
      const group = await access.write('Real Group', REAL_TOKEN);
      expect(group.name).toBe('Real Group');
    });

    it('rejects a wrong token of the same length', async () => {
      await expect(
        access.write('Real Group', 'reol-token-value'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});

describe('amILoggedIn', () => {
  let groups: GroupsService;

  beforeEach(() => {
    const { prisma } = fakePrisma();
    groups = new GroupsService(
      prisma,
      new GroupAccessService(prisma),
      {} as XpHistoryService,
      new GamevalsService(),
      {} as PlayerVerificationService,
      new GroupChangeNotifier(),
      new InventoryStorageService({} as XpHistoryService),
    );
  });

  it('does not echo a token back on a tokenless demo read', async () => {
    const info = await groups.amILoggedIn('Demo Group', undefined);
    expect(info).not.toHaveProperty('token');
    expect(info.name).toBe('Demo Group');
  });

  it('echoes the token back to an authenticated caller', async () => {
    const info = await groups.amILoggedIn('Real Group', REAL_TOKEN);
    expect(info).toHaveProperty('token', REAL_TOKEN);
  });
});
