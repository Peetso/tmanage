'use client';

import { use } from 'react';
import { ProjectChannelScreen } from '../../../../components/screens/ProjectChannelScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **TM-06 Project channel**, with TM-08's thread pane and TM-09's convert dialog inside.
 *
 * The conversation id is in the path for the reason the work item id is: it is not a
 * credential. The API answers 404 for a channel in another tenant exactly as for one that
 * does not exist — proved in `chat-001-conversations.db.test.ts` — so a link to a channel is
 * a link a colleague can follow.
 */
export default function ChannelPage({
  params,
}: {
  params: Promise<{ orgSlug: string; conversationId: string }>;
}) {
  const { orgSlug, conversationId } = use(params);

  return (
    <ProjectChannelScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      conversationId={conversationId}
    />
  );
}
