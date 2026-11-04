import { Injectable, Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../uploads/r2.service';
import { ZipWriter } from '../common/zip';
import { deletionStatus } from './group-deletion';
import { groupNameKey, sharesScope } from './group-access.service';
import { SHARED_MEMBER } from './group.types';
import { rowsToPairs } from './item-codec';
import { PLAYER_DELETION_GRACE_MS } from './player-deletion';

const PLAYER_DELETION_GRACE_HOURS = PLAYER_DELETION_GRACE_MS / (60 * 60 * 1000);

export const EXPORT_VERSION = 1;

/** Rows read per query when walking an unbounded table. */
const PAGE = 5000;

/**
 * Hard stop per time series. Nothing real approaches it — it exists so a
 * pathological group cannot make one request read the table forever.
 */
const MAX_SERIES_ROWS = 2_000_000;

const CONTACT = 'privacy@rs3groupiron.men';
const SITE = 'https://rs3groupiron.men';

type Counts = {
  xp_samples: number;
  bank_ledger: number;
  achievement_feed: number;
  screenshots: number;
};

export type MemberFilter = { memberId: string; usernames: string[] };

type WriteOptions = {
  filter?: MemberFilter;
  pathPrefix?: string;
  scope?: 'group' | 'player';
};

@Injectable()
export class GroupExportService {
  private readonly logger = new Logger(GroupExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  /**
   * Everything about a group whose size is bounded by the group itself:
   * settings, members, skills, inventories, quests, achievements, kill counts,
   * drop rules and view days. The three append-only series and the screenshots
   * are not in here — they are what the ZIP adds.
   */
  async buildStateDocument(groupName: string, filter?: MemberFilter) {
    const group = await this.prisma.group.findUnique({
      where: { nameKey: groupNameKey(groupName) },
      select: {
        id: true,
        name: true,
        mode: true,
        appearance: true,
        memberSlots: true,
        dropThreshold: true,
        visibility: true,
        publicMap: true,
        publicSkills: true,
        publicItems: true,
        publicQuests: true,
        publicAchievements: true,
        viewsTotal: true,
        createdAt: true,
        deletionRequestedAt: true,
        deleteAfter: true,
      },
    });
    if (!group) return null;

    const [members, groupInventories, rareItems, viewDays] = await Promise.all([
      this.prisma.member.findMany({
        where: {
          groupId: group.id,
          name: { not: SHARED_MEMBER },
          ...(filter ? { id: filter.memberId } : {}),
        },
        orderBy: { name: 'asc' },
        include: {
          skills: { orderBy: { skillId: 'asc' } },
          inventories: { include: { items: true }, orderBy: { key: 'asc' } },
          quests: { orderBy: { gameval: 'asc' } },
          completedAchievements: { orderBy: { gameval: 'asc' } },
          achievementTallies: { orderBy: { gameval: 'asc' } },
          npcKills: { orderBy: { kills: 'desc' } },
        },
      }),
      this.prisma.groupInventory.findMany({
        where: { groupId: group.id },
        include: { items: true },
        orderBy: { key: 'asc' },
      }),
      this.prisma.groupRareItem.findMany({
        where: { groupId: group.id },
        orderBy: { itemId: 'asc' },
      }),
      this.prisma.groupViewDay.findMany({
        where: { groupId: group.id },
        orderBy: { day: 'asc' },
      }),
    ]);

    return {
      groupId: group.id,
      document: {
        export_version: EXPORT_VERSION,
        generated_at: new Date().toISOString(),
        service: {
          name: 'RS3 Group Ironman',
          site: SITE,
          privacy_notice: `${SITE}/privacy`,
          data_protection_contact: CONTACT,
        },
        group: {
          name: group.name,
          mode: group.mode,
          appearance: group.appearance,
          member_slots: group.memberSlots,
          visibility: group.visibility,
          shares: sharesScope(group),
          drop_threshold: group.dropThreshold,
          views_total: group.viewsTotal,
          created_at: group.createdAt.toISOString(),
          deletion: deletionStatus(group),
        },
        members: members.map((member) => ({
          name: member.name,
          nickname: member.nickname,
          discord_id: member.discordId,
          color: member.color,
          use_discord_avatar: member.useDiscordAvatar,
          online: member.online,
          in_lobby: member.inLobby,
          share_location: member.shareLocation,
          position: {
            x: member.x,
            y: member.y,
            plane: member.plane,
            world: member.world,
          },
          vitals: {
            hp_current: member.hpCurrent,
            hp_max: member.hpMax,
            prayer_current: member.prayerCurrent,
            prayer_max: member.prayerMax,
            summon_current: member.summonCurrent,
            summon_max: member.summonMax,
            weight: member.weight,
          },
          target: member.targetName
            ? {
                name: member.targetName,
                hp: member.targetHp,
                percent: member.targetPercent,
                at: member.targetAt?.toISOString() ?? null,
              }
            : null,
          npc_kills_total: member.npcKillsTotal,
          baseline_at: member.baselineAt?.toISOString() ?? null,
          last_updated: member.lastUpdated.toISOString(),
          data_updated_at: member.dataUpdatedAt.toISOString(),
          skills: member.skills.map((skill) => ({
            id: skill.skillId,
            // Serialised as a string: XP tops out at 200m per skill, which fits
            // a double, but the column is a bigint and JSON.stringify refuses
            // one outright.
            xp: skill.xp.toString(),
            level: skill.level,
            base_level: skill.baseLevel,
          })),
          inventories: Object.fromEntries(
            member.inventories.map((inv) => [
              inv.key,
              {
                updated_at: inv.updatedAt.toISOString(),
                items: rowsToPairs(inv.items),
              },
            ]),
          ),
          quests: member.quests.map((quest) => ({
            gameval: quest.gameval,
            state: quest.state,
            updated_at: quest.updatedAt.toISOString(),
          })),
          achievements_completed: member.completedAchievements.map((row) => ({
            gameval: row.gameval,
            updated_at: row.updatedAt.toISOString(),
          })),
          achievements_in_progress: member.achievementTallies.map((row) => ({
            gameval: row.gameval,
            progress: row.progress,
            target: row.target,
            updated_at: row.updatedAt.toISOString(),
          })),
          npc_kills: member.npcKills.map((row) => ({
            npc: row.npcName,
            kills: row.kills,
            last_at: row.lastAt.toISOString(),
          })),
        })),
        ...(filter
          ? {}
          : {
              shared_bank: Object.fromEntries(
                groupInventories.map((inv) => [
                  inv.key,
                  {
                    updated_at: inv.updatedAt.toISOString(),
                    items: rowsToPairs(inv.items),
                  },
                ]),
              ),
              drop_rules: {
                threshold: group.dropThreshold,
                items: rareItems.map((row) => ({
                  item_id: row.itemId,
                  include: row.include,
                  min_qty: row.minQty,
                  max_qty: row.maxQty,
                  created_at: row.createdAt.toISOString(),
                })),
              },
              view_days: viewDays.map((row) => ({
                day: row.day.toISOString().slice(0, 10),
                views: row.views,
              })),
            }),
      },
    };
  }

  /**
   * Writes the whole archive to `out`, one entry at a time.
   *
   * The series are walked in pages and the screenshots fetched one by one, so
   * the peak cost is a single entry rather than the finished file. The caller
   * has already sent headers, so a failure part-way can only truncate the
   * download — which is why nothing here is left to throw silently.
   */
  async writeArchive(
    out: Writable,
    groupName: string,
    state: { groupId: string; document: unknown },
  ): Promise<Counts> {
    const zip = new ZipWriter(out);
    const counts = await this.writeGroupEntries(
      zip,
      groupName,
      state,
      new Date(),
    );
    await zip.finish();
    return counts;
  }

  async writeGroupEntries(
    zip: ZipWriter,
    groupName: string,
    state: { groupId: string; document: unknown },
    at: Date,
    options: WriteOptions = {},
  ): Promise<Counts> {
    const prefix = options.pathPrefix ?? '';
    const counts: Counts = {
      xp_samples: 0,
      bank_ledger: 0,
      achievement_feed: 0,
      screenshots: 0,
    };

    await zip.addText(
      `${prefix}group.json`,
      `${JSON.stringify(state.document, null, 2)}\n`,
      { at },
    );

    counts.bank_ledger = await this.writeLedger(
      zip,
      state.groupId,
      at,
      prefix,
      options.filter,
    );
    const feed = await this.writeFeed(
      zip,
      state.groupId,
      at,
      prefix,
      options.filter,
    );
    counts.achievement_feed = feed.rows;
    counts.xp_samples = await this.writeXpSamples(
      zip,
      state.groupId,
      at,
      prefix,
      options.filter,
    );
    counts.screenshots = await this.writeScreenshots(
      zip,
      feed.images,
      at,
      prefix,
    );

    await zip.addText(
      `${prefix}README.txt`,
      readme(groupName, counts, at, options.scope ?? 'group'),
      { at },
    );
    return counts;
  }

  private async writeLedger(
    zip: ZipWriter,
    groupId: string,
    at: Date,
    prefix: string,
    filter?: MemberFilter,
  ) {
    const lines: string[] = [];
    let cursor: string | undefined;
    let rows = 0;
    for (;;) {
      const page = await this.prisma.sharedBankEntry.findMany({
        where: {
          groupId,
          ...(filter
            ? { memberName: { in: filter.usernames, mode: 'insensitive' } }
            : {}),
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!page.length) break;
      for (const row of page) {
        lines.push(
          JSON.stringify({
            at: row.createdAt.toISOString(),
            member_name: row.memberName,
            item_id: row.itemId,
            delta: row.delta,
          }),
        );
      }
      rows += page.length;
      cursor = page[page.length - 1].id;
      if (page.length < PAGE || rows >= MAX_SERIES_ROWS) break;
    }
    await zip.addText(`${prefix}bank-ledger.ndjson`, join(lines), { at });
    return rows;
  }

  private async writeFeed(
    zip: ZipWriter,
    groupId: string,
    at: Date,
    prefix: string,
    filter?: MemberFilter,
  ) {
    const lines: string[] = [];
    const images: Array<{ url: string; file: string }> = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let rows = 0;

    for (;;) {
      const page = await this.prisma.achievement.findMany({
        where: {
          groupId,
          ...(filter
            ? { memberName: { in: filter.usernames, mode: 'insensitive' } }
            : {}),
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!page.length) break;
      for (const row of page) {
        let file: string | null = null;
        if (row.imageUrl) {
          const path = screenshotPath(row.imageUrl, row.kind, seen);
          if (path) {
            file = `${prefix}${path}`;
            images.push({ url: row.imageUrl, file });
          }
        }
        lines.push(
          JSON.stringify({
            at: row.achievedAt.toISOString(),
            member_name: row.memberName,
            kind: row.kind,
            title: row.title,
            detail: row.detail,
            skill_id: row.skillId,
            item_id: row.itemId,
            quantity: row.quantity,
            gameval: row.gameval,
            image_url: row.imageUrl,
            image_file: file,
          }),
        );
      }
      rows += page.length;
      cursor = page[page.length - 1].id;
      if (page.length < PAGE || rows >= MAX_SERIES_ROWS) break;
    }

    await zip.addText(`${prefix}achievement-feed.ndjson`, join(lines), { at });
    return { rows, images };
  }

  private async writeXpSamples(
    zip: ZipWriter,
    groupId: string,
    at: Date,
    prefix: string,
    filter?: MemberFilter,
  ) {
    const members = await this.prisma.member.findMany({
      where: {
        groupId,
        ...(filter ? { id: filter.memberId } : {}),
      },
      select: { id: true, name: true },
    });
    const nameById = new Map(members.map((m) => [m.id, m.name]));
    if (!members.length) {
      await zip.addText(`${prefix}xp-samples.ndjson`, '', { at });
      return 0;
    }

    const lines: string[] = [];
    let cursor: string | undefined;
    let rows = 0;
    for (;;) {
      const page = await this.prisma.skillXpSample.findMany({
        where: { memberId: { in: [...nameById.keys()] } },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!page.length) break;
      for (const row of page) {
        lines.push(
          JSON.stringify({
            member_name: nameById.get(row.memberId) ?? null,
            skill_id: row.skillId,
            xp: row.xp.toString(),
            sampled_at: row.sampledAt.toISOString(),
          }),
        );
      }
      rows += page.length;
      cursor = page[page.length - 1].id;
      if (page.length < PAGE || rows >= MAX_SERIES_ROWS) break;
    }

    await zip.addText(`${prefix}xp-samples.ndjson`, join(lines), { at });
    return rows;
  }

  private async writeScreenshots(
    zip: ZipWriter,
    images: Array<{ url: string; file: string }>,
    at: Date,
    prefix: string,
  ) {
    if (!images.length || !this.r2.isConfigured()) return 0;
    let written = 0;
    const missing: string[] = [];

    for (const image of images) {
      const key = this.r2.keyForPublicUrl(image.url);
      if (!key) {
        missing.push(image.url);
        continue;
      }
      try {
        const body = await this.r2.readObject(key);
        if (!body) {
          missing.push(image.url);
          continue;
        }
        // PNGs are already compressed, so storing avoids a pointless deflate
        // pass over every screenshot.
        await zip.add(image.file, body, { at });
        written += 1;
      } catch (err) {
        missing.push(image.url);
        this.logger.warn(
          `export: could not read ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (missing.length) {
      await zip.addText(
        `${prefix}screenshots/MISSING.txt`,
        'These screenshots are referenced by the achievement feed but could ' +
          'not be read back from storage, so they are not in this archive:\n\n' +
          `${missing.join('\n')}\n`,
        { at },
      );
    }
    return written;
  }
}

function join(lines: string[]) {
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Keeps the CDN's folder/filename so a screenshot in the archive can be matched
 * back to its `image_url`, while guaranteeing a unique, traversal-free path.
 */
function screenshotPath(
  url: string,
  kind: string,
  seen: Set<string>,
): string | null {
  let name: string;
  try {
    name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return null;
  }
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') return null;

  let candidate = `screenshots/${kind}/${safe}`;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `screenshots/${kind}/${n}-${safe}`;
    n += 1;
  }
  seen.add(candidate);
  return candidate;
}

/**
 * Only described when there is something to describe. Nothing in the client or
 * the plugin uploads a screenshot today, so for every real group this section
 * is absent rather than announcing an empty folder.
 */
function screenshotSection(counts: Counts) {
  if (counts.screenshots === 0) return '';
  return `  screenshots/             The ${counts.screenshots} screenshot(s) attached to
                           achievements, filed by kind. Each record in
                           achievement-feed.ndjson names its file in
                           "image_file".
`;
}

function readme(
  groupName: string,
  counts: Counts,
  at: Date,
  scope: 'group' | 'player' = 'group',
) {
  const forPlayer = scope === 'player';
  const summary = forPlayer
    ? 'This archive is your own records within this group, in machine-readable form.'
    : 'This archive is everything we hold about this group, in machine-readable form.';
  const groupJsonLine = forPlayer
    ? `  group.json               Your member entry: skills, inventories, quest and
                           achievement progress and NPC kill counts within
                           this group. Group-wide settings and the shared
                           bank are not included here — they are not your
                           own data; see the group's own Settings -> Your
                           data -> Export if you need those too.`
    : `  group.json               Group settings, members, skills, inventories and
                           bank contents, quest and achievement progress and
                           NPC kill counts: the group's current state.`;
  const deleting = forPlayer
    ? `  rs3groupiron.men/members -> Delete my data. It takes a retyped username,
  then erases everything above ${PLAYER_DELETION_GRACE_HOURS} hours later, across every group
  you belong to — not just this one. You can cancel inside that window.`
    : `  Settings -> Your data -> Delete group data. It takes two confirmations and
  your group name and token retyped, then erases everything above five days
  later. You can cancel inside those five days.`;

  return `RS3 Group Ironman — data export for "${groupName}"
Generated ${at.toISOString()}

${summary}
It is provided under your right to data portability (UK GDPR Article 20).

FILES

${groupJsonLine}
  bank-ledger.ndjson       Every shared-bank movement. ${counts.bank_ledger} record(s).
  achievement-feed.ndjson  Every achievement, drop, level and quest recorded.
                           ${counts.achievement_feed} record(s).
  xp-samples.ndjson        The experience time series behind the graphs.
                           ${counts.xp_samples} sample(s).
${screenshotSection(counts)}
".ndjson" is newline-delimited JSON: one self-contained JSON object per line.
Most tools read it directly; otherwise read the file a line at a time and parse
each line on its own.

NOT INCLUDED

  Your group token. It is the credential for this group, and an export is a
  file people forward and upload, so it is deliberately left out. You already
  have it, and it is shown under Settings -> Open setup.

  Server access logs. They are keyed by IP address rather than by group, so we
  cannot reliably tie them to you; see the privacy notice for how long they
  are kept.

DELETING THIS DATA

${deleting}

QUESTIONS

  ${CONTACT}
  ${SITE}/privacy
`;
}
