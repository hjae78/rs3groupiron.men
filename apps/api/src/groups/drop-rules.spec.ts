import { GroupAccessService } from './group-access.service';
import { GroupAchievementsService } from './achievements.service';
import { RareItemsService } from '../items/rare-items.service';
import { GroupChangeNotifier } from './group-change-notifier.service';
import type { GamevalsService } from '../gamevals/gamevals.service';
import type { PrismaService } from '../prisma/prisma.service';

const GROUP = {
  id: 'g1',
  name: 'Testing',
  dropThreshold: 0,
  members: [{ id: 'm1', name: 'Swan Swear' }],
};

/** On the shared list, so it needs no group opinion. */
const SHARED_ID = 20171;
const UNLISTED_ID = 4151;

function build(options: {
  override?: {
    include: boolean;
    minQty?: number | null;
    maxQty?: number | null;
  } | null;
  threshold?: number;
}) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    groupRareItem: {
      findUnique: jest.fn().mockResolvedValue(options.override ?? null),
    },
    achievement: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return {
          ...data,
          id: 'a1',
          achievedAt: new Date(),
          skillId: null,
          gameval: null,
          imageUrl: null,
        };
      }),
    },
  } as unknown as PrismaService;

  const access = {
    write: jest
      .fn()
      .mockResolvedValue({ ...GROUP, dropThreshold: options.threshold ?? 0 }),
  } as unknown as GroupAccessService;
  const rare = new RareItemsService();
  rare.load('data/rare-items.json');

  const achievements = new GroupAchievementsService(
    prisma,
    access,
    {} as GamevalsService,
    rare,
    new GroupChangeNotifier(),
  );
  return { groups: achievements, created };
}

describe('drop rules', () => {
  it('records an item on the shared list', async () => {
    const { groups, created } = build({});
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: SHARED_ID,
    });
    expect(out.recorded).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('ignores an item nobody listed', async () => {
    const { groups, created } = build({});
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: UNLISTED_ID,
    });
    expect(out.recorded).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('keeps an item the group added itself', async () => {
    const { groups } = build({ override: { include: true } });
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: UNLISTED_ID,
    });
    expect(out.recorded).toBe(true);
  });

  it('silences a listed item the group excluded', async () => {
    const { groups } = build({ override: { include: false } });
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: SHARED_ID,
    });
    expect(out.recorded).toBe(false);
  });

  it('keeps an unlisted item worth at least the threshold', async () => {
    const { groups } = build({ threshold: 5_000_000 });
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: UNLISTED_ID,
      value: 5_000_000,
    });
    expect(out.recorded).toBe(true);
  });

  it('ignores an unlisted item below the threshold', async () => {
    const { groups } = build({ threshold: 5_000_000 });
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: UNLISTED_ID,
      value: 4_999_999,
    });
    expect(out.recorded).toBe(false);
  });

  // The client filters with a list fetched at login, so a stale or hostile one
  // can still post anything. These two are the server having the last word.
  it('rejects an unlisted item a client posted anyway', async () => {
    const { groups, created } = build({});
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: 1511,
      item_name: 'Logs',
      value: 250,
    });
    expect(out.recorded).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('rejects an item the group silenced after the client cached the list', async () => {
    const { groups, created } = build({ override: { include: false } });
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: SHARED_ID,
      item_name: 'Still on the old list',
    });
    expect(out.recorded).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('lets an exclusion win over the threshold', async () => {
    const { groups } = build({ override: { include: false }, threshold: 1 });
    const out = await groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: UNLISTED_ID,
      value: 999_999_999,
    });
    expect(out.recorded).toBe(false);
  });
});

/** "Only tell me about 100+ blood runes", for noted and stackable drops. */
describe('quantity range', () => {
  const report = (groups: GroupAchievementsService, quantity?: number) =>
    groups.reportDrop('Testing', 't', {
      name: 'Swan Swear',
      item_id: UNLISTED_ID,
      quantity,
    });

  it('keeps a stack inside the window', async () => {
    const { groups } = build({
      override: { include: true, minQty: 100, maxQty: 500 },
    });
    expect((await report(groups, 250)).recorded).toBe(true);
  });

  it('keeps a stack on either boundary', async () => {
    const { groups } = build({
      override: { include: true, minQty: 100, maxQty: 500 },
    });
    expect((await report(groups, 100)).recorded).toBe(true);
    expect((await report(groups, 500)).recorded).toBe(true);
  });

  it('drops a stack below the minimum', async () => {
    const { groups } = build({ override: { include: true, minQty: 100 } });
    expect((await report(groups, 99)).recorded).toBe(false);
  });

  it('drops a stack above the maximum', async () => {
    const { groups } = build({ override: { include: true, maxQty: 10 } });
    expect((await report(groups, 11)).recorded).toBe(false);
  });

  // A report with no quantity is one item, so a minimum above 1 rules it out.
  it('treats a missing quantity as one', async () => {
    const { groups } = build({ override: { include: true, minQty: 2 } });
    expect((await report(groups)).recorded).toBe(false);
  });

  it('ignores a window on an excluded item', async () => {
    const { groups } = build({
      override: { include: false, minQty: 1, maxQty: 999 },
    });
    expect((await report(groups, 5)).recorded).toBe(false);
  });

  // An item with no window set behaves exactly as it did before ranges existed.
  it('keeps any amount when both ends are open', async () => {
    const { groups } = build({
      override: { include: true, minQty: null, maxQty: null },
    });
    expect((await report(groups, 1)).recorded).toBe(true);
    expect((await report(groups, 1_000_000)).recorded).toBe(true);
  });
});
