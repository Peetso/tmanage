'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Combobox } from '@tmanage/ui';
import { memberOptions } from '../lib/members-presentation';
import type { MemberSummary } from '../lib/api/members';

/**
 * How long the typing has to stop before the search is sent.
 *
 * Long enough that a name typed at speed is one request rather than nine, short enough that a
 * person who has stopped and is waiting does not notice having done so.
 */
const SEARCH_DEBOUNCE_MS = 250;

export interface MemberSelectProps {
  label: ReactNode;
  /** The active organization's members, by name. Usually `useMembers(...).members`. */
  members: readonly MemberSummary[];
  /** The stored user id, or `''` for none. */
  value: string;
  /** Called with the chosen member's user id, `''` when the field is cleared. */
  onChange: (userId: string) => void;
  /**
   * Called with the typed text once typing pauses, for `useMembers`' `search`.
   *
   * Optional: without it the control offers exactly the members it was handed, which is right
   * wherever the whole list is already in hand. With it, the list is the server's answer to
   * what was typed — which is the only way a person past the first page of a large
   * organization can be found at all.
   */
  onSearchChange?: (q: string) => void;
  hint?: ReactNode;
  required?: boolean;
  /** True while the directory is still loading, so the empty list does not read as "nobody". */
  loading?: boolean;
  /** True when the directory could not be fetched. */
  failed?: boolean;
  name?: string;
}

/**
 * The member picker — D16.
 *
 * The finding: "Core work actions require internal user IDs", and the fix it asks for is
 * "permission-filtered member selectors with names and clear identity disambiguation.
 * Preserve IDs in the API, not as required human input."
 *
 * That last sentence is the whole design. The id does not go away — it is what the API stores
 * and what every audit row references — it simply stops being something a person has to find
 * and paste. This control reads names and emits ids, and the two are never allowed to
 * disagree, which is `Combobox`'s own guarantee rather than one restated here.
 *
 * ## Why a `Combobox` and not a `Select`
 *
 * A native select is fine for seven lifecycle states and wrong for an organization's staff:
 * it cannot be typed against, so finding a colleague in a list of eighty means scrolling one.
 * `Combobox` is the WAI-ARIA editable-combobox pattern the design system already ships for
 * exactly this — "people, projects, anything long enough that typing beats scrolling".
 *
 * ## The three states that are not "here is the list"
 *
 * - **Loading.** The hint says so. An empty combobox with no explanation reads as "this
 *   organization has no members", which is never true of an organization somebody is looking
 *   at.
 * - **Unavailable.** The directory failed. The field still works — a person who knows the id
 *   is not locked out of a transition by a failed side request — and the hint says why the
 *   names are missing rather than pretending the roster is empty.
 * - **A stored id nobody recognises.** Offboarded, or in a project this reader cannot see.
 *   `memberOptions` appends it under a stable label so the control shows what the item
 *   actually holds; dropping it would render an empty box, which reads as "unassigned" and is
 *   the misreading D16 exists to stop. `loading` is passed to it because *every* id is
 *   unrecognised by a directory that has not arrived yet, and calling a colleague a former
 *   member for the half-second before the names land is a false statement, not a loading state.
 *
 * ## Searching happens on the server
 *
 * The combobox filters the options it holds, but the options it holds are one page of a roster
 * that may be far longer. So the typed text is also handed up — once typing pauses — as the
 * search the directory is re-read with, which is what makes the fifty-first member of an
 * organization findable rather than invisible.
 */
export function MemberSelect({
  label,
  members,
  value,
  onChange,
  onSearchChange,
  hint,
  required,
  loading = false,
  failed = false,
  name,
}: MemberSelectProps) {
  const options = memberOptions(members, value === '' ? null : value, loading);

  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (onSearchChange === undefined) return;
    const timer = setTimeout(() => onSearchChange(typed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, onSearchChange]);

  const stateHint = loading
    ? 'Loading the people in this organization.'
    : failed
      ? 'The member list could not be loaded. Names are unavailable; the field still accepts a member you already have.'
      : undefined;

  return (
    <Combobox
      label={label}
      options={options}
      value={value}
      onValueChange={onChange}
      onQueryChange={setTyped}
      emptyLabel={loading ? 'Loading members' : 'No member of this organization matches'}
      {...(name === undefined ? {} : { name })}
      {...(required === undefined ? {} : { required })}
      {...((stateHint ?? hint) ? { hint: stateHint ?? hint } : {})}
    />
  );
}
