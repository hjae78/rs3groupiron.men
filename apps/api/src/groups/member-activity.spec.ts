import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { MemberActivityService } from './member-activity.service';

const TOKEN = 'group-token-value';

/**
 * Pins the member-activity methods' subtle behavior (playerMoved,
 * reportKills, getNpcKills, setTarget, setLocationSharing, syncGroupMode,
 * setMemberOnline).
 */
function makeService(options: {
  mode?: GroupMode;
  shareLocation?: boolean;
} = {}) {
  const memberUpdate = jest.fn().mockResolvedValue({ plane: 0 });
  const memberUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const memberFindUnique = jest
    .fn()
    .mockResolvedValue({ shareLocation: options.shareLocation ?? true });
  const groupUpdate = jest.fn().mockResolvedValue({ id: 'g1' });
  const npcKillUpsert = jest.fn().mockResolvedValue({});
  const npcKillFindMany = jest.fn().mockResolvedValue([]);

  const tx = {
    memberNpcKill: { upsert: npcKillUpsert },
    member: { update: memberUpdate },
  };

  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    member: {
      update: memberUpdate,
      updateMany: memberUpdateMany,
      findUnique: memberFindUnique,
    },
    memberNpcKill: { findMany: npcKillFindMany },
    group: {
      update: groupUpdate,
      findUnique: () =>
        Promise.resolve({
          id: 'g1',
          name: 'Group',
          nameKey: 'group',
          token: TOKEN,
          mode: options.mode ?? GroupMode.normal,
          appearance: AppearanceTheme.rs3,
          memberSlots: 5,
          members: [{ id: 'm1', name: 'IronJackery' }],
        }),
    },
  } as unknown as PrismaService;

  const groups = new MemberActivityService(
    prisma,
    new GroupAccessService(prisma),
    new GroupChangeNotifier(),
  );
  return {
    groups,
    memberUpdate,
    memberUpdateMany,
    memberFindUnique,
    groupUpdate,
    npcKillUpsert,
  };
}

describe('playerMoved', () => {
  it('stores nothing and reports share_location: false when opted out', async () => {
    const { groups, memberUpdate } = makeService({ shareLocation: false });

    const out = await groups.playerMoved('Group', TOKEN, {
      name: 'IronJackery',
      coordinates: [3200, 3200, 0],
    });

    expect(out).toMatchObject({
      ok: true,
      online: true,
      coordinates: [],
      share_location: false,
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { online: true, inLobby: false, lastUpdated: expect.any(Date) },
      select: { id: true },
    });
  });

  it('rounds and stores coordinates when sharing is on', async () => {
    const { groups, memberUpdate } = makeService({ shareLocation: true });

    const out = await groups.playerMoved('Group', TOKEN, {
      name: 'IronJackery',
      coordinates: [3200.6, 3200.2],
    });

    expect(out).toMatchObject({
      ok: true,
      share_location: true,
      coordinates: [3201, 3200, 0],
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { x: 3201, y: 3200, online: true, inLobby: false, lastUpdated: expect.any(Date) },
      select: { plane: true },
    });
  });

  it('accepts a 2-element [x, y] without touching plane', async () => {
    const { groups, memberUpdate } = makeService({ shareLocation: true });

    await groups.playerMoved('Group', TOKEN, {
      name: 'IronJackery',
      coordinates: [100, 200],
    });

    const data = memberUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('plane');
  });

  it('accepts a 3-element [x, y, plane]', async () => {
    const { groups, memberUpdate } = makeService({ shareLocation: true });

    await groups.playerMoved('Group', TOKEN, {
      name: 'IronJackery',
      coordinates: [100, 200, 2],
    });

    const data = memberUpdate.mock.calls[0][0].data;
    expect(data.plane).toBe(2);
  });
});

describe('reportKills', () => {
  it('folds repeated npc names into one upsert with the summed kills', async () => {
    const { groups, npcKillUpsert, memberUpdate } = makeService();

    const out = await groups.reportKills('Group', TOKEN, {
      name: 'IronJackery',
      kills: [
        { npc: 'Goblin', kills: 2 },
        { npc: 'Goblin', kills: 3 },
      ],
    });

    expect(npcKillUpsert).toHaveBeenCalledTimes(1);
    expect(npcKillUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ kills: { increment: 5 } }),
      }),
    );
    expect(out.recorded).toBe(5);
    expect(memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ npcKillsTotal: { increment: 5 } }),
      }),
    );
  });

  it('skips entries with zero/negative kills or a blank npc name', async () => {
    const { groups, npcKillUpsert } = makeService();

    const out = await groups.reportKills('Group', TOKEN, {
      name: 'IronJackery',
      kills: [
        { npc: 'Goblin', kills: 0 },
        { npc: '  ', kills: 5 },
        { npc: 'Rat', kills: -1 },
      ],
    });

    expect(npcKillUpsert).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, recorded: 0, total: 0 });
  });
});

describe('setLocationSharing', () => {
  it('zeroes position when opting out', async () => {
    const { groups, memberUpdateMany } = makeService();

    await groups.setLocationSharing('Group', TOKEN, {
      name: 'IronJackery',
      shared: false,
    });

    expect(memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ x: 0, y: 0, plane: 0 }),
      }),
    );
  });

  it('leaves position fields untouched when opting in', async () => {
    const { groups, memberUpdateMany } = makeService();

    await groups.setLocationSharing('Group', TOKEN, {
      name: 'IronJackery',
      shared: true,
    });

    const data = memberUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('x');
    expect(data).not.toHaveProperty('y');
    expect(data).not.toHaveProperty('plane');
  });
});

describe('syncGroupMode', () => {
  it('is a no-op when the mode already matches', async () => {
    const { groups, groupUpdate } = makeService({
      mode: GroupMode.competitive,
    });

    const out = await groups.syncGroupMode('Group', TOKEN, {
      mode: 'competitive',
    });

    expect(groupUpdate).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, mode: 'competitive', changed: false });
  });

  it('writes and reports changed: true when the mode differs', async () => {
    const { groups, groupUpdate } = makeService({ mode: GroupMode.normal });

    const out = await groups.syncGroupMode('Group', TOKEN, {
      mode: 'competitive',
    });

    expect(groupUpdate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ok: true, mode: 'competitive', changed: true });
  });
});

describe('setMemberOnline', () => {
  it('forces in_lobby false whenever online is false', async () => {
    const { groups, memberUpdateMany } = makeService();

    const out = await groups.setMemberOnline('Group', TOKEN, {
      name: 'IronJackery',
      online: false,
      in_lobby: true,
    });

    expect(out.in_lobby).toBe(false);
    expect(memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ online: false, inLobby: false }),
      }),
    );
  });

  it('honours in_lobby when online is true', async () => {
    const { groups } = makeService();

    const out = await groups.setMemberOnline('Group', TOKEN, {
      name: 'IronJackery',
      online: true,
      in_lobby: true,
    });

    expect(out.in_lobby).toBe(true);
  });
});

describe('setTarget', () => {
  it('sets a target with hp/percent', async () => {
    const { groups, memberUpdateMany } = makeService();

    const out = await groups.setTarget('Group', TOKEN, {
      name: 'IronJackery',
      target: 'Vorkath',
      hp: 500,
      percent: 100,
    });

    expect(out).toMatchObject({ ok: true, target: 'Vorkath' });
    expect(memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetName: 'Vorkath' }),
      }),
    );
  });

  it('clears the target when none is given', async () => {
    const { groups, memberUpdateMany } = makeService();

    const out = await groups.setTarget('Group', TOKEN, {
      name: 'IronJackery',
    });

    expect(out).toMatchObject({ ok: true, target: null });
    expect(memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetName: null }),
      }),
    );
  });
});

describe('getNpcKills', () => {
  it('sums each member kills and sorts nothing special, just returns totals', async () => {
    const { groups } = makeService();

    const out = await groups.getNpcKills('Group', TOKEN);

    expect(out.members).toEqual([
      { name: 'IronJackery', total: 0, kills: [] },
    ]);
  });
});
