'use client';

import { use } from 'react';
import { PlatformOutreachCampaignScreen } from '../../../../../components/platform/settings/PlatformOutreachCampaignScreen';

/** Platform admin — one outreach campaign (OUTREACH MANAGER): e-mail, follow-up, recipients. */
export default function Page({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = use(params);
  return <PlatformOutreachCampaignScreen campaignId={campaignId} />;
}
