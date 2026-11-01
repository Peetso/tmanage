'use client';

import { use } from 'react';
import { TrailPrintView } from '../../../../components/security/TrailPrintView';
import { apiBaseUrl } from '../../../../lib/api/browser-client';
import { mySessionTrailCsvUrl } from '../../../../lib/api/session';
import { useT } from '../../../../lib/i18n/use-t';

/** **R12 Save as PDF — one of your own sessions' sign-in trail** (Figma 503:29576). */
export default function MySessionTrailPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const t = useT();
  return (
    <TrailPrintView
      subject={t('SessionIntel.yourSession')}
      meta={`${t('SessionIntel.sessionWord')} ${sessionId}`}
      csvUrl={mySessionTrailCsvUrl(apiBaseUrl(), sessionId)}
    />
  );
}
