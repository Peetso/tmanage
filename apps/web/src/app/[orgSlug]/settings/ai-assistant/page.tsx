'use client';

import { use } from 'react';
import { AiAssistantScreen } from '../../../../components/screens/AiAssistantScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **AI assistant** — connect Claude, ChatGPT or any MCP assistant through the TManage MCP server.
 *
 * At `/{orgSlug}/settings/ai-assistant`, beside the Security (access tokens) screen it builds on.
 * Every member may open it: the keys are the member's own, behind `work.read`. The organization
 * name is still a fixture, the reason every sibling settings screen gives.
 */
export default function AiAssistantPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AiAssistantScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
