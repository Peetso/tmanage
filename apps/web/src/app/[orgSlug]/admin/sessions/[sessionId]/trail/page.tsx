'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrailPrintView } from '../../../../../../components/security/TrailPrintView';
import { adminSessionTrailCsvUrl, listOrgSessions } from '../../../../../../lib/api/admin-sessions';
import { apiBaseUrl, browserApiClient } from '../../../../../../lib/api/browser-client';
import { useT } from '../../../../../../lib/i18n/use-t';

/**
 * **R12 Save as PDF — one session's sign-in trail** (Figma 503:29576). Opened in a new tab from the
 * session drawer; prints itself once the trail CSV has loaded. The CSV route is `org.manage`.
 */
export default function AdminSessionTrailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; sessionId: string }>;
}) {
  const { orgSlug, sessionId } = use(params);
  const t = useT();
  const sessions = useQuery({
    queryKey: ['admin-sessions', orgSlug],
    queryFn: () => listOrgSessions(browserApiClient(), orgSlug),
  });
  const session = sessions.data?.find((row) => row.sessionId === sessionId);
  return (
    <TrailPrintView
      subject={session?.memberName ?? t('TrailPrint.sessionTitle')}
      meta={`${orgSlug} · ${t('SessionIntel.sessionWord')} ${sessionId}`}
      csvUrl={adminSessionTrailCsvUrl(apiBaseUrl(), orgSlug, sessionId)}
    />
  );
}
