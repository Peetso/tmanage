'use client';

import { use } from 'react';
import { ConnectAiHelpScreen } from '../../../../components/screens/ConnectAiHelpScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Connect an AI** — the help page every member can open at `/{orgSlug}/help/connect-ai` (S12).
 *
 * The organization name is resolved from the session's own organization list inside the screen;
 * the fixture is only the placeholder every sibling page passes until a per-organization read
 * exists, and it is never shown.
 */
export default function ConnectAiHelpPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <ConnectAiHelpScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
