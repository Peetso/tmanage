import type { ComboboxOption } from '@tmanage/ui';
import type { MemberSummary } from './api/members';
import { describeInternalRole } from './roles';
import { translateOr } from './i18n/compact-time';

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
  // An offboarded member in a list reads as a former member first; the role still follows, so a
  // team view that includes people who have left stays disambiguated the same way (ADM-07).
  const name =
    member.status === OFFBOARDED_STATUS
      ? formerMemberLabel(member.displayName)
      : member.displayName;
  return `${name} · ${describeInternalRole(member.role).label}`;
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
  return `${translateOr('MembersPresentation.formerOrHidden', 'Former or hidden member')} (${userId.slice(0, 8)})`;
}

/**
 * What to show for someone whose name the directory *does* know, but who has been offboarded —
 * ADM-07.
 *
 * The id-only label above is for an absent id with no name to put to it. This is the other
 * half: a project team or a work item still naming a colleague who has left, where the name is
 * in hand. "Former member: Ada Okonkwo" keeps the person readable and says, in words rather
 * than a raw id, that they are gone — the exact thing the review found the team screen failing
 * to say when it printed the bare id instead.
 */
export function formerMemberLabel(displayName: string): string {
  return `${translateOr('MembersPresentation.formerMemberPrefix', 'Former member:')} ${displayName}`;
}

/** The membership status that reads as "has left"; the one status `formerMemberLabel` is for. */
const OFFBOARDED_STATUS = 'offboarded';

/**
 * What to show for a stored id while the directory has not answered yet.
 *
 * "Not in the list" and "the list has not arrived" are different facts and only one of them is
 * about the person. Until the directory answers, all that is known is that somebody owns this,
 * so that is what it says.
 */
export const LOADING_MEMBER_LABEL = 'Loading this member’s name…';

/** {@link LOADING_MEMBER_LABEL} in the active locale (Arabic read English, 2026-10-31). */
function loadingMemberLabel(): string {
  return translateOr('MembersPresentation.loadingName', LOADING_MEMBER_LABEL);
}

/**
 * The name to show for a stored user id, whatever the directory knows.
 *
 * `null` is the only input that reads as "Unassigned"; every non-null id names somebody, even
 * when the list cannot say who.
 *
 * `loading` is why an owner line takes the same third argument the picker's options do: while
 * the directory is in flight every stored id is absent from it, so without this a pre-seeded
 * owner reads as `Former or hidden member` for as long as the fetch lasts — a false statement
 * about a present colleague's standing, the exact misreading D16 exists to prevent. Until the
 * list answers, all that is known is that somebody owns this, so that is what it says.
 */
export function memberDisplayName(
  userId: string | null,
  members: readonly MemberSummary[],
  loading = false,
): string {
  if (userId === null) return translateOr('MembersPresentation.unassigned', 'Unassigned');
  const found = members.find((member) => member.userId === userId);
  if (found) {
    // A member still in the list but offboarded reads as "Former member: Name", not a bare
    // name that would suggest they are still present (ADM-07).
    return found.status === OFFBOARDED_STATUS
      ? formerMemberLabel(found.displayName)
      : found.displayName;
  }
  return loading ? loadingMemberLabel() : unknownMemberLabel(userId);
}

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
      label: loading ? loadingMemberLabel() : unknownMemberLabel(selectedUserId),
    });
  }

  return options;
}
