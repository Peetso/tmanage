'use client';

import { use } from 'react';
import { DirectMessageScreen } from '../../../../../components/screens/DirectMessageScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **d-conversation** — one direct message thread. The id is not a credential: the API answers
 * 404 for a conversation the caller is not part of exactly as for one that does not exist.
 */
export default function DirectMessagePage({
  params,
}: {
  params: Promise<{ orgSlug: string; directConversationId: string }>;
}) {
  const { orgSlug, directConversationId } = use(params);

  return (
    <DirectMessageScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      directConversationId={directConversationId}
    />
  );
}
