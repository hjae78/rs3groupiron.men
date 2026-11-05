import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Which separately-fetched endpoints a client should re-read. Member state
 * travels in the delta payload itself and needs no refetch; the rest are
 * endpoints a client would otherwise have to poll blindly.
 */
export type GroupChangeKind = 'members' | 'achievements' | 'quests' | 'settings';

export type GroupChange = { groupId: string; kind: GroupChangeKind };

/**
 * Emits a group id whenever something about that group changes. A standalone
 * singleton so every service that mutates a group can raise this without
 * depending on GroupsService (and GroupsService can depend on them back).
 *
 * Writes stay synchronous — emitting is just a function call, and nobody may
 * be listening.
 */
@Injectable()
export class GroupChangeNotifier {
  private readonly changed = new Subject<GroupChange>();
  readonly changed$ = this.changed.asObservable();

  /** Wakes any SSE subscribers for the group; a no-op when nobody is watching. */
  notify(groupId: string, ...kinds: GroupChangeKind[]) {
    const list = kinds.length > 0 ? kinds : (['members'] as GroupChangeKind[]);
    for (const kind of list) {
      this.changed.next({ groupId, kind });
    }
  }
}
