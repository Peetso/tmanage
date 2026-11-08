'use client';

import { use } from 'react';
import { ChannelNoticesScreen } from '../../../../components/screens/ChannelNoticesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Control center > Slack and Teams notices** (54-05/54-06, R46 L2) at
 * `/{orgSlug}/settings/channel-notices`. The organization name is resolved inside the shell.
 */
export default function ChannelNoticesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <ChannelNoticesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
