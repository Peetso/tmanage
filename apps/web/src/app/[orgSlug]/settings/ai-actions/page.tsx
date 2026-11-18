'use client';

import { use } from 'react';
import { AiActionsScreen } from '../../../../components/screens/AiActionsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **AI actions** (55-15p) — the member's own actions an AI assistant asked for, waiting for
 * approval. At `/{orgSlug}/settings/ai-actions`, under AI assistant in the settings menu. The
 * organization name is still a fixture, the reason every sibling settings screen gives.
 */
export default function AiActionsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AiActionsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
