import { useEffect, useState } from 'react';
import { fetchItemNames } from '../api/groupClient';

/**
 * Item id -> display name for the whole game, served by the API from a cache
 * dump. Without it every item renders as "Item <id>".
 *
 * The catalogue is ~1.3MB and identical for everyone, so it is fetched once per
 * page load and left to the browser's HTTP cache (the endpoint sends a long
 * max-age and an ETag) rather than copied into localStorage, which would risk
 * the storage quota for no gain.
 *
 * Names live in a module-level map rather than React state because `itemName`
 * is called from plain functions like `aggregateGroupItems`. Components that
 * render names call `useItemNames()` so they re-run once it arrives.
 */
let names: Record<number, string> = {};
let started = false;
let version = 0;

const listeners = new Set<(v: number) => void>();

function publish() {
  version += 1;
  for (const listener of listeners) listener(version);
}

export function lookupItemName(itemId: number): string | undefined {
  return names[itemId];
}

/**
 * A real item id drawn from the loaded catalogue, for sample/demo content
 * that needs plausible-looking loot rather than a hand-picked list. Undefined
 * before the catalogue has loaded; callers should fall back to a fixed id.
 */
export function randomCatalogueId(): number | undefined {
  const ids = Object.keys(names);
  if (!ids.length) return undefined;
  return Number(ids[Math.floor(Math.random() * ids.length)]);
}

export type ItemNameHit = { id: number; name: string; at: number };

/**
 * Flat arrays of the catalogue with the names pre-lowercased, rebuilt only when
 * the catalogue itself changes. Walking `Object.entries` and lowercasing 45,000
 * names on every keystroke was the whole cost of the item pickers.
 */
let index: { ids: number[]; labels: string[]; lower: string[] } | null = null;
let indexVersion = -1;

function searchIndex() {
  if (index && indexVersion === version) return index;
  const entries = Object.entries(names);
  const ids = new Array<number>(entries.length);
  const labels = new Array<string>(entries.length);
  const lower = new Array<string>(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    const [key, name] = entries[i]!;
    ids[i] = Number(key);
    labels[i] = name;
    lower[i] = name.toLowerCase();
  }
  index = { ids, labels, lower };
  indexVersion = version;
  return index;
}

/** Earlier match, then shorter name, then lower id. */
function worseThan(a: ItemNameHit, b: ItemNameHit) {
  if (a.at !== b.at) return a.at > b.at;
  if (a.name.length !== b.name.length) return a.name.length > b.name.length;
  return a.id > b.id;
}

/**
 * Substring search over the catalogue, for the "add an item" pickers. Prefix
 * matches rank above mid-word ones, then shorter names, so typing "abby" offers
 * "Abyssal whip" before "Fresh crystal abyssal whip".
 *
 * Keeps only the best `limit` hits as it scans rather than collecting and
 * sorting every match: a query like "a" matches tens of thousands of items, and
 * sorting those to show eight of them is what made typing stutter.
 */
export function searchItemNames(query: string, limit = 8): ItemNameHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const { ids, labels, lower } = searchIndex();
  const best: ItemNameHit[] = [];
  for (let i = 0; i < lower.length; i += 1) {
    const at = lower[i]!.indexOf(q);
    if (at < 0) continue;
    const hit = { id: ids[i]!, name: labels[i]!, at };
    if (best.length === limit) {
      if (!worseThan(best[limit - 1]!, hit)) continue;
      best.pop();
    }
    let j = best.length;
    while (j > 0 && worseThan(best[j - 1]!, hit)) {
      best[j] = best[j - 1]!;
      j -= 1;
    }
    best[j] = hit;
  }
  return best;
}

function start() {
  if (started) return;
  started = true;
  fetchItemNames()
    .then((catalogue) => {
      names = catalogue.names ?? {};
      publish();
    })
    .catch(() => {
      // Names are cosmetic: on failure every item keeps its "Item <id>" label.
      // Left flagged as started so a broken endpoint isn't retried per mount.
    });
}

/**
 * Returns a counter that changes once the catalogue has loaded. Include it in
 * the dependencies of any memo that formats item names.
 */
export function useItemNames(): number {
  const [current, setCurrent] = useState(version);
  useEffect(() => {
    start();
    listeners.add(setCurrent);
    setCurrent(version);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return current;
}
