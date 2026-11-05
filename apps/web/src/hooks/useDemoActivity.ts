import { useEffect, useMemo, useRef, useState } from 'react';
import type { Achievement, AchievementKind, BankLedgerEntry } from '../api/groupClient';
import {
  BANK_QUANTITIES,
  LOOT,
  cloneTotals,
  pick,
  stepPlayer,
  type DemoXpTotals,
  type Heading,
} from '../lib/demoActivitySim';
import type { PlayerView } from '../lib/items';
import { QUESTS, type MemberQuestStates, type QuestState } from '../lib/quests';

type PatchPlayers = (update: (prev: PlayerView[]) => PlayerView[]) => void;

export type DemoXp = {
  totals: DemoXpTotals;
  samples: Array<{ t: string; totals: DemoXpTotals }>;
};

export type DemoActivity = {
  achievements: Achievement[];
  ledger: BankLedgerEntry[];
  quests: Record<string, MemberQuestStates>;
  xp: DemoXp;
};

const TICK_MS = 1200;
const ACHIEVEMENT_MS = 14_000;
// Feeds both the achievements and the rare-drops panels, and the seed alone
// puts nine drops in the window, so this holds more than a single page needs.
const MAX_DEMO_ACHIEVEMENTS = 40;
const LEDGER_MS = 4500;
const MAX_DEMO_LEDGER = 60;
const QUEST_MS = 9000;
const MAX_XP_SAMPLES = 16;

/** The demo has no real captures, so every entry shows the same placeholder. */
const DEMO_SHOT = '/demo-shots/images-not-supported.png';

const DAY_MS = 86_400_000;
/** Backfill for the 24-hour window the feed panels open on. */
const SEED_LEDGER_BATCHES = 14;
const SEED_XP_SAMPLES = 12;
const SEED_DROPS = 9;

export const DEMO_XP_SAMPLE_MS = 12_000;

const DEMO_QUESTS = QUESTS.filter((q) => q.category === 'quest' && q.questPoints > 0);
const QUEST_BY_GAMEVAL = new Map(DEMO_QUESTS.map((q) => [q.gameval, q]));

/**
 * Rare drops carry a real item id, because the panel labels and prices them
 * from the catalogue rather than from the title. `detail` is the source line
 * the feed shows under the item.
 */
const DROP_TEMPLATES: Array<{
  itemId: number;
  title: string;
  detail: string;
  /** Stackables carry one so the feed draws the game's stacked art. */
  quantity?: number;
}> = [
  { itemId: 15259, title: 'Received a Dragon hatchet', detail: 'Dagannoth Kings' },
  { itemId: 11694, title: 'Received an Armadyl godsword', detail: 'Kree’arra' },
  { itemId: 4151, title: 'Received an Abyssal whip', detail: 'Abyssal demon' },
  { itemId: 1249, title: 'Received a Dragon spear', detail: 'Kalphite Queen' },
  { itemId: 23351, title: 'Received an Elder overload', detail: 'Raids chest' },
  { itemId: 11832, title: 'Received a Bandos chestplate', detail: 'General Graardor' },
  { itemId: 11834, title: 'Received Bandos tassets', detail: 'General Graardor' },
  { itemId: 15271, title: 'Received a Rune pouch', detail: 'Crazy archaeologist' },
  { itemId: 565, title: 'Received Blood runes', detail: 'Zamorak chest', quantity: 1200 },
  { itemId: 995, title: 'Received Coins', detail: 'Clue scroll', quantity: 2_400_000 },
];

const ACHIEVEMENT_TEMPLATES: Array<{ kind: AchievementKind; title: string; detail: string | null }> = [
  { kind: 'level', title: 'Reached level 99 Mining', detail: 'A new skill cape is earned' },
  { kind: 'level', title: 'Reached level 120 Slayer', detail: 'Mastery beyond 99' },
  { kind: 'diary', title: 'Finished the Varrock achievements', detail: 'Hard tier complete' },
  { kind: 'other', title: 'Unlocked a new music track', detail: null },
];

export function mergeQuestStates(
  base: Record<string, MemberQuestStates>,
  overlay: Record<string, MemberQuestStates>,
): Record<string, MemberQuestStates> {
  const names = Object.keys(overlay);
  if (!names.length) return base;
  const out = { ...base };
  for (const name of names) out[name] = { ...out[name], ...overlay[name] };
  return out;
}

export function demoGainFor(totals: DemoXpTotals, name: string, skill: string): number {
  const bySkill = totals[name];
  if (!bySkill) return 0;
  if (skill !== 'overall') return bySkill[skill] ?? 0;
  let sum = 0;
  for (const id of Object.keys(bySkill)) sum += bySkill[id]!;
  return sum;
}

const EMPTY_XP: DemoXp = { totals: {}, samples: [] };

/**
 * Keeps the read-only demo looking alive: XP ticks in, members wander the map,
 * vitals move, gear and inventories change, shared-bank movements land, quests
 * get started and finished and achievements drop. Returns the synthetic feeds
 * so each panel can show them alongside the real data.
 */
export function useDemoActivity(enabled: boolean, patchPlayers: PatchPlayers): DemoActivity {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [ledger, setLedger] = useState<BankLedgerEntry[]>([]);
  const [quests, setQuests] = useState<Record<string, MemberQuestStates>>({});
  const [xp, setXp] = useState<DemoXp>(EMPTY_XP);

  const namesRef = useRef<string[]>([]);
  const headingsRef = useRef(new Map<string, Heading>());
  const questsRef = useRef<Record<string, MemberQuestStates>>({});
  const totalsRef = useRef<DemoXpTotals>({});
  const pendingRef = useRef<{ id: number; log: DemoXpTotals } | null>(null);
  const committedRef = useRef(-1);
  const tickRef = useRef(0);
  const seqRef = useRef(0);
  const seededRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const make = (
      name: string,
      template: {
        kind: AchievementKind;
        title: string;
        detail: string | null;
        itemId?: number;
        quantity?: number;
      },
      at: string,
      gameval: string | null = null,
    ): Achievement => {
      seqRef.current += 1;
      return {
        id: `demo-${seqRef.current}`,
        name,
        kind: template.kind,
        title: template.title,
        detail: template.detail,
        skill_id: template.kind === 'level' ? 'mining' : null,
        item_id: template.itemId ?? null,
        quantity: template.quantity ?? null,
        gameval,
        image_url: DEMO_SHOT,
        at,
      };
    };

    const push = (
      name: string,
      template: {
        kind: AchievementKind;
        title: string;
        detail: string | null;
        itemId?: number;
        quantity?: number;
      },
      gameval: string | null = null,
    ) => {
      const entry = make(name, template, new Date().toISOString(), gameval);
      setAchievements((prev) => [entry, ...prev].slice(0, MAX_DEMO_ACHIEVEMENTS));
    };

    const dropEntry = (names: string[], at: string) => {
      const template = pick(DROP_TEMPLATES);
      return make(
        pick(names),
        {
          kind: 'drop',
          title: template.title,
          detail: template.detail,
          itemId: template.itemId,
          quantity: template.quantity,
        },
        at,
      );
    };

    // The tick updater rolls dice, so React can run it twice and keep only the
    // second result. Its XP is therefore staged per tick id and folded in once.
    const commit = () => {
      const pending = pendingRef.current;
      if (!pending || pending.id === committedRef.current) return;
      committedRef.current = pending.id;
      const totals = totalsRef.current;
      for (const name of Object.keys(pending.log)) {
        const into = (totals[name] ??= {});
        const from = pending.log[name]!;
        for (const id of Object.keys(from)) into[id] = (into[id] ?? 0) + from[id]!;
      }
    };

    const tick = () => {
      commit();
      tickRef.current += 1;
      const id = tickRef.current;
      patchPlayers((prev) => {
        if (!prev.length) return prev;
        namesRef.current = prev.filter((p) => p.online).map((p) => p.name);
        const onlineCount = namesRef.current.length;
        const log: DemoXpTotals = {};
        const next = prev.map((player) =>
          stepPlayer(player, headingsRef.current, onlineCount, log),
        );
        pendingRef.current = { id, log };
        return next.some((player, i) => player !== prev[i]) ? next : prev;
      });
    };

    const sample = () => {
      commit();
      const totals = cloneTotals(totalsRef.current);
      if (!Object.keys(totals).length) return;
      setXp((prev) => ({
        totals,
        samples: [...prev.samples, { t: new Date().toISOString(), totals }].slice(
          -MAX_XP_SAMPLES,
        ),
      }));
    };

    const bankBatch = (at: string, names: string[]) => {
      const batch: BankLedgerEntry[] = [];
      for (let n = 0, count = 1 + Math.floor(Math.random() * 2); n < count; n += 1) {
        seqRef.current += 1;
        const quantity = pick(BANK_QUANTITIES);
        batch.push({
          id: `demo-bank-${seqRef.current}`,
          name: pick(names),
          item_id: pick(LOOT),
          delta: Math.random() < 0.6 ? quantity : -quantity,
          at,
        });
      }
      return batch;
    };

    const moveBank = () => {
      const names = namesRef.current;
      if (!names.length) return;
      setLedger((prev) =>
        [...bankBatch(new Date().toISOString(), names), ...prev].slice(0, MAX_DEMO_LEDGER),
      );
    };

    /**
     * The ledger, graphs and rare drops all open on the last 24 hours, so the
     * demo backfills that window rather than starting empty and filling in only
     * as the timers fire.
     */
    const seed = () => {
      const names = namesRef.current;
      if (!names.length || seededRef.current) return;
      seededRef.current = true;
      const now = Date.now();

      // Spread across the day with a little jitter, so the feed has believable
      // gaps and day headers rather than one drop every two hours on the dot.
      const dropSeed: Achievement[] = [];
      for (let i = SEED_DROPS; i > 0; i -= 1) {
        const slot = (i - Math.random()) / SEED_DROPS;
        dropSeed.push(dropEntry(names, new Date(now - slot * DAY_MS).toISOString()));
      }
      // Reversed so the whole list stays newest-first, like the live pushes:
      // the cap then trims the oldest entries rather than the newest seeded one.
      setAchievements((prev) =>
        [...prev, ...dropSeed.reverse()].slice(0, MAX_DEMO_ACHIEVEMENTS),
      );

      const ledgerSeed: BankLedgerEntry[] = [];
      for (let i = SEED_LEDGER_BATCHES; i > 0; i -= 1) {
        const at = new Date(now - (i / SEED_LEDGER_BATCHES) * DAY_MS).toISOString();
        ledgerSeed.push(...bankBatch(at, names));
      }
      setLedger((prev) =>
        [...prev, ...ledgerSeed.reverse()].slice(0, MAX_DEMO_LEDGER),
      );

      // XP samples climb towards the totals already accumulated, so the chart
      // opens on a curve instead of a single point at "now".
      const totals = cloneTotals(totalsRef.current);
      if (!Object.keys(totals).length) return;
      const samples = Array.from({ length: SEED_XP_SAMPLES }, (_, i) => {
        const k = (i + 1) / SEED_XP_SAMPLES;
        const at = new Date(now - (1 - k) * DAY_MS).toISOString();
        const scaled: DemoXpTotals = {};
        for (const name of Object.keys(totals)) {
          scaled[name] = {};
          for (const id of Object.keys(totals[name]!)) {
            scaled[name]![id] = Math.round(totals[name]![id]! * k);
          }
        }
        return { t: at, totals: scaled };
      });
      setXp((prev) => ({ totals: prev.totals, samples }));
    };

    const progressQuest = () => {
      const names = namesRef.current;
      if (!names.length || !DEMO_QUESTS.length) return;
      const name = pick(names);
      const states = questsRef.current[name] ?? {};
      const started = Object.keys(states).filter((g) => states[g] === 'started');
      const finish = started.length > 0 && (started.length >= 3 || Math.random() < 0.45);

      let gameval: string;
      if (finish) {
        gameval = pick(started);
      } else {
        const options = DEMO_QUESTS.filter((q) => !states[q.gameval]);
        if (!options.length) return;
        gameval = pick(options).gameval;
      }

      const state: QuestState = finish ? 'finished' : 'started';
      questsRef.current = {
        ...questsRef.current,
        [name]: { ...states, [gameval]: state },
      };
      setQuests(questsRef.current);

      const quest = QUEST_BY_GAMEVAL.get(gameval);
      const title = quest?.name ?? gameval;
      push(
        name,
        {
          kind: 'quest',
          title: finish ? `Completed ${title}` : `Started ${title}`,
          detail: finish ? `${quest?.questPoints ?? 1} quest points awarded` : null,
        },
        gameval,
      );
    };

    const award = () => {
      const names = namesRef.current;
      if (!names.length) return;
      // Drops are the headline feed, so they land more often than the rest.
      if (Math.random() < 0.5) {
        const entry = dropEntry(names, new Date().toISOString());
        setAchievements((prev) => [entry, ...prev].slice(0, MAX_DEMO_ACHIEVEMENTS));
        return;
      }
      push(pick(names), pick(ACHIEVEMENT_TEMPLATES));
    };

    // One tick first, so the member names the seed needs are known.
    tick();
    seed();

    const timers = [
      window.setInterval(tick, TICK_MS),
      window.setInterval(sample, DEMO_XP_SAMPLE_MS),
      window.setInterval(moveBank, LEDGER_MS),
      window.setInterval(progressQuest, QUEST_MS),
      window.setInterval(award, ACHIEVEMENT_MS),
    ];
    return () => timers.forEach((timer) => window.clearInterval(timer));
  }, [enabled, patchPlayers]);

  return useMemo(
    () => ({ achievements, ledger, quests, xp }),
    [achievements, ledger, quests, xp],
  );
}
