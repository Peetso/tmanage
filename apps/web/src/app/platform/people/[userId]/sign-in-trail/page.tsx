'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrailPrintView } from '../../../../../components/security/TrailPrintView';
import { apiBaseUrl, browserApiClient } from '../../../../../lib/api/browser-client';
import {
  fetchPlatformPerson,
  personSignInTrailCsvUrl,
} from '../../../../../lib/api/platform-people';
import { useT } from '../../../../../lib/i18n/use-t';

/**
 * **R12 Save as PDF — one person's sign-in trail** (Figma 503:29576), for platform staff with
 * `platform.people.security`. Prints itself once the trail CSV has loaded.
 */
export default function PersonSignInTrailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const t = useT();
  const person = useQuery({
    queryKey: ['platform', 'people', 'detail', userId],
    queryFn: () => fetchPlatformPerson(browserApiClient(), userId),
  });
  return (
    <TrailPrintView
      subject={person.data?.displayName ?? t('TrailPrint.personTitle')}
      meta={person.data?.email ?? userId}
      csvUrl={personSignInTrailCsvUrl(apiBaseUrl(), userId)}
    />
  );
}
