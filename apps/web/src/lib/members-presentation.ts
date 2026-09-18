import type { ComboboxOption } from '@tmanage/ui';
import type { MemberSummary } from './api/members';
import { describeInternalRole } from './roles';

/**
 * How a member reads — D16's "clear identity disambiguation" and "a stable display for
 * removed/inaccessible members", in one place so the picker and the owner line agree.
 *
 * Kept out of the component so both can be proved without rendering, and so a second screen
 * showing an owner cannot invent a different fallback.
 */

/**
 * The label for one member: the name, with the role after it.
 *
 * The role is not decoration. Two people in an agency are called Alex, and D16 asks for
 * "clear identity disambiguation" — the role is the cheapest fact that distinguishes them and
 * the one most likely to be what the person choosing actually means ("the manager, not the
 * guest"). An email address would disambiguate better and is deliberately not fetched: a
 * picker is not a reason to put the staff address book on a screen.
 */
export function memberLabel(member: MemberSummary): string {
  return `${member.displayName} · ${describeInternalRole(member.role).label}`;
}

/**
 * What to show for a user id the directory does not contain.
 *
 * This is the case the review named: somebody was offboarded, or is in a project the reader
 * cannot see, and the work item still carries their id. The id is shown, shortened, rather
 * than hidden — "Unknown member" alone would make the record unreadable, and the prefix is
 * enough to tell two absent people apart and to search an audit log with.
 *
 * It never says "Unassigned". An owner who left is not the same fact as no owner at all, and
 * conflating them would quietly close a question somebody still has to answer.
 */
export function unknownMemberLabel(userId: string): string {
  return `Former or hidden member (${userId.slice(0, 8)})`;
}

/**
 * The name to show for a stored user id, whatever the directory knows.
 *
 * `null` is the only input that reads as "Unassigned"; every non-null id names somebody, even
 * when the list cannot say who.
 */
export function memberDisplayName(
  userId: string | null,
  members: readonly MemberSummary[],
): string {
  if (userId === null) return 'Unassigned';
  const found = members.find((member) => member.userId === userId);
  return found ? found.displayName : unknownMemberLabel(userId);
}

/**
 * What to show for a stored id while the directory has not answered yet.
 *
 * "Not in the list" and "the list has not arrived" are different facts and only one of them is
 * about the person. Until the directory answers, all that is known is that somebody owns this,
 * so that is what it says.
 */
export const LOADING_MEMBER_LABEL = 'Loading this member’s name…';

/**
 * The picker's options.
 *
 * A stored id that is not in the directory is appended as its own option rather than dropped,
 * so the control can show what the item actually holds. A `Combobox` whose `value` matches no
 * option renders an empty box, which would read as "nobody is assigned" — the precise
 * misreading D16 asks to prevent.
 *
 * `loading` is why this takes a third argument. Every stored id is absent from a directory that
 * has not arrived, so without it a pre-seeded owner flashes as `Former or hidden member` before
 * the names land — a statement about a colleague's standing that is simply false, and the same
 * class of misreading the unknown-id label exists to prevent. While the directory is in flight
 * the option is a placeholder instead; it becomes the name, or the unknown-id label, once there
 * is an answer to base that on.
 */
export function memberOptions(
  members: readonly MemberSummary[],
  selectedUserId: string | null,
  loading = false,
): readonly ComboboxOption[] {
  const options = members.map((member) => ({
    value: member.userId,
    label: memberLabel(member),
  }));

  if (selectedUserId !== null && !members.some((member) => member.userId === selectedUserId)) {
    options.push({
      value: selectedUserId,
      label: loading ? LOADING_MEMBER_LABEL : unknownMemberLabel(selectedUserId),
    });
  }

  return options;
}
