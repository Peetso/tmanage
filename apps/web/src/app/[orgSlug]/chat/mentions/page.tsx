'use client';

import { use } from 'react';
import { MyMentionsScreen } from '../../../../components/screens/MyMentionsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **My mentions** (x254) — the caller's mentions inbox, the way into their `@`-mentions across chat.
 */
export default function ChatMentionsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <MyMentionsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
