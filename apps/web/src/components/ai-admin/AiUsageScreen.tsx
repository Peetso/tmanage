'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ControlCenterShell, ccKey } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { fetchAiCredits } from '../../lib/api/ai-credits';
import { useTOr } from '../../lib/i18n/use-t-or';
import { AI_CREDITS_KEY } from '../ai-chat/AiChatPanel';
import { useAiText } from '../ai-chat/use-ai-text';
import { AiAdminTabs } from './AiAdminTabs';
import { AiCreditsBlock } from './AiCreditsBlock';
import './ai-admin.css';

/**
 * Control Center › AI › Usage (plan 62-18): the month's AI credits with the pack request
 * (Figma G14 772:46242 and review fixes 789:51488–789:51726), plus what one member may use and
 * what running answers hold. The API has no per-member or per-answer breakdown yet, so the page
 * shows the workspace totals only.
 */
export function AiUsageScreen({
  organizationSlug,
  organizationName,
  client,
}: {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
}) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const tOr = useTOr();
  const { t, credits } = useAiText();
  // The block owns the states; this read shares its cache for the two lines below it.
  const view = useQuery({
    queryKey: AI_CREDITS_KEY(organizationSlug),
    queryFn: () => fetchAiCredits(api, organizationSlug),
    retry: false,
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="ai"
      crumbs={[tOr(ccKey('ControlCenter.ai'), 'AI')]}
      title={t('AiUsage.title')}
      description={t('AiUsage.lead')}
      client={api}
    >
      <AiAdminTabs organizationSlug={organizationSlug} current="usage" />
      <div className="tm-aia-usage">
        <AiCreditsBlock organizationSlug={organizationSlug} client={api} placement="usage" />
        {view.isSuccess ? (
          <dl className="tm-aia-figures">
            <div className="tm-aia-figure">
              <dt className="tm-aia-muted">{t('AiUsage.memberShare')}</dt>
              <dd>{credits(view.data.memberShareCredits)}</dd>
            </div>
            {view.data.heldCredits > 0 ? (
              <div className="tm-aia-figure">
                <dt className="tm-aia-muted">{t('AiUsage.held')}</dt>
                <dd>{credits(view.data.heldCredits)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </ControlCenterShell>
  );
}
