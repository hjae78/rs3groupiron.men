import { Injectable } from '@nestjs/common';
import { concat, defer, interval, merge, Observable } from 'rxjs';
import {
  filter,
  finalize,
  map,
  share,
  switchMap,
  tap,
  throttleTime,
} from 'rxjs/operators';
import {
  GroupChangeNotifier,
  type GroupChangeKind,
} from './group-change-notifier.service';
import { GroupSnapshotService } from './group-snapshot.service';

export const ALL_CHANGE_KINDS: GroupChangeKind[] = [
  'members',
  'achievements',
  'quests',
  'settings',
];

export type GroupEvent = {
  type: 'snapshot' | 'delta' | 'ping';
  at: string;
  data: unknown;
  /**
   * Which separately-fetched endpoints this event invalidates. Lets a client
   * refetch only the panel that changed instead of polling all of them.
   */
  kinds?: GroupChangeKind[];
};

/** Cloudflare drops connections idle for ~100s. */
const HEARTBEAT_MS = 25_000;

/**
 * Connection caps, sized for sockets rather than for query cost: the connect
 * snapshot is shared through GroupSnapshotService, so a connect storm no longer
 * multiplies database work, and a steady-state viewer costs little beyond its
 * socket and a file descriptor.
 *
 * The real ceiling is nginx. Each stream holds one client connection plus one
 * upstream connection out of `worker_connections` (deploy/configure.sh sets
 * 4096), so the default here stays under half of that. Raise both together.
 *
 * Refusing at the HTTP layer is safe: the client treats a failed stream as
 * "keep polling".
 */
const MAX_VIEWERS_PER_GROUP = Number(process.env.SSE_MAX_PER_GROUP ?? 256);
const MAX_VIEWERS_TOTAL = Number(process.env.SSE_MAX_TOTAL ?? 1800);

/**
 * Five players moving produces roughly five writes a second, so pushing each
 * one would be chattier than the 1.5s poll this replaces.
 */
const BROADCAST_INTERVAL_MS = 750;

/**
 * Fans group changes out to connected SSE clients.
 *
 * One change produces one database build however many clients are watching —
 * the per-group observable is shared. Polling cost one build per viewer per
 * tick, which is the reason this exists.
 *
 * In-process, so single-instance only. A second API process would need the
 * notify to travel between them; Postgres LISTEN/NOTIFY is the upgrade path.
 */
@Injectable()
export class GroupEventsService {
  private readonly streams = new Map<string, Observable<GroupEvent>>();
  /** Delta cursor per group. */
  private readonly lastBroadcast = new Map<string, number>();
  /** Open connections per group — one per browser tab. */
  private readonly viewers = new Map<string, number>();
  /**
   * Kinds seen since the last broadcast. Recorded before the throttle so a
   * burst that collapses into one delta still reports every kind it covered.
   */
  private readonly pendingKinds = new Map<string, Set<GroupChangeKind>>();

  constructor(
    private readonly snapshot: GroupSnapshotService,
    private readonly notifier: GroupChangeNotifier,
  ) {}

  get viewerStats() {
    return { total: this.totalViewers(), groups: this.viewers.size };
  }

  private totalViewers() {
    let total = 0;
    for (const n of this.viewers.values()) total += n;
    return total;
  }

  /**
   * Whether another connection looks acceptable right now.
   *
   * Advisory only, and deliberately so: the controller calls this before
   * returning the stream purely to turn the common case into a clean 503, but
   * nothing is reserved until the response is actually subscribed. A burst of
   * simultaneous connects therefore all pass this check — admission is enforced
   * in {@link stream} instead, which is where the count moves.
   */
  hasCapacityFor(groupId: string): boolean {
    return (
      (this.viewers.get(groupId) ?? 0) < MAX_VIEWERS_PER_GROUP &&
      this.totalViewers() < MAX_VIEWERS_TOTAL
    );
  }

  /** Created on first subscriber, torn down when the last one leaves. */
  private broadcast(groupId: string): Observable<GroupEvent> {
    const existing = this.streams.get(groupId);
    if (existing) return existing;

    const stream = this.notifier.changed$.pipe(
      filter((change) => change.groupId === groupId),
      tap((change) => {
        const seen = this.pendingKinds.get(groupId) ?? new Set<GroupChangeKind>();
        seen.add(change.kind);
        this.pendingKinds.set(groupId, seen);
      }),
      // Leading so the first move is immediate, trailing so the last of a
      // burst is never dropped.
      throttleTime(BROADCAST_INTERVAL_MS, undefined, {
        leading: true,
        trailing: true,
      }),
      switchMap(async () => {
        const since = this.lastBroadcast.get(groupId) ?? 0;
        const at = Date.now();
        const kinds = [...(this.pendingKinds.get(groupId) ?? [])];
        this.pendingKinds.delete(groupId);
        const data = await this.snapshot.buildGroupData(groupId, since, true);
        this.lastBroadcast.set(groupId, at);
        return {
          type: 'delta' as const,
          at: new Date(at).toISOString(),
          data,
          kinds,
        };
      }),
      finalize(() => {
        this.streams.delete(groupId);
        this.lastBroadcast.delete(groupId);
        this.pendingKinds.delete(groupId);
      }),
      share({ resetOnRefCountZero: true }),
    );

    this.streams.set(groupId, stream);
    return stream;
  }

  /**
   * A snapshot so the client has something to render, then the shared delta
   * broadcast. A client joining mid-stream may receive a delta covering a
   * window it already has; the client merge is idempotent.
   */
  stream(groupId: string): Observable<GroupEvent> {
    const snapshot$ = defer(async () => {
      const at = Date.now();
      const data = await this.snapshot.buildGroupData(groupId, 0, true);
      // Only seeds the cursor for the first viewer, so the first delta starts
      // right after this snapshot. A later joiner must not move it: the cursor
      // is shared, and skipping it past a change still inside the throttle
      // window would drop that change for everyone already connected.
      if (!this.lastBroadcast.has(groupId)) {
        this.lastBroadcast.set(groupId, at);
      }
      return {
        type: 'snapshot' as const,
        at: new Date(at).toISOString(),
        data,
        // A fresh or reconnected client holds nothing it can trust, so every
        // panel is invalidated rather than just the ones that moved.
        kinds: ALL_CHANGE_KINDS,
      };
    });

    const heartbeat$ = interval(HEARTBEAT_MS).pipe(
      map((): GroupEvent => ({
        type: 'ping',
        at: new Date().toISOString(),
        data: null,
      })),
    );

    const events$ = merge(
      concat(
        snapshot$,
        defer(() => this.broadcast(groupId)),
      ),
      heartbeat$,
    );

    // Counted around the whole stream so the tally drops however the
    // connection ends: clean close, dropped socket or error.
    return new Observable<GroupEvent>((subscriber) => {
      // The authoritative admission check. Checking and incrementing in one
      // synchronous block is what makes it hold under a simultaneous burst;
      // doing it before the response was subscribed let every connection in a
      // flood pass while the count was still zero.
      if (!this.hasCapacityFor(groupId)) {
        // complete(), not error(): completing ends the response, which the
        // client reports as a closed stream and answers by polling and retrying
        // later. An error leaves the socket open and silent, so the client waits
        // for a frame that will never come.
        subscriber.complete();
        return;
      }
      this.viewers.set(groupId, (this.viewers.get(groupId) ?? 0) + 1);

      const sub = events$.subscribe(subscriber);
      return () => {
        const left = (this.viewers.get(groupId) ?? 1) - 1;
        if (left > 0) this.viewers.set(groupId, left);
        else this.viewers.delete(groupId);
        sub.unsubscribe();
      };
    });
  }
}
