'use client';

import { use } from 'react';
import { WebhookEndpointsScreen } from '../../../../../components/screens/WebhookEndpointsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Webhooks** — the Automations outbound-webhook admin (module 17, x166).
 *
 * Like `admin/audit` and `billing`, it is not one of the internal-rail destinations, so this route
 * names none and adds no nav entry — it is reached directly. The screen reads/writes
 * `…/automations/webhooks`, gated on `org.manage`, so a caller without the capability sees the API's
 * refusal rather than a blank page.
 */
export default function WebhookEndpointsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <WebhookEndpointsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
