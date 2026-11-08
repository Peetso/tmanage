'use client';

import { use } from 'react';
import { InboundMailSettingsScreen } from '../../../../components/screens/InboundMailSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Inbound mail (54-12)** at `/{orgSlug}/settings/inbound-mail`: the inbound address, who may
 * send, and the newest messages. The organization name is still a fixture, the reason every
 * sibling settings screen gives.
 */
export default function InboundMailPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <InboundMailSettingsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
