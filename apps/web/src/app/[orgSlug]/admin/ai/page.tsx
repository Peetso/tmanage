'use client';

import { use } from 'react';
import { AiSettingsScreen } from '../../../../components/ai-admin/AiSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **TManage AI settings** — Control Center › AI › Settings (plan 62-17). The screen reads
 * `GET …/copilot/settings`, owner only; anyone else gets the API's 403 and the page says so.
 */
export default function AiSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AiSettingsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
