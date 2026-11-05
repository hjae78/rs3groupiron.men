import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { etagOf } from '../common/etag';

const ICON_SOURCE = 'https://chisel.weirdgloop.org/gazproj/icons/png';
const USER_AGENT =
  'rs3-group-ironman/1.0 (group ironman tracker; +https://rs3groupiron.men)';

/** Sprite names are gamevals, so anything outside this is not ours. */
const SAFE_NAME = /^[A-Za-z0-9_.()'-]+\.png$/;

export type Asset = { body: Buffer; etag: string };

/**
 * Serves the images the site needs from our own origin.
 *
 * Two sources sit behind this. Sprites extracted from the game cache and the
 * stack art mirrored from the wiki are both on disk, committed with the
 * catalogues. Item icons are not: they are rendered from 3D models by
 * weirdgloop's service, which sends no Cache-Control, ETag or Last-Modified at
 * all, so a browser has nothing to cache on and re-requests every icon on
 * every page load. Fetching each one once and holding it turns that into a
 * single request per icon for the whole site.
 */
@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly memory = new Map<string, Asset>();

  private get spriteDir(): string {
    return join(process.cwd(), 'data', 'sprites');
  }

  private get iconDir(): string {
    return (
      process.env.ICON_CACHE_DIR?.trim() ||
      join(process.cwd(), 'data', '.icon-cache')
    );
  }

  private hold(key: string, body: Buffer): Asset {
    const asset = {
      body,
      etag: etagOf(body),
    };
    this.memory.set(key, asset);
    return asset;
  }

  /** A sprite extracted from the cache, or mirrored stack art. */
  sprite(name: string): Asset | undefined {
    if (!SAFE_NAME.test(name) || normalize(name) !== name) return undefined;
    const key = `sprite:${name}`;
    const held = this.memory.get(key);
    if (held) return held;

    const path = join(this.spriteDir, name);
    if (!existsSync(path)) return undefined;
    return this.hold(key, readFileSync(path));
  }

  /**
   * An item icon, fetched from the renderer once and then served from disk.
   * Returns undefined when the item has no icon, which the caller turns into a
   * 404 rather than an empty image.
   */
  async icon(itemId: number): Promise<Asset | undefined> {
    if (!Number.isInteger(itemId) || itemId <= 0) return undefined;
    const key = `icon:${itemId}`;
    const held = this.memory.get(key);
    if (held) return held;

    const path = join(this.iconDir, `${itemId}.png`);
    if (existsSync(path)) return this.hold(key, readFileSync(path));

    try {
      const response = await fetch(`${ICON_SOURCE}/${itemId}.png`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length) return undefined;

      // Best effort: an unwritable cache dir costs a refetch, not an error.
      try {
        mkdirSync(this.iconDir, { recursive: true });
        writeFileSync(path, body);
      } catch (err) {
        this.logger.warn(`icon ${itemId}: could not cache to disk`, err);
      }
      return this.hold(key, body);
    } catch (err) {
      this.logger.warn(`icon ${itemId}: fetch failed`, err);
      return undefined;
    }
  }
}
