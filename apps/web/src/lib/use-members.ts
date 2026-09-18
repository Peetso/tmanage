import { useQuery } from '@tanstack/react-query';
import { listMembers } from './api/members';
import type { MemberSummary } from './api/members';
import type { ApiClient } from './api/client';

/**
 * The member directory, cached once per organization — D16's data hook.
 *
 * A screen that shows an owner's name and a picker that offers the same people are the same
 * question asked twice; one query key means they are one request and can never disagree with
 * each other. The key carries the shape word the way `query-keys.ts` argues for, so nothing
 * else can collide with it.
 */

export const memberKeys = {
  all: (organizationSlug: string) => ['members', organizationSlug] as const,
  list: (organizationSlug: string) => ['members', organizationSlug, 'list'] as const,
};

export interface MembersQuery {
  readonly members: readonly MemberSummary[];
  readonly isPending: boolean;
  readonly isError: boolean;
}

/**
 * The directory, with emptiness as the only fallback.
 *
 * A failed or pending fetch yields `[]`, which every caller here already renders correctly:
 * the picker offers nothing and says so, and an owner falls back to the stable label rather
 * than to a blank. That is deliberate — a work item's record must stay readable when the
 * directory is unavailable, because the id is still on the row and still means somebody.
 */
export function useMembers(api: ApiClient, organizationSlug: string): MembersQuery {
  const query = useQuery({
    queryKey: memberKeys.list(organizationSlug),
    queryFn: () => listMembers(api, organizationSlug),
    // The roster changes when somebody joins or leaves, not between two fields of one form.
    staleTime: 60_000,
  });

  return {
    members: query.data?.members ?? [],
    isPending: query.isPending,
    isError: query.isError,
  };
}
