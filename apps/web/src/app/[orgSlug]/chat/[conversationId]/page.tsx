'use client';

import { use } from 'react';
import { ProjectChannelScreen } from '../../../../components/screens/ProjectChannelScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';
import {
  CHAT_WORKSPACE_PARAM,
  chatWorkspaceFrom,
} from '../../../../components/chat/chat-workspaces';

/**
 * **TM-06 Project channel**, with TM-08's thread pane and TM-09's convert dialog inside.
 *
 * The conversation id is in the path for the reason the work item id is: it is not a
 * credential. The API answers 404 for a channel in another tenant exactly as for one that
 * does not exist — proved in `chat-001-conversations.db.test.ts` — so a link to a channel is
 * a link a colleague can follow.
 *
 * R38 G2: `?ws=<slug>` opens a conversation of another workspace the person belongs to, read
 * under their membership there, while the app frame stays in `orgSlug`.
 */
export default function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; conversationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug, conversationId } = use(params);
  const chatSlug = chatWorkspaceFrom(orgSlug, use(searchParams)[CHAT_WORKSPACE_PARAM]);

  return (
    <ProjectChannelScreen
      organizationSlug={chatSlug ?? orgSlug}
      {...(chatSlug === undefined ? {} : { shellOrganizationSlug: orgSlug })}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      conversationId={conversationId}
    />
  );
}
