'use client';

import { use } from 'react';
import { AiUsageScreen } from '../../../../../components/ai-admin/AiUsageScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **AI usage** — Control Center › AI › Usage (plan 62-18). The screen reads `GET …/ai/credits`
 * (`billing.view`); a workspace without TManage AI gets the API's 404 and the page says so.
 */
export default function AiUsagePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return <AiUsageScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
