'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { getMeetingOverview, type MeetingOverviewView } from '../../lib/api/meetings';
import {
  getGoogleCalendarStatus,
  getMicrosoftCalendarStatus,
} from '../../lib/api/calendar-connections';
import { fetchMyProfile } from '../../lib/api/member-profile';
import { listMembers } from '../../lib/api/members';

/** The most meeting pages one screen reads at once (each card needs its people and link). */
export const OVERVIEW_CAP = 60;

/**
 * The overview of every meeting a screen shows — the video call, the answers and the Join link
 * are only on the overview. Read once a minute at most; a missing one just draws less.
 */
export function useMeetingOverviews(
  api: ApiClient,
  organizationSlug: string,
  meetingIds: readonly string[],
): ReadonlyMap<string, MeetingOverviewView> {
  const ids = meetingIds.slice(0, OVERVIEW_CAP);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['meeting-overview', organizationSlug, id],
      queryFn: () => getMeetingOverview(api, organizationSlug, id),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const map = new Map<string, MeetingOverviewView>();
  results.forEach((result, index) => {
    const id = ids[index];
    if (id && result.data) map.set(id, result.data);
  });
  return map;
}

/** One provider's connection as the screens draw it. */
export interface CalendarAccount {
  readonly provider: 'google' | 'microsoft';
  readonly status: 'not_connected' | 'connected' | 'error';
  readonly accountEmail: string | null;
  readonly lastSyncedAt: string | null;
}

/**
 * The caller's own calendars. Microsoft is listed only when its backend answers and says it is
 * configured; Google only when the Google client is set.
 */
export function useCalendarAccounts(
  api: ApiClient,
  organizationSlug: string,
): { readonly accounts: readonly CalendarAccount[]; readonly loaded: boolean } {
  const google = useQuery({
    queryKey: ['calendar-connection', organizationSlug, 'google'],
    queryFn: () => getGoogleCalendarStatus(api, organizationSlug),
    staleTime: 60_000,
    retry: false,
  });
  const microsoft = useQuery({
    queryKey: ['calendar-connection', organizationSlug, 'microsoft'],
    queryFn: () => getMicrosoftCalendarStatus(api, organizationSlug),
    staleTime: 60_000,
    retry: false,
  });
  const accounts: CalendarAccount[] = [];
  if (google.data?.configured) accounts.push({ provider: 'google', ...google.data.google });
  if (microsoft.data?.configured) {
    accounts.push({ provider: 'microsoft', ...microsoft.data.microsoft });
  }
  return { accounts, loaded: !google.isPending && !microsoft.isPending };
}

/**
 * The caller's own user id, resolved from their profile name against the member list (no
 * endpoint returns it directly). `null` while unknown or when the name is not unique — "Mine"
 * and "Needs your answer" then stay hidden rather than guess.
 */
export function useMyUserId(api: ApiClient, organizationSlug: string): string | null {
  const me = useQuery({
    queryKey: ['my-profile', organizationSlug],
    queryFn: () => fetchMyProfile(api, organizationSlug),
    staleTime: 300_000,
    retry: false,
  });
  const name = me.data?.displayName ?? '';
  const members = useQuery({
    queryKey: ['members', organizationSlug, 'me', name],
    queryFn: () => listMembers(api, organizationSlug, { q: name, limit: 20 }),
    enabled: name !== '',
    staleTime: 300_000,
    retry: false,
  });
  const matches = (members.data?.members ?? []).filter((m) => m.displayName === name);
  return matches.length === 1 ? (matches[0]?.userId ?? null) : null;
}
