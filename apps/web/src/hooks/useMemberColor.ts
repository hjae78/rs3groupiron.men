import { useMemo } from 'react';
import type { MemberBadge } from '../components/GroupMapShell/memberOptions';
import { colorForName } from '../lib/items';

/** A stable per-name color, falling back to a deterministic one for names not in the roster. */
export function useMemberColor(members: ReadonlyArray<MemberBadge>) {
  return useMemo(() => {
    const byName = new Map(members.map((m) => [m.name, m.color]));
    return (name: string) => byName.get(name) ?? colorForName(name);
  }, [members]);
}
