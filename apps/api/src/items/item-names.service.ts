import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etagOf } from '../common/etag';

type ItemRecord = {
  name: string;
  /** Traded on the Grand Exchange (the cache's `stockmarket` flag). */
  ge?: boolean;
  /** Base cache value; high alch derives from this. */
  cost?: number;
  members?: boolean;
  stackable?: boolean;
  /** High/low alchemy, from the wiki where published and derived from `cost` otherwise. */
  alchHigh?: number;
  alchLow?: number;
  /**
   * [variant item id, from this quantity up, wiki image file]. RS3 swaps the
   * icon as a stack grows; the third element is absent when the wiki has no
   * art for that step.
   */
  counts?: Array<[number, number, string?]>;
};

/**
 * The item catalogue, read from `data/items.json` at boot.
 *
 * Generated from a cache dump by `tools/build-catalogue.mjs`; regenerate it
 * after a game update to pick up new items. Item ids are permanent in RS3, so
 * this is a static catalogue rather than group data.
 *
 * Clients are served names only. The full records are several times larger and
 * nothing on the site needs `counts` or `members` yet, so the rest stays
 * server-side until something asks for it.
 *
 * Override the file with ITEM_NAMES_FILE. A missing or broken file logs and
 * yields an empty catalogue, which only means clients fall back to "Item <id>".
 */
@Injectable()
export class ItemNamesService implements OnModuleInit {
  private readonly logger = new Logger(ItemNamesService.name);
  private items: Record<number, ItemRecord> = {};
  private updated = '';
  private revision = 0;
  private body = '';
  private tag = '';
  private stacksBody = '';
  private stacksTag = '';
  private alchBody = '';
  private alchTag = '';

  onModuleInit() {
    this.load(
      process.env.ITEM_NAMES_FILE?.trim() ||
        join(process.cwd(), 'data', 'items.json'),
    );
  }

  /** Exposed so tests can point at a fixture. */
  load(path: string) {
    if (!existsSync(path)) {
      this.logger.warn(`items: ${path} missing, clients show raw ids`);
      this.reset();
      return;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const file = raw as {
        items?: unknown;
        updated?: unknown;
        revision?: unknown;
      };
      if (!file.items || typeof file.items !== 'object') {
        throw new Error('missing "items" object');
      }

      const items: Record<number, ItemRecord> = {};
      for (const [key, value] of Object.entries(
        file.items as Record<string, unknown>,
      )) {
        const id = Number(key);
        const record = value as ItemRecord | undefined;
        if (!Number.isInteger(id) || id <= 0) continue;
        if (!record || typeof record.name !== 'string' || !record.name) continue;
        items[id] = record;
      }

      this.items = items;
      this.updated = typeof file.updated === 'string' ? file.updated : '';
      this.revision = Number(file.revision) || 0;
      this.publish();
      this.logger.log(
        `items: ${Object.keys(items).length} entries (revision ${this.revision || '?'}, updated ${this.updated || 'unknown'})`,
      );
    } catch (err) {
      this.logger.error(`items: failed to load ${path}`, err);
      this.reset();
    }
  }

  private reset() {
    this.items = {};
    this.updated = '';
    this.revision = 0;
    this.publish();
  }

  /**
   * The names payload is ~1.3MB and identical for every caller, so it is
   * serialised once at boot rather than rebuilt per request.
   */
  private publish() {
    const names: Record<number, string> = {};
    // Only the steps that actually have art; a step the wiki is missing would
    // just make the client fall back, so it need not travel.
    const stacks: Record<number, Array<[number, string]>> = {};
    // [high, low]; low is omitted when it equals the usual 2/3 of high.
    const alch: Record<number, [number, number?]> = {};

    for (const [key, record] of Object.entries(this.items)) {
      const id = Number(key);
      names[id] = record.name;
      if (record.alchHigh !== undefined) {
        alch[id] =
          record.alchLow === undefined
            ? [record.alchHigh]
            : [record.alchHigh, record.alchLow];
      }
      const steps = (record.counts ?? [])
        .filter((count): count is [number, number, string] => !!count[2])
        .map(([, from, file]) => [from, file] as [number, string])
        .sort((a, b) => a[0] - b[0]);
      if (steps.length) stacks[id] = steps;
    }

    this.body = JSON.stringify({
      updated: this.updated,
      revision: this.revision,
      count: Object.keys(names).length,
      names,
    });
    this.tag = etagOf(this.body);

    this.stacksBody = JSON.stringify({
      updated: this.updated,
      revision: this.revision,
      count: Object.keys(stacks).length,
      // Served from our own mirror. The file names keep the wiki's version
      // marker as a query string, which the route ignores but the browser
      // treats as a new URL whenever the art is redrawn.
      base: '/api/sprites/',
      stacks,
    });
    this.stacksTag = etagOf(this.stacksBody);

    this.alchBody = JSON.stringify({
      updated: this.updated,
      revision: this.revision,
      count: Object.keys(alch).length,
      alch,
    });
    this.alchTag = etagOf(this.alchBody);
  }

  nameOf(itemId: number): string | undefined {
    return this.items[itemId]?.name;
  }

  /** Whether the Grand Exchange trades this item at all. */
  tradeable(itemId: number): boolean {
    return this.items[itemId]?.ge === true;
  }

  /** Base cache value, which high alch is derived from. */
  costOf(itemId: number): number {
    return this.items[itemId]?.cost ?? 0;
  }

  get count(): number {
    return Object.keys(this.items).length;
  }

  get updatedAt(): string {
    return this.updated;
  }

  get cacheRevision(): number {
    return this.revision;
  }

  /** Pre-serialised names catalogue plus its ETag. */
  get payload(): { body: string; etag: string } {
    return { body: this.body, etag: this.tag };
  }

  /** Stack-size icon steps, for items whose art changes with quantity. */
  get stacksPayload(): { body: string; etag: string } {
    return { body: this.stacksBody, etag: this.stacksTag };
  }

  /** High/low alchemy values as `{ id: [high, low?] }`. */
  get alchPayload(): { body: string; etag: string } {
    return { body: this.alchBody, etag: this.alchTag };
  }

  alchFor(itemId: number): { high: number; low: number } | undefined {
    const record = this.items[itemId];
    if (record?.alchHigh === undefined) return undefined;
    return {
      high: record.alchHigh,
      low: record.alchLow ?? Math.floor((record.alchHigh * 2) / 3),
    };
  }
}
