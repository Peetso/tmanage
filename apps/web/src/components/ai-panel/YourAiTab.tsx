'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Button, InfoButton, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { pendingAiApprovalsKey, type AiApprovalView } from '../../lib/api/ai-approvals';
import { aiActivityKey, aiPanelKey, type AiPanelView } from '../../lib/api/ai-panel';
import { usePendingAiApprovals } from '../ai-actions/pending-ai-actions';
import { AiActivitySection, ActivitySkeleton } from './AiActivitySection';
import { AiApprovalCard, AiApprovalReview } from './AiApprovalCard';
import { ConnectedAppCard } from './ConnectedAppCard';
import { ConnectYourAi } from './ConnectYourAi';
import { useAiPanelT } from './use-ai-panel-t';

export interface YourAiTabProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** The panel read; `undefined` while it loads. */
  readonly view: AiPanelView | undefined;
  readonly failed: boolean;
  readonly onRetry: () => void;
  /** The connector address assistants are given (`…/mcp`). */
  readonly address: string;
  /** On screen now: the activity refreshes only then. */
  readonly active: boolean;
  readonly now?: () => Date;
}

/**
 * Tab 2, "Your AI" (Figma 857:1014; nothing connected 857:1285; states 858:906; phone 860:1021).
 * Not a chat box: the member's AI runs in its own app, so this tab shows and manages it.
 * Order (Fable must-fix 1): Waiting for your approval (only when something waits), Activity,
 * Connected apps. Explanations sit behind one ⓘ per heading.
 */
export function YourAiTab({
  api,
  organizationSlug,
  view,
  failed,
  onRetry,
  address,
  active,
  now = () => new Date(),
}: YourAiTabProps) {
  const t = useAiPanelT();
  const queries = useQueryClient();
  const pending = usePendingAiApprovals(organizationSlug, api);
  const [reviewing, setReviewing] = useState<AiApprovalView | null>(null);

  function refresh() {
    void queries.invalidateQueries({ queryKey: pendingAiApprovalsKey(organizationSlug) });
    void queries.invalidateQueries({ queryKey: aiPanelKey(organizationSlug) });
    void queries.invalidateQueries({ queryKey: aiActivityKey(organizationSlug) });
  }

  if (failed) {
    return (
      <div className="tm-aip-body">
        <InlineAlert tone="danger" live>
          {t('AiPanel.loadFailed')}
        </InlineAlert>
        <div>
          <Button tone="outline" size="compact" className="tm-aip-touch" onClick={onRetry}>
            {t('AiPanel.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }
  if (view === undefined) {
    return (
      <div className="tm-aip-body">
        <ActivitySkeleton label={t('AiPanel.loading')} />
      </div>
    );
  }

  if (reviewing !== null) {
    return (
      <div className="tm-aip-body">
        <AiApprovalReview
          api={api}
          organizationSlug={organizationSlug}
          view={reviewing}
          onBack={() => setReviewing(null)}
          onDecided={refresh}
        />
      </div>
    );
  }

  if (view.apps.length === 0) {
    return (
      <div className="tm-aip-body">
        <ConnectYourAi organizationSlug={organizationSlug} address={address} />
      </div>
    );
  }

  const waiting = pending.data ?? [];
  const today = now();

  return (
    <div className="tm-aip-body">
      {waiting.length > 0 ? (
        <section className="tm-aip-section" aria-labelledby="tm-aip-waiting">
          <div className="tm-aip-section__head">
            <h3 id="tm-aip-waiting" className="tm-aip-section__title">
              {t('AiPanel.waiting.title')}
            </h3>
            <CountCapsule count={waiting.length} />
            <InfoButton title={t('AiPanel.waiting.title')} label={t('AiPanel.waiting.infoLabel')}>
              {t('AiPanel.waiting.info')}
            </InfoButton>
          </div>
          {waiting.map((approval) => (
            <AiApprovalCard
              key={approval.id}
              api={api}
              organizationSlug={organizationSlug}
              view={approval}
              onReview={setReviewing}
              onDecided={refresh}
            />
          ))}
          <Link
            className="tm-aip-link"
            href={`/${encodeURIComponent(organizationSlug)}/settings/ai-actions`}
          >
            {t('AiPanel.waiting.all')}
          </Link>
        </section>
      ) : null}

      <AiActivitySection api={api} organizationSlug={organizationSlug} active={active} now={now} />

      <section className="tm-aip-section" aria-labelledby="tm-aip-apps">
        <div className="tm-aip-section__head">
          <h3 id="tm-aip-apps" className="tm-aip-section__title">
            {t('AiPanel.apps.title')}
          </h3>
          <InfoButton title={t('AiPanel.apps.title')} label={t('AiPanel.apps.infoLabel')}>
            {t('AiPanel.apps.info')}
          </InfoButton>
        </div>
        {view.apps.map((app) => (
          <ConnectedAppCard
            key={app.grantId}
            api={api}
            organizationSlug={organizationSlug}
            app={app}
            now={today}
            onDisconnected={refresh}
          />
        ))}
      </section>
    </div>
  );
}

/** The waiting count: one warning-tone capsule on the tab and the heading (must-fix 6, T3). */
export function CountCapsule({
  count,
  label,
}: {
  readonly count: number;
  readonly label?: string;
}) {
  if (count <= 0) return null;
  return (
    <StateCapsule state="waiting" className="tm-aip-capsule tm-aip-count">
      <span aria-hidden={label === undefined ? undefined : true}>{count}</span>
      {label === undefined ? null : <span className="tm-visually-hidden">{label}</span>}
    </StateCapsule>
  );
}

/**
 * Tab 1 when the plan has TManage AI and the owner turned it off (Figma 857:1715 owner, 857:1761
 * member): one line with its ⓘ, the owner's way to turn it on, and the way to Your AI.
 */
export function TmanageAiOff({
  organizationSlug,
  canManage,
  showYourAi,
  onYourAi,
}: {
  readonly organizationSlug: string;
  readonly canManage: boolean;
  readonly showYourAi: boolean;
  readonly onYourAi: () => void;
}) {
  const t = useAiPanelT();
  return (
    <div className="tm-aip-off">
      <span className="tm-aip-off__lock" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      </span>
      <p className="tm-aip-off__line">
        {t('AiPanel.off.title')}
        <InfoButton title={t('AiPanel.off.title')} label={t('AiPanel.off.infoLabel')}>
          {t('AiPanel.off.info')}
        </InfoButton>
      </p>
      {canManage ? (
        <Link
          className="tm-button tm-button--ink tm-button--default"
          href={`/${encodeURIComponent(organizationSlug)}/admin/ai`}
        >
          {t('AiPanel.off.turnOn')}
        </Link>
      ) : (
        <p className="tm-aip-muted">{t('AiPanel.off.member')}</p>
      )}
      {showYourAi ? (
        <button type="button" className="tm-aip-link" onClick={onYourAi}>
          {t('AiPanel.off.goToYourAi')}
        </button>
      ) : null}
    </div>
  );
}
