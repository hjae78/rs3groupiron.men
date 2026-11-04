import {
  ONLINE_STALE_MS,
  isOnline,
  toPartialWireMember,
  toWireMember,
  type MemberWithData,
} from './group-wire';

function fakeMember(
  overrides: Partial<MemberWithData> = {},
): MemberWithData {
  return {
    id: 'm1',
    groupId: 'g1',
    name: 'Woox',
    nickname: null,
    discordId: null,
    color: null,
    useDiscordAvatar: true,
    online: false,
    shareLocation: true,
    inLobby: false,
    targetName: null,
    targetHp: null,
    targetPercent: null,
    targetAt: null,
    npcKillsTotal: 0,
    baselineAt: null,
    lastUpdated: new Date(),
    dataUpdatedAt: new Date(),
    hpCurrent: 0,
    hpMax: 0,
    prayerCurrent: 0,
    prayerMax: 0,
    summonCurrent: 0,
    summonMax: 0,
    weight: 0,
    world: 0,
    x: 0,
    y: 0,
    plane: 0,
    playerId: null,
    player: null,
    inventories: [],
    skills: [],
    ...overrides,
  } as unknown as MemberWithData;
}

describe('isOnline', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const seenAgo = (ms: number) => new Date(now - ms);

  it('is online while the plugin has been heard from recently', () => {
    expect(isOnline({ online: true, lastUpdated: seenAgo(60_000) }, now)).toBe(
      true,
    );
  });

  it('goes offline once the plugin has been quiet too long', () => {
    expect(
      isOnline({ online: true, lastUpdated: seenAgo(ONLINE_STALE_MS) }, now),
    ).toBe(false);
  });

  it('never reports an explicitly offline member as online', () => {
    expect(isOnline({ online: false, lastUpdated: seenAgo(0) }, now)).toBe(
      false,
    );
  });
});

describe('toWireMember / toPartialWireMember verified flag', () => {
  it('is false for a member with no linked player', () => {
    expect(toWireMember(fakeMember()).verified).toBe(false);
    expect(toPartialWireMember(fakeMember()).verified).toBe(false);
  });

  it('is false for a linked but unverified player', () => {
    const member = fakeMember({
      player: { verificationStatus: 'unverified' },
    });
    expect(toWireMember(member).verified).toBe(false);
    expect(toPartialWireMember(member).verified).toBe(false);
  });

  it('is true only once the linked player is plugin_verified', () => {
    const member = fakeMember({
      player: { verificationStatus: 'plugin_verified' },
    });
    expect(toWireMember(member).verified).toBe(true);
    expect(toPartialWireMember(member).verified).toBe(true);
  });
});
