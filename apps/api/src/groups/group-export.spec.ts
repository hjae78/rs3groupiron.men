import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupExportService } from './group-export.service';
import { ZipWriter } from '../common/zip';
import type { PrismaService } from '../prisma/prisma.service';
import type { R2Service } from '../uploads/r2.service';

const CDN = 'https://cdn.rs3groupiron.men';

type Row = Record<string, unknown>;

/**
 * Returns every row on the first call and nothing afterwards, which is what a
 * cursor walk sees when the table fits in one page.
 */
function onePage(rows: Row[]) {
  let served = false;
  return jest.fn(() => {
    if (served) return Promise.resolve([]);
    served = true;
    return Promise.resolve(rows);
  });
}

function achievement(id: string, imageUrl: string | null, kind = 'drop'): Row {
  return {
    id,
    memberName: 'Zezima',
    kind,
    title: `Title ${id}`,
    detail: null,
    skillId: null,
    itemId: 4151,
    quantity: 1,
    gameval: null,
    imageUrl,
    achievedAt: new Date('2026-10-19T10:00:00.000Z'),
  };
}

type Fakes = {
  achievements?: Row[];
  ledger?: Row[];
  samples?: Row[];
  members?: Row[];
  objects?: Record<string, Buffer>;
  readObject?: jest.Mock;
  configured?: boolean;
  group?: Row | null;
  groupInventories?: Row[];
  rareItems?: Row[];
  viewDays?: Row[];
};

function build(fakes: Fakes = {}) {
  const objects = fakes.objects ?? {};
  const prisma = {
    sharedBankEntry: { findMany: onePage(fakes.ledger ?? []) },
    achievement: { findMany: onePage(fakes.achievements ?? []) },
    skillXpSample: { findMany: onePage(fakes.samples ?? []) },
    member: {
      findMany: jest.fn(() =>
        Promise.resolve(fakes.members ?? [{ id: 'm1', name: 'Zezima' }]),
      ),
    },
    group: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          fakes.group === undefined
            ? {
                id: 'g1',
                name: 'Iron Crew',
                mode: 'standard',
                appearance: null,
                memberSlots: 5,
                dropThreshold: 0,
                visibility: 'private',
                publicMap: false,
                publicSkills: false,
                publicItems: false,
                publicQuests: false,
                publicAchievements: false,
                viewsTotal: 0,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                deletionRequestedAt: null,
                deleteAfter: null,
              }
            : fakes.group,
        ),
      ),
    },
    groupInventory: {
      findMany: jest.fn(() => Promise.resolve(fakes.groupInventories ?? [])),
    },
    groupRareItem: {
      findMany: jest.fn(() => Promise.resolve(fakes.rareItems ?? [])),
    },
    groupViewDay: {
      findMany: jest.fn(() => Promise.resolve(fakes.viewDays ?? [])),
    },
  } as unknown as PrismaService;

  const r2 = {
    isConfigured: () => fakes.configured ?? true,
    keyForPublicUrl: (url: string) =>
      url.startsWith(`${CDN}/`) ? url.slice(CDN.length + 1) : null,
    readObject:
      fakes.readObject ??
      jest.fn((key: string) => Promise.resolve(objects[key] ?? null)),
  } as unknown as R2Service;

  return { service: new GroupExportService(prisma, r2), prisma, r2 };
}

async function archive(service: GroupExportService) {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk: Buffer) => chunks.push(chunk));
  const counts = await service.writeArchive(out, 'Iron Crew', {
    groupId: 'g1',
    document: { group: { name: 'Iron Crew' } },
  });
  out.end();
  return { bytes: Buffer.concat(chunks), counts };
}

/** Reads the archive back with Python's zipfile, an independent implementation. */
function entries(bytes: Buffer): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  try {
    const file = join(dir, 'a.zip');
    writeFileSync(file, bytes);
    const script =
      'import sys,zipfile,json,base64;' +
      'z=zipfile.ZipFile(sys.argv[1]);' +
      'assert z.testzip() is None;' +
      'print(json.dumps({i.filename: base64.b64encode(z.read(i.filename)).decode() ' +
      'for i in z.infolist()}))';
    const out = execFileSync('python', ['-c', script, file], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const raw = JSON.parse(out) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(raw).map(([name, b64]) => [
        name,
        Buffer.from(b64, 'base64').toString('binary'),
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('GroupExportService.writeArchive', () => {
  it('always writes the documented set of files', async () => {
    const { service } = build();
    const { bytes, counts } = await archive(service);
    const files = entries(bytes);

    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'achievement-feed.ndjson',
      'bank-ledger.ndjson',
      'group.json',
      'xp-samples.ndjson',
    ]);
    expect(counts).toEqual({
      xp_samples: 0,
      bank_ledger: 0,
      achievement_feed: 0,
      screenshots: 0,
    });
    // An empty series is an empty file, not a missing one, so a reader never
    // has to tell "no data" apart from "not exported".
    expect(files['xp-samples.ndjson']).toBe('');
    expect(files['group.json']).toContain('"Iron Crew"');
  });

  it('puts screenshot bytes in the archive under the feed’s image_file', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]);
    const { service } = build({
      achievements: [achievement('a1', `${CDN}/achievements/g1/drops/one.png`)],
      objects: { 'achievements/g1/drops/one.png': png },
    });

    const { bytes, counts } = await archive(service);
    const files = entries(bytes);

    expect(counts.screenshots).toBe(1);
    const feed = JSON.parse(files['achievement-feed.ndjson'].trim()) as {
      image_file: string;
    };
    expect(feed.image_file).toBe('screenshots/drop/one.png');
    expect(Buffer.from(files[feed.image_file], 'binary').equals(png)).toBe(true);
    expect(files['screenshots/MISSING.txt']).toBeUndefined();
  });

  it('keeps both screenshots when two achievements share a filename', async () => {
    const a = Buffer.from([1, 1, 1]);
    const b = Buffer.from([2, 2, 2]);
    const { service } = build({
      achievements: [
        achievement('a1', `${CDN}/achievements/g1/drops/shot.png`),
        achievement('a2', `${CDN}/achievements/g2/drops/shot.png`),
      ],
      objects: {
        'achievements/g1/drops/shot.png': a,
        'achievements/g2/drops/shot.png': b,
      },
    });

    const { bytes, counts } = await archive(service);
    const files = entries(bytes);

    expect(counts.screenshots).toBe(2);
    expect(files['screenshots/drop/shot.png']).toBeDefined();
    expect(files['screenshots/drop/2-shot.png']).toBeDefined();
    expect(
      Buffer.from(files['screenshots/drop/shot.png'], 'binary').equals(a),
    ).toBe(true);
    expect(
      Buffer.from(files['screenshots/drop/2-shot.png'], 'binary').equals(b),
    ).toBe(true);
  });

  it('lists screenshots it could not read instead of failing the export', async () => {
    const good = Buffer.from([9, 9]);
    const { service } = build({
      achievements: [
        achievement('a1', `${CDN}/achievements/g1/drops/here.png`),
        achievement('a2', `${CDN}/achievements/g1/drops/gone.png`),
        achievement('a3', 'https://example.com/offsite.png'),
      ],
      objects: { 'achievements/g1/drops/here.png': good },
    });

    const { bytes, counts } = await archive(service);
    const files = entries(bytes);

    expect(counts.screenshots).toBe(1);
    expect(files['screenshots/drop/here.png']).toBeDefined();
    const missing = files['screenshots/MISSING.txt'];
    expect(missing).toContain('gone.png');
    expect(missing).toContain('https://example.com/offsite.png');
    expect(missing).not.toContain('here.png');
  });

  it('survives storage throwing part-way through', async () => {
    const readObject = jest.fn((key: string) => {
      if (key.endsWith('boom.png')) {
        return Promise.reject(new Error('connection reset'));
      }
      return Promise.resolve(Buffer.from([7]));
    });
    const { service } = build({
      achievements: [
        achievement('a1', `${CDN}/achievements/g1/drops/boom.png`),
        achievement('a2', `${CDN}/achievements/g1/drops/fine.png`),
      ],
      readObject,
    });

    const { bytes, counts } = await archive(service);
    const files = entries(bytes);

    expect(counts.screenshots).toBe(1);
    expect(files['screenshots/drop/fine.png']).toBeDefined();
    expect(files['screenshots/MISSING.txt']).toContain('boom.png');
  });

  it('skips storage entirely when R2 is not configured', async () => {
    const readObject = jest.fn();
    const { service } = build({
      configured: false,
      readObject,
      achievements: [achievement('a1', `${CDN}/achievements/g1/drops/x.png`)],
    });

    const { counts } = await archive(service);
    expect(counts.screenshots).toBe(0);
    expect(readObject).not.toHaveBeenCalled();
  });

  it('writes one NDJSON line per row, with bigint XP as a string', async () => {
    const { service } = build({
      ledger: [
        {
          id: 'l1',
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          memberName: 'Zezima',
          itemId: 995,
          delta: -500,
        },
      ],
      samples: [
        {
          id: 's1',
          memberId: 'm1',
          skillId: 'attack',
          xp: 13034431n,
          sampledAt: new Date('2026-10-02T00:00:00.000Z'),
        },
        {
          id: 's2',
          memberId: 'unknown',
          skillId: 'magic',
          xp: 1n,
          sampledAt: new Date('2026-10-03T00:00:00.000Z'),
        },
      ],
    });

    const { bytes, counts } = await archive(service);
    const files = entries(bytes);

    expect(counts).toMatchObject({ bank_ledger: 1, xp_samples: 2 });
    expect(JSON.parse(files['bank-ledger.ndjson'].trim())).toEqual({
      at: '2026-10-01T00:00:00.000Z',
      member_name: 'Zezima',
      item_id: 995,
      delta: -500,
    });

    const lines = files['xp-samples.ndjson'].trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      member_name: 'Zezima',
      skill_id: 'attack',
      xp: '13034431',
      sampled_at: '2026-10-02T00:00:00.000Z',
    });
    // A sample whose member row is gone still exports, with a null name rather
    // than being dropped on the floor.
    expect(JSON.parse(lines[1])).toMatchObject({ member_name: null });
  });

  it('leaves screenshots out of the README when there are none', async () => {
    const { service } = build();
    const { bytes } = await archive(service);
    const readme = entries(bytes)['README.txt'];

    expect(readme).toContain('xp-samples.ndjson');
    expect(readme).not.toContain('screenshots/');
    expect(readme).not.toContain('screenshot');
  });

  it('describes screenshots in the README once the archive has some', async () => {
    const { service } = build({
      achievements: [achievement('a1', `${CDN}/achievements/g1/drops/one.png`)],
      objects: { 'achievements/g1/drops/one.png': Buffer.from([1]) },
    });
    const { bytes } = await archive(service);
    const readme = entries(bytes)['README.txt'];

    expect(readme).toContain('The 1 screenshot(s) attached to');
    expect(readme).toContain('image_file');
  });

  it('never writes the group token into the archive', async () => {
    const { service } = build();
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    await service.writeArchive(out, 'Iron Crew', {
      groupId: 'g1',
      document: { group: { name: 'Iron Crew' } },
    });
    out.end();

    const text = entries(Buffer.concat(chunks));
    const readme = text['README.txt'];
    expect(readme).toContain('Your group token');
    expect(readme).toContain('deliberately left out');
  });
});

function fullMember(overrides: Row = {}): Row {
  return {
    id: 'm1',
    name: 'Zezima',
    nickname: null,
    discordId: null,
    color: null,
    useDiscordAvatar: false,
    online: false,
    inLobby: false,
    shareLocation: false,
    x: null,
    y: null,
    plane: null,
    world: null,
    hpCurrent: null,
    hpMax: null,
    prayerCurrent: null,
    prayerMax: null,
    summonCurrent: null,
    summonMax: null,
    weight: null,
    targetName: null,
    targetHp: null,
    targetPercent: null,
    targetAt: null,
    npcKillsTotal: 0,
    baselineAt: null,
    lastUpdated: new Date('2026-01-01T00:00:00.000Z'),
    dataUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
    skills: [],
    inventories: [],
    quests: [],
    completedAchievements: [],
    achievementTallies: [],
    npcKills: [],
    ...overrides,
  };
}

describe('GroupExportService.buildStateDocument (member filter)', () => {
  it('scopes the member query to one member and omits group-level sections', async () => {
    const { service, prisma } = build({
      members: [fullMember()],
    });

    const state = await service.buildStateDocument('Iron Crew', {
      memberId: 'm1',
      usernames: ['Zezima'],
    });

    expect(
      (prisma.member.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ id: 'm1' });
    const doc = state!.document as Record<string, unknown>;
    expect(doc.shared_bank).toBeUndefined();
    expect(doc.drop_rules).toBeUndefined();
    expect(doc.view_days).toBeUndefined();
    expect(doc.members).toHaveLength(1);
  });

  it('includes group-level sections for the unfiltered (real group) export', async () => {
    const { service } = build({ members: [fullMember()] });

    const state = await service.buildStateDocument('Iron Crew');

    const doc = state!.document as Record<string, unknown>;
    expect(doc.shared_bank).toBeDefined();
    expect(doc.drop_rules).toBeDefined();
    expect(doc.view_days).toBeDefined();
  });
});

describe('GroupExportService.writeGroupEntries (filter + pathPrefix)', () => {
  it('filters the ledger, feed and xp-sample queries to the given member', async () => {
    const { service, prisma } = build({ members: [fullMember()] });
    const zip = new ZipWriter(new PassThrough());
    const at = new Date();

    await service.writeGroupEntries(
      zip,
      'Iron Crew',
      { groupId: 'g1', document: { group: { name: 'Iron Crew' } } },
      at,
      { filter: { memberId: 'm1', usernames: ['Zezima', 'OldZezima'] } },
    );

    expect(
      (prisma.sharedBankEntry.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({
      memberName: { in: ['Zezima', 'OldZezima'], mode: 'insensitive' },
    });
    expect(
      (prisma.achievement.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({
      memberName: { in: ['Zezima', 'OldZezima'], mode: 'insensitive' },
    });
    expect(
      (prisma.member.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ id: 'm1' });
  });

  it('puts every entry under the given path prefix', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { service } = build({
      achievements: [achievement('a1', `${CDN}/achievements/g1/drops/one.png`)],
      objects: { 'achievements/g1/drops/one.png': png },
    });

    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    const zip = new ZipWriter(out);
    await service.writeGroupEntries(
      zip,
      'Iron Crew',
      { groupId: 'g1', document: { group: { name: 'Iron Crew' } } },
      new Date(),
      { pathPrefix: 'Iron Crew/', scope: 'player' },
    );
    await zip.finish();
    out.end();

    const files = entries(Buffer.concat(chunks));
    expect(Object.keys(files).sort()).toEqual([
      'Iron Crew/README.txt',
      'Iron Crew/achievement-feed.ndjson',
      'Iron Crew/bank-ledger.ndjson',
      'Iron Crew/group.json',
      'Iron Crew/screenshots/drop/one.png',
      'Iron Crew/xp-samples.ndjson',
    ]);
    const feed = JSON.parse(
      files['Iron Crew/achievement-feed.ndjson'].trim(),
    ) as { image_file: string };
    expect(feed.image_file).toBe('Iron Crew/screenshots/drop/one.png');
    expect(files['Iron Crew/README.txt']).toContain('rs3groupiron.men/members');
  });
});
