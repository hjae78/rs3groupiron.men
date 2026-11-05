import { Subject, firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import type {
  GroupChange,
  GroupChangeNotifier,
} from './group-change-notifier.service';
import { GroupEventsService } from './group-events.service';
import { GroupSnapshotService } from './group-snapshot.service';

const GROUP = 'group-1';

/** Drains pending microtasks and timer callbacks. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

type BuildCall = { groupId: string; since: number };

function makeService() {
  const changed = new Subject<GroupChange>();
  const calls: BuildCall[] = [];
  const snapshot = {
    buildGroupData: (groupId: string, since: number) => {
      calls.push({ groupId, since });
      return Promise.resolve([{ name: 'IronJackery' }]);
    },
  } as unknown as GroupSnapshotService;
  const notifier = {
    changed$: changed.asObservable(),
  } as unknown as GroupChangeNotifier;
  return {
    events: new GroupEventsService(snapshot, notifier),
    changed,
    calls,
  };
}

describe('GroupEventsService', () => {
  describe('capacity', () => {
    it('accepts connections while there is room', () => {
      const { events } = makeService();
      expect(events.hasCapacityFor(GROUP)).toBe(true);
    });

    // The demo group streams without a token, so an unbounded connection count
    // is an unauthenticated way to make the server build snapshots forever.
    it('refuses once a single group is full', () => {
      const { events } = makeService();
      const open = Array.from({ length: 256 }, () =>
        events.stream(GROUP).subscribe({ error: () => {} }),
      );

      expect(events.hasCapacityFor(GROUP)).toBe(false);
      // A different group is unaffected until the global cap is reached.
      expect(events.hasCapacityFor('group-2')).toBe(true);

      open.forEach((sub) => sub.unsubscribe());
      expect(events.hasCapacityFor(GROUP)).toBe(true);
    });

    it('counts viewers down again when a connection closes', () => {
      const { events } = makeService();
      const sub = events.stream(GROUP).subscribe({ error: () => {} });

      expect(events.viewerStats).toEqual({ total: 1, groups: 1 });

      sub.unsubscribe();
      expect(events.viewerStats).toEqual({ total: 0, groups: 0 });
    });
  });

  describe('delta cursor', () => {
    it('sends a full snapshot to every new subscriber', async () => {
      const { events, calls } = makeService();

      await firstValueFrom(events.stream(GROUP).pipe(take(1)));
      await firstValueFrom(events.stream(GROUP).pipe(take(1)));

      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.since === 0)).toBe(true);
    });

    /**
     * The cursor is shared by every viewer of a group. A late joiner's snapshot
     * must not advance it, or a change still inside the throttle window would be
     * skipped for the viewers already connected.
     *
     * The clock is pinned because the whole race happens inside one millisecond
     * otherwise, which would make this pass either way.
     */
    it('does not let a late subscriber move the shared cursor forward', async () => {
      const { events, changed, calls } = makeService();
      let clock = 1_000;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);

      const first = events.stream(GROUP).subscribe({ error: () => {} });
      await flush();

      clock = 5_000;
      const second = events.stream(GROUP).subscribe({ error: () => {} });
      await flush();

      clock = 9_000;
      changed.next({ groupId: GROUP, kind: 'members' });
      await flush();

      const deltas = calls.filter((c) => c.since > 0);
      expect(deltas).toHaveLength(1);
      // 5000 would mean the second viewer's snapshot moved the cursor, losing
      // anything that changed between the two connects.
      expect(deltas[0].since).toBe(1_000);

      now.mockRestore();
      first.unsubscribe();
      second.unsubscribe();
    });
  });
});
