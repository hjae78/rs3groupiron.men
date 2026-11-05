import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etagOf } from '../common/etag';

type Loaded = {
  body: string;
  etag: string;
  count: number;
  revision: number;
  updated: string;
};

const EMPTY: Loaded = {
  body: '{"updated":"","revision":0,"count":0}',
  etag: '"empty"',
  count: 0,
  revision: 0,
  updated: '',
};

/**
 * Static catalogues generated from a cache dump that the API only ever hands
 * back verbatim: NPC names and achievements.
 *
 * They are read once at boot and kept as pre-serialised strings, because every
 * caller gets identical bytes and re-encoding ~640KB per request would cost
 * more than the read. Each file carries the cache revision it came from, which
 * is logged so a stale deploy is visible.
 */
@Injectable()
export class CatalogueService implements OnModuleInit {
  private readonly logger = new Logger(CatalogueService.name);
  private readonly loaded = new Map<string, Loaded>();

  onModuleInit() {
    this.load('npc-names', 'npc-names.json', 'names');
    this.load('achievements', 'achievements.json', 'achievements');
  }

  /** `key` names the catalogue; `field` is the map inside the file. */
  load(key: string, file: string, field: string) {
    const path = join(process.cwd(), 'data', file);
    if (!existsSync(path)) {
      this.logger.warn(`${key}: ${path} missing, served empty`);
      this.loaded.set(key, EMPTY);
      return;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const body = raw as Record<string, unknown>;
      const entries = body[field];
      if (!entries || typeof entries !== 'object') {
        throw new Error(`missing "${field}" object`);
      }
      const text = JSON.stringify(raw);
      const revision = Number(body.revision) || 0;
      const updated = typeof body.updated === 'string' ? body.updated : '';
      this.loaded.set(key, {
        body: text,
        etag: etagOf(text),
        count: Object.keys(entries).length,
        revision,
        updated,
      });
      this.logger.log(
        `${key}: ${Object.keys(entries).length} entries (revision ${revision || '?'}, updated ${updated || 'unknown'})`,
      );
    } catch (err) {
      this.logger.error(`${key}: failed to load ${path}`, err);
      this.loaded.set(key, EMPTY);
    }
  }

  payload(key: string): { body: string; etag: string } {
    return this.loaded.get(key) ?? EMPTY;
  }

  describe(): Array<{ key: string; count: number; revision: number; updated: string }> {
    return [...this.loaded.entries()].map(([key, entry]) => ({
      key,
      count: entry.count,
      revision: entry.revision,
      updated: entry.updated,
    }));
  }
}
