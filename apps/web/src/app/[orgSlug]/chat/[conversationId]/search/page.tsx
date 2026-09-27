'use client';

import { use } from 'react';
import { ConversationSearchView } from '../../../../../components/screens/ConversationSearchView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **CH-10 Search in conversation** (x253). The in-channel search screen.
 *
 * The conversation id is in the path for the reason the channel page's is: it is not a
 * credential. The API answers 404 for a channel in another tenant exactly as for one that does
 * not exist, so a link to a channel's search is a link a colleague who can read it can follow.
 */
export default function ConversationSearchPage({
  params,
}: {
  params: Promise<{ orgSlug: string; conversationId: string }>;
}) {
  const { orgSlug, conversationId } = use(params);

  return (
    <ConversationSearchView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      conversationId={conversationId}
    />
  );
}
