'use client';

import { useMemo, type ReactNode } from 'react';
import { UiLabelsProvider, type UiLabels } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';

/**
 * The design system's own words (the busy button, the skip link, the live region, toasts, the
 * empty combobox) in the active locale, given once at the root. Without it every primitive fell
 * back to English, so the Arabic client portal read "Skip to main content" and "Working"
 * (TESTUX P0 3) on screens whose every other word was Arabic.
 */
export function UiLabelsFromCatalog({ children }: { children: ReactNode }) {
  const t = useT();
  const labels = useMemo<UiLabels>(
    () => ({
      working: t('UiLabels.working'),
      skipToMain: t('UiLabels.skipToMain'),
      liveAnnouncements: t('UiLabels.liveAnnouncements'),
      notifications: t('UiLabels.notifications'),
      dismissNotification: t('UiLabels.dismissNotification'),
      noMatches: t('UiLabels.noMatches'),
    }),
    [t],
  );
  return <UiLabelsProvider labels={labels}>{children}</UiLabelsProvider>;
}
