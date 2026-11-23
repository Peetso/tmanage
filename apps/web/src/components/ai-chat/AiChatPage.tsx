'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { browserApiClient } from '../../lib/api/browser-client';
import { ApiRequestError } from '../../lib/api/errors';
import { listAiConversations } from '../../lib/api/ai-chat';
import { CopilotAnswerView } from '../screens/CopilotAnswerView';
import { AiChatPanel, AI_CONVERSATIONS_KEY } from './AiChatPanel';
import { OwnAiPointer } from './OwnAiPointer';
import { useAiText } from './use-ai-text';

/**
 * `/[orgSlug]/copilot` (plan 62-15): TManage AI as a page (the phone layout, Figma 765:43701)
 * where the workspace has it; anywhere else the earlier copilot answer view is unchanged. The
 * read that decides is the member's own conversation list: 404 = no TManage AI here. Any other
 * failure is the unknown state with a retry, never "absent" (AR-10, DC-1), and keeps the member's
 * own AI in sight (AI-TWO-WAYS).
 */
export function AiChatPage({
  organizationSlug,
  organizationName,
  initialQuestion,
  client,
}: {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly initialQuestion?: string;
  readonly client?: ApiClient;
}) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const { t } = useAiText();
  const probe = useQuery({
    queryKey: AI_CONVERSATIONS_KEY(organizationSlug),
    queryFn: () => listAiConversations(api, organizationSlug),
    retry: false,
  });

  if (probe.isPending) {
    return (
      <div className="tm-aic-page-state" aria-busy="true">
        <Skeleton />
      </div>
    );
  }
  if (probe.isError) {
    const absent =
      probe.error instanceof ApiRequestError &&
      (probe.error.status === 404 || probe.error.status === 403);
    if (absent) {
      return (
        <CopilotAnswerView
          organizationSlug={organizationSlug}
          organizationName={organizationName}
          client={api}
          {...(initialQuestion === undefined ? {} : { initialQuestion })}
        />
      );
    }
    return (
      <div className="tm-aic-page-state">
        <InlineAlert tone="danger" live>
          {t('AiChat.offline')}
        </InlineAlert>
        <Button tone="outline" size="compact" onClick={() => void probe.refetch()}>
          {t('AiChat.tryAgain')}
        </Button>
        <OwnAiPointer organizationSlug={organizationSlug} />
      </div>
    );
  }
  return (
    <AiChatPanel
      organizationSlug={organizationSlug}
      variant="page"
      client={api}
      {...(initialQuestion === undefined ? {} : { initialQuestion })}
    />
  );
}
