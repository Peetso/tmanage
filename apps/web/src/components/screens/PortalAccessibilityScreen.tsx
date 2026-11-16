'use client';

import { ClientPortalShell } from '../shell/ClientPortalShell';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { AccessibilityPreferencesPanel } from './AccessibilityScreen';

export interface PortalAccessibilityScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Display and accessibility** in the client portal (PORTALA11Y). The member app's approved
 * accessibility form, inside the portal shell: the signed-in client sets their own text size, high
 * contrast and reduced motion, saved to their own client membership and applied on every portal page.
 */
export function PortalAccessibilityScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: PortalAccessibilityScreenProps) {
  const t = useT();
  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      title={t('PortalAccessibilityScreen.title')}
      description={t('PortalAccessibilityScreen.description')}
    >
      <AccessibilityPreferencesPanel
        organizationSlug={organizationSlug}
        audience="client"
        {...(client ? { client } : {})}
      />
    </ClientPortalShell>
  );
}
