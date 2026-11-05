import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { etagOf } from '../common/etag';

const DEFAULT_URL = 'https://prices.runescape.wiki/api/v2/rs/latest';
const DEFAULT_REFRESH_MS = 12 * 60 * 60 * 1000;

/**
 * The wiki asks only that automated callers identify themselves, and blocks
 * default agents like curl/* and python-requests. Deliberately a project URL
 * rather than a personal address.
 */
const USER_AGENT =
  'rs3-group-ironman/1.0 (group ironman tracker; +https://rs3groupiron.men)';

/** Coins are not traded on the GE, so the feed omits them. */
const FIXED_PRICES: Record<number, number> = { 995: 1 };

type LatestEntry = {
  high?: number | null;
  low?: number | null;
};

/**
 * Grand Exchange prices from the RuneScape Wiki's real-time API.
 *
 * Fetched on boot and every 12 hours, then held in memory and mirrored to
 * `data/ge-prices.json`. The mirror is what makes a restart cheap and keeps
 * the site working when the wiki is unreachable: it is read first, and a
 * failed refresh leaves the previous prices in place rather than blanking
 * them.
 */
@Injectable()
export class PricesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PricesService.name);
  private prices: Record<number, number> = { ...FIXED_PRICES };
  private updated = '';
  private body = '';
  private tag = '';
  private timer: NodeJS.Timeout | undefined;

  private get cachePath(): string {
    return (
      process.env.GE_PRICES_FILE?.trim() ||
      join(process.cwd(), 'data', 'ge-prices.json')
    );
  }

  private get refreshMs(): number {
    const raw = Number(process.env.GE_PRICES_REFRESH_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_MS;
  }

  onModuleInit() {
    this.publish();
    this.readCache();

    // Tests must not reach the network, and a disabled feed still serves
    // whatever the mirror holds.
    if (process.env.NODE_ENV === 'test' || process.env.GE_PRICES_DISABLED) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private readCache() {
    const path = this.cachePath;
    if (!existsSync(path)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const file = raw as { prices?: unknown; updated?: unknown };
      const stored = this.coerce(file.prices);
      if (!Object.keys(stored).length) return;
      this.prices = stored;
      this.updated = typeof file.updated === 'string' ? file.updated : '';
      this.publish();
      this.logger.log(
        `ge prices: ${Object.keys(stored).length} from cache (updated ${this.updated || 'unknown'})`,
      );
    } catch (err) {
      this.logger.warn(`ge prices: unreadable cache at ${path}`, err);
    }
  }

  private writeCache() {
    const path = this.cachePath;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ updated: this.updated, prices: this.prices }),
        'utf8',
      );
    } catch (err) {
      // A read-only data dir is survivable: prices stay in memory and are
      // refetched on the next boot.
      this.logger.warn(`ge prices: could not write ${path}`, err);
    }
  }

  private coerce(raw: unknown): Record<number, number> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<number, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const id = Number(key);
      const price = Number(value);
      if (Number.isInteger(id) && id > 0 && Number.isFinite(price) && price > 0) {
        out[id] = Math.round(price);
      }
    }
    return { ...out, ...FIXED_PRICES };
  }

  /** Pulls the feed; leaves the current prices untouched if anything fails. */
  async refresh(): Promise<boolean> {
    const url = process.env.GE_PRICES_URL?.trim() || DEFAULT_URL;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const payload = (await res.json()) as { data?: Record<string, LatestEntry> };
      const data = payload?.data;
      if (!data || typeof data !== 'object') {
        throw new Error('response had no "data" object');
      }

      const prices: Record<number, number> = {};
      for (const [key, entry] of Object.entries(data)) {
        const id = Number(key);
        if (!Number.isInteger(id) || id <= 0) continue;
        const price = this.priceOf(entry);
        if (price > 0) prices[id] = price;
      }
      if (!Object.keys(prices).length) {
        throw new Error('response contained no usable prices');
      }

      this.prices = { ...prices, ...FIXED_PRICES };
      this.updated = new Date().toISOString();
      this.publish();
      this.writeCache();
      this.logger.log(`ge prices: ${Object.keys(prices).length} refreshed`);
      return true;
    } catch (err) {
      this.logger.error(`ge prices: refresh from ${url} failed`, err);
      return false;
    }
  }

  /**
   * `low` is the instant-sell price — what a member actually gets for the item
   * — so that is what the site values a bank at. `high` is the instant-buy
   * side and is only used when the feed reports no sell price at all, which
   * happens on thinly traded items.
   */
  private priceOf(entry: LatestEntry | undefined): number {
    const high = Number(entry?.high);
    const low = Number(entry?.low);
    const hasHigh = Number.isFinite(high) && high > 0;
    const hasLow = Number.isFinite(low) && low > 0;
    if (hasLow) return Math.round(low);
    if (hasHigh) return Math.round(high);
    return 0;
  }

  private publish() {
    this.body = JSON.stringify({
      updated: this.updated,
      count: Object.keys(this.prices).length,
      prices: this.prices,
    });
    this.tag = etagOf(this.body);
  }

  priceFor(itemId: number): number {
    return this.prices[itemId] ?? 0;
  }

  get count(): number {
    return Object.keys(this.prices).length;
  }

  get updatedAt(): string {
    return this.updated;
  }

  get payload(): { body: string; etag: string } {
    return { body: this.body, etag: this.tag };
  }

  /**
   * How long this response stays accurate: the time left until the next
   * scheduled refresh.
   *
   * A fixed lifetime never lines up with the refresh clock — at one hour a
   * client revalidates a dozen times per cycle and gets the same ETag every
   * time, and at twelve it can hold prices for nearly a full cycle past the
   * point they changed. Deriving it means one revalidation per refresh,
   * arriving just after there is something new to collect.
   */
  get freshSeconds(): number {
    if (!this.updated) return 300;
    const elapsed = Date.now() - new Date(this.updated).getTime();
    const left = this.refreshMs - elapsed;
    if (!Number.isFinite(left)) return 300;
    // A floor keeps a stalled refresh from turning into a request per view.
    return Math.max(60, Math.min(this.refreshMs, Math.round(left / 1000)));
  }
}
