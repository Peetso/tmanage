'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { fetchPlatformMe } from '../../lib/api/platform-admin';
import { isTransientFailure } from '../../lib/session-check';
import { SessionStatusCard } from '../session/SessionCards';
import { retryDelay } from '../session/useSessionCheck';
import { PageNotFoundState, StateScreen } from '../state/StateScreens';
import { PLATFORM_ME_QUERY_KEY } from './shared/usePlatformPermissions';

/**
 * AUTHSTATE — Platform admin draws none of its chrome until the API has said this person may see
 * it (`GET /v1/platform/me`, the same question and the same cached answer `PlatformGate` uses).
 *
 * - 200, or 403 (an admin who must confirm or turn on two-step) → the page, which handles both.
 * - 404 (not an admin, or Platform admin off) → the ordinary not-found page, never the menu.
 * - no answer / 5xx → "Can't reach TManage — retrying", retried until it answers.
 *
 * The production server asks the same question before it sends any HTML
 * (`apps/server/platform-gate.mjs`); this is the answer for the requests it hands on — an expired
 * access cookie the browser refreshes first — and for `next dev`.
 */
export function PlatformAccessGate({
  children,
  client,
}: {
  children: ReactNode;
  client?: ApiClient;
}) {
  const api = client ?? browserApiClient();
  const me = useQuery({
    queryKey: PLATFORM_ME_QUERY_KEY,
    queryFn: () => fetchPlatformMe(api),
    // Unknown is never final: retried with the shared session check's backoff (1, 2, 4, 8, 15 s).
    retry: (_failures, error) => isTransientFailure(error),
    retryDelay,
  });

  if (me.isSuccess) return children;
  if (me.isError && me.error instanceof ApiRequestError && me.error.status === 404) {
    return (
      <StateScreen>
        <PageNotFoundState client={api} />
      </StateScreen>
    );
  }
  // A definite answer other than 404 (403: confirm or turn on two-step) is the page's to show.
  if (me.isError) return children;
  return (
    <SessionStatusCard
      state={me.failureCount > 0 ? 'unknown' : 'checking'}
      onRetry={() => void me.refetch()}
    />
  );
}
