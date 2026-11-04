import { PassThrough } from 'node:stream';
import { PLAYER_DATA_PAGE, PlayerDataService } from './player-data.service';
import type { GroupExportService } from './group-export.service';
import type { PrismaService } from '../prisma/prisma.service';

function member(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    groupId: 'g1',
    group: { id: 'g1', name: 'Iron Crew' },
    skills: [],
    inventories: [],
    quests: [],
    completedAchievements: [],
    achievementTallies: [],
    npcKills: [],
    ...overrides,
  };
}

function buildService(opts: {
  player?: Record<string, unknown>;
  members?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  feed?: Array<Record<string, unknown>>;
  xpSamples?: Array<Record<string, unknown>>;
}) {
  const findManyLedger = jest.fn(() => Promise.resolve(opts.ledger ?? []));
  const findManyFeed = jest.fn(() => Promise.resolve(opts.feed ?? []));
  const findManyXp = jest.fn(() => Promise.resolve(opts.xpSamples ?? []));

  const prisma = {
    player: {
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve(
          opts.player ?? {
            id: 'p1',
            currentUsername: 'Woox',
            usernameKey: 'woox',
            verificationStatus: 'plugin_verified',
            verifiedAt: new Date('2026-10-19T12:00:00.000Z'),
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            usernameHistory: [],
          },
        ),
      ),
    },
    member: {
      findMany: jest.fn(() => Promise.resolve(opts.members ?? [])),
      findFirst: jest.fn(() =>
        Promise.resolve((opts.members ?? [])[0] ?? null),
      ),
    },
    sharedBankEntry: { findMany: findManyLedger },
    achievement: { findMany: findManyFeed },
    skillXpSample: { findMany: findManyXp },
  } as unknown as PrismaService;

  const groupExport = {
    buildStateDocument: jest.fn((groupName: string) =>
      Promise.resolve({
        groupId: 'g1',
        document: { group: { name: groupName } },
      }),
    ),
    writeGroupEntries: jest.fn(() =>
      Promise.resolve({
        xp_samples: 0,
        bank_ledger: 0,
        achievement_feed: 0,
        screenshots: 0,
      }),
    ),
  } as unknown as GroupExportService;

  return {
    service: new PlayerDataService(prisma, groupExport),
    prisma,
    groupExport,
    findManyLedger,
    findManyFeed,
    findManyXp,
  };
}

describe('PlayerDataService.buildDocument', () => {
  it('returns an empty-but-valid document for a player with no memberships', async () => {
    const { service, findManyLedger, findManyFeed, findManyXp } = buildService({
      members: [],
    });

    const doc = await service.buildDocument('p1');

    expect(doc.memberships).toEqual([]);
    expect(doc.bank_ledger).toEqual([]);
    expect(doc.achievement_feed).toEqual([]);
    expect(doc.xp_samples).toEqual([]);
    expect(doc.row_cap).toBe(PLAYER_DATA_PAGE);
    expect(findManyLedger).not.toHaveBeenCalled();
    expect(findManyFeed).not.toHaveBeenCalled();
    expect(findManyXp).not.toHaveBeenCalled();
  });

  it('includes current and historical usernames in matched_usernames, deduplicated', async () => {
    const { service } = buildService({
      player: {
        id: 'p1',
        currentUsername: 'Woox',
        usernameKey: 'woox',
        verificationStatus: 'plugin_verified',
        verifiedAt: null,
        createdAt: new Date(),
        usernameHistory: [
          { username: 'OldWoox', firstSeenAt: new Date() },
          { username: 'Woox', firstSeenAt: new Date() },
        ],
      },
      members: [member()],
    });

    const doc = await service.buildDocument('p1');

    expect(doc.matched_usernames).toEqual(['Woox', 'OldWoox']);
  });

  it('shapes a membership with skills, quests, achievements and kills', async () => {
    const { service } = buildService({
      members: [
        member({
          skills: [
            { skillId: 'attack', xp: BigInt(1000), level: 20, baseLevel: 20 },
          ],
          quests: [{ gameval: 'quest_x', state: 2, updatedAt: new Date() }],
          completedAchievements: [{ gameval: 'ach_x', updatedAt: new Date() }],
          achievementTallies: [
            { gameval: 'ach_y', progress: 1, target: 5, updatedAt: new Date() },
          ],
          npcKills: [{ npcName: 'Goblin', kills: 3, lastAt: new Date() }],
        }),
      ],
    });

    const doc = await service.buildDocument('p1');

    expect(doc.memberships).toHaveLength(1);
    const m = doc.memberships[0];
    expect(m.group).toBe('Iron Crew');
    expect(m.skills).toEqual([
      { id: 'attack', xp: '1000', level: 20, base_level: 20 },
    ]);
    expect(m.quests).toHaveLength(1);
    expect(m.achievements_completed).toHaveLength(1);
    expect(m.achievements_in_progress).toHaveLength(1);
    expect(m.npc_kills).toEqual([
      { npc: 'Goblin', kills: 3, last_at: expect.any(String) },
    ]);
  });

  it('queries ledger/feed/xp only when the player has memberships', async () => {
    const { service, findManyLedger, findManyFeed, findManyXp } = buildService({
      members: [member()],
      ledger: [
        {
          createdAt: new Date(),
          groupId: 'g1',
          memberName: 'Woox',
          itemId: 4151,
          delta: 1,
        },
      ],
      feed: [
        {
          achievedAt: new Date(),
          groupId: 'g1',
          memberName: 'Woox',
          kind: 'level',
          title: '99 Attack',
          detail: null,
          skillId: 'attack',
          itemId: null,
          quantity: null,
          gameval: null,
          imageUrl: null,
        },
      ],
      xpSamples: [
        {
          memberId: 'm1',
          skillId: 'attack',
          xp: BigInt(500),
          sampledAt: new Date(),
        },
      ],
    });

    const doc = await service.buildDocument('p1');

    expect(findManyLedger).toHaveBeenCalled();
    expect(findManyFeed).toHaveBeenCalled();
    expect(findManyXp).toHaveBeenCalled();
    expect(doc.bank_ledger).toHaveLength(1);
    expect(doc.achievement_feed).toHaveLength(1);
    expect(doc.xp_samples).toEqual([
      {
        member_id: 'm1',
        skill_id: 'attack',
        xp: '500',
        sampled_at: expect.any(String),
      },
    ]);
  });
});

describe('PlayerDataService.writeExportArchive', () => {
  it('writes one group entry set per membership, filtered to this player — including groups left behind', async () => {
    const { service, groupExport } = buildService({
      members: [
        member({ id: 'm1', group: { id: 'g1', name: 'Iron Crew' } }),
        member({ id: 'm2', group: { id: 'g2', name: 'Steel Crew' } }),
      ],
    });

    const out = new PassThrough();
    out.resume();
    await service.writeExportArchive(out, 'p1');

    expect(groupExport.buildStateDocument).toHaveBeenCalledTimes(2);
    expect(groupExport.writeGroupEntries).toHaveBeenCalledTimes(2);

    const calls = (groupExport.writeGroupEntries as jest.Mock).mock.calls;
    expect(calls[0][4]).toEqual({
      filter: { memberId: 'm1', usernames: ['Woox'] },
      pathPrefix: 'Iron Crew/',
      scope: 'player',
    });
    expect(calls[1][4]).toEqual({
      filter: { memberId: 'm2', usernames: ['Woox'] },
      pathPrefix: 'Steel Crew/',
      scope: 'player',
    });
  });

  it('includes previous usernames in the filter', async () => {
    const { service, groupExport } = buildService({
      player: {
        id: 'p1',
        currentUsername: 'Woox',
        usernameKey: 'woox',
        verificationStatus: 'plugin_verified',
        verifiedAt: new Date(),
        createdAt: new Date(),
        usernameHistory: [{ username: 'OldWoox' }],
      },
      members: [member()],
    });

    const out = new PassThrough();
    out.resume();
    await service.writeExportArchive(out, 'p1');

    const calls = (groupExport.writeGroupEntries as jest.Mock).mock.calls;
    expect(calls[0][4].filter.usernames).toEqual(['Woox', 'OldWoox']);
  });

  it('deduplicates directory names that collide case-insensitively', async () => {
    const { service, groupExport } = buildService({
      members: [
        member({ id: 'm1', group: { id: 'g1', name: 'Iron Crew' } }),
        member({ id: 'm2', group: { id: 'g2', name: 'IRON CREW' } }),
      ],
    });

    const out = new PassThrough();
    out.resume();
    await service.writeExportArchive(out, 'p1');

    const calls = (groupExport.writeGroupEntries as jest.Mock).mock.calls;
    expect(calls[0][4].pathPrefix).toBe('Iron Crew/');
    expect(calls[1][4].pathPrefix).toBe('IRON CREW-2/');
  });

  it('produces an empty-but-valid zip for a player with no memberships', async () => {
    const { service, groupExport } = buildService({ members: [] });

    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    await service.writeExportArchive(out, 'p1');

    expect(groupExport.writeGroupEntries).not.toHaveBeenCalled();
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });
});
