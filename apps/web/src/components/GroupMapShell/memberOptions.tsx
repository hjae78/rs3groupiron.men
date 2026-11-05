import type { DropdownOption } from './Dropdown';
import type { IconOption } from './IconSelect';
import { AllMembersIcon, MemberAvatar } from './MemberAvatar';

export type MemberBadge = {
  name: string;
  avatarUrl: string | null;
  color: string;
};

/** A `Dropdown` option for a member name: label plus a colored dot icon. */
export function memberDropdownOption(name: string, color: string): DropdownOption<string> {
  return {
    id: name,
    label: name,
    icon: <span className="gms-dot" style={{ background: color }} aria-hidden />,
  };
}

export function memberOption(name: string, members: ReadonlyArray<MemberBadge>): IconOption {
  const member = members.find((m) => m.name === name);
  return {
    value: name,
    label: name,
    icon: <MemberAvatar name={name} avatarUrl={member?.avatarUrl} color={member?.color} />,
  };
}

export function memberOptions(
  names: ReadonlyArray<string>,
  members: ReadonlyArray<MemberBadge>,
  allLabel = 'All members',
): IconOption[] {
  return [
    { value: 'all', label: allLabel, icon: <AllMembersIcon /> },
    ...names.map((name) => memberOption(name, members)),
  ];
}
