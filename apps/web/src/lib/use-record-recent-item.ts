'use client';

import { useEffect, useRef } from 'react';
import { recordRecentItem } from './api/home';
import type { RecentItemObjectType } from './api/home';
import { browserApiClient } from './api/browser-client';
import type { ApiClient } from './api/client';

/**
 * **HOME recents (COL-08).** Record that the acting member has opened an object, so Home's
 * "Recently viewed" rail stops being always-empty.
 *
 * Nothing was ever calling `PUT .../home/recent-items`, so the rail had nothing to read (COL-08:
 * "Recently viewed: always empty"). A detail screen calls this once its entity is confirmed to
 * exist, and the view is recorded the first time that object is opened in this mount.
 *
 * The call is **best-effort**: it fires once per object id and swallows every failure. A principal
 * without `work.read` (a client) is refused by the route, and that refusal must never surface as a
 * page error on a screen the caller was otherwise allowed to read.
 */
export function useRecordRecentItem(params: {
  readonly organizationSlug: string;
  readonly objectType: RecentItemObjectType;
  readonly objectId: string | undefined;
  /** Record only once the entity is confirmed (its own query succeeded). */
  readonly enabled: boolean;
  readonly client?: ApiClient | undefined;
}): void {
  const { organizationSlug, objectType, objectId, enabled, client } = params;
  const recorded = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !objectId) return;
    const key = `${objectType}:${objectId}`;
    if (recorded.current === key) return;
    recorded.current = key;

    const api = client ?? browserApiClient();
    void recordRecentItem(api, organizationSlug, { objectType, objectId }).catch(() => undefined);
  }, [enabled, objectId, objectType, organizationSlug, client]);
}
