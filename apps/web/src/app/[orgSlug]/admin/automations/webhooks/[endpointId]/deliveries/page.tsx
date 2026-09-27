'use client';

import { use } from 'react';
import { WebhookDeliveryScreen } from '../../../../../../../components/screens/WebhookDeliveryScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../../lib/fixtures';

/**
 * **Webhook deliveries** — the Automations delivery log for one endpoint (module 17, x221).
 *
 * Like the sibling `webhooks` admin, it is not an internal-rail destination and adds no nav entry —
 * it is reached from an endpoint. The screen reads `…/automations/webhooks/:endpointId/deliveries`,
 * gated on `org.manage`, so a caller without the capability sees the API's refusal rather than a
 * blank page.
 */
export default function WebhookDeliveriesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; endpointId: string }>;
}) {
  const { orgSlug, endpointId } = use(params);

  return (
    <WebhookDeliveryScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      endpointId={endpointId}
    />
  );
}
