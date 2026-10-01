import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listMembers } from './api/members';
import type { MemberSummary } from './api/members';
import type { ApiClient } from './api/client';

/**
 * The member directory, cached once per organization and search — D16's data hook.
 *
 * A screen that shows an owner's name and a picker that offers the same people are the same
 * question asked twice; one query key means they are one request and can never disagree with
 * each other. The key carries the shape word the way `query-keys.ts` argues for, so nothing
 * else can collide with it.
 */

export const memberKeys = {
  all: (organizationSlug: string) => ['members', organizationSlug] as const,
  /**
   * The search is part of the key, not a filter applied to one cached answer: two searches are
   * two different questions to the server, and caching them together would show the second
   * one's answer under the first one's name.
   */
  list: (organizationSlug: string, search = '') =>
    ['members', organizationSlug, 'list', search] as const,
};

export interface MembersQuery {
  readonly members: readonly MemberSummary[];
  readonly isPending: boolean;
  readonly isError: boolean;
}

/**
 * The directory, with emptiness as the only fallback.
 *
 * A failed or pending fetch yields whatever is already known, which every caller here already
 * renders correctly: the picker offers nothing and says so, and an owner falls back to the
 * stable label rather than to a blank. That is deliberate — a work item's record must stay
 * readable when the directory is unavailable, because the id is still on the row and still
 * means somebody.
 *
 * ## Why the answers accumulate
 *
 * `search` is answered by the server, so a narrow search returns a narrow list. The people it
 * leaves out have not stopped existing, and two of them matter:
 *
 * - **The person already chosen.** A field holding Ada's id while the list in flight is for
 *   "Oma" must keep reading *Ada Okonkwo*. Dropping her would make a present colleague render
 *   as `Former or hidden member` for as long as the search lasts — a false statement about
 *   somebody's standing, which is the exact misreading D16 exists to stop.
 * - **The owner line above the form**, which is rendered from this same list and must not
 *   change because somebody typed in a picker below it.
 *
 * So each answer is merged into what is already known rather than replacing it. The union is
 * this organization's members only — it is reset when the organization changes — and the
 * picker narrows it again on the text as it is typed, so a wider list never means a longer one
 * to read.
 */
export function useMembers(api: ApiClient, organizationSlug: string, search = ''): MembersQuery {
  const q = search.trim();

  const query = useQuery({
    queryKey: memberKeys.list(organizationSlug, q),
    queryFn: () => listMembers(api, organizationSlug, q === '' ? {} : { q }),
    // The roster changes when somebody joins or leaves, not between two fields of one form.
    staleTime: 60_000,
  });

  // Render-time sync rather than an effect, the same shape `Combobox` uses for its committed
  // label: merging during render means the merged list is what this render paints, and both
  // the reset and the merge are idempotent, so a double-invoked render changes nothing.
  const known = useRef<{ slug: string; byId: Map<string, MemberSummary> }>({
    slug: organizationSlug,
    byId: new Map(),
  });
  if (known.current.slug !== organizationSlug) {
    // Never carry one organization's names into another's picker.
    known.current = { slug: organizationSlug, byId: new Map() };
  }
  // The server's answer is authoritative for members matching the current search: it searches
  // this tenant's active roster by name fragment (`LIKE %q%`). So anyone already known who
  // *would* have matched this search — same name fragment — yet is absent from the fresh answer
  // is no longer an active member and must drop out of the directory. That is how an offboarded
  // member leaves the picker once the list is refetched, which `OffboardingScreen` relies on.
  //
  // Members who simply do not match the current search are left untouched: a narrow search is a
  // smaller question, not news that the people it omits have gone. That is what lets an owner
  // line rendered from this same list keep its name while a picker below it is searched for
  // somebody else — the reason the union accumulates in the first place.
  const fresh = query.data?.members;
  if (fresh !== undefined) {
    const freshIds = new Set(fresh.map((member) => member.userId));
    const needle = q.toLowerCase();
    for (const [userId, member] of [...known.current.byId]) {
      if (!freshIds.has(userId) && member.displayName.toLowerCase().includes(needle)) {
        known.current.byId.delete(userId);
      }
    }
    for (const member of fresh) {
      known.current.byId.set(member.userId, member);
    }
  }

  const members = [...known.current.byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );

  return {
    members,
    // Pending only while nothing is known at all. Once a page has arrived, a later search is
    // a refinement of a list the reader can already see, not an empty screen.
    isPending: query.isPending && members.length === 0,
    isError: query.isError,
  };
}
