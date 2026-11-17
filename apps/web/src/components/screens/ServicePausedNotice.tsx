'use client';

import { InlineAlert } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';

/**
 * ADMINSVC2 — what a workspace sees when a connected service is switched off for the platform:
 * the existing calm notice, not an error. Shown wherever {@link isServicePaused} matches.
 */
export function ServicePausedNotice() {
  const t = useT();
  return (
    <InlineAlert tone="neutral" title={t('platformServices.pausedTitle')} live>
      {t('platformServices.pausedBody')}
    </InlineAlert>
  );
}
