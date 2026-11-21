'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { creditsTone, fetchAiCredits, requestAiPack } from '../../lib/api/ai-credits';
import type { AiCreditsView } from '../../lib/api/ai-credits';
import { AI_CREDITS_KEY } from '../ai-chat/AiChatPanel';
import '../ai-chat/ai-chat.css';
import { useAiText } from '../ai-chat/use-ai-text';
import './ai-admin.css';

/** The earliest expiry of the packs still holding credits: "use by 31 May". */
export function packsUseBy(view: AiCreditsView): string | null {
  let earliest: string | null = null;
  for (const pack of view.packs) {
    if (pack.remainingCredits <= 0) continue;
    if (earliest === null || pack.expiresAt < earliest) earliest = pack.expiresAt;
  }
  return earliest;
}

export interface AiCreditsBlockProps {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
  /**
   * `plan`: the block inside the Plan page (Figma G14 772:46242), with "See AI usage" and drawn
   * only when the workspace has TManage AI. `usage`: the Usage tab, which says why it is empty.
   */
  readonly placement: 'plan' | 'usage';
}

/**
 * "AI credits this month" (Figma G14 772:46242; review fixes 789:51488 low, 789:51560 request
 * open, 789:51637 request declined): the month's meter in words and a bar, extra credits from
 * packs, the reset date, and "Get more credits" for an owner who may ask (`canRequestPack`). Every
 * figure and the right to ask come from `GET …/ai/credits` (AR-9); one open request at a time.
 */
export function AiCreditsBlock({ organizationSlug, client, placement }: AiCreditsBlockProps) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const queryClient = useQueryClient();
  const { t, number, day } = useAiText();
  const credits = useQuery({
    queryKey: AI_CREDITS_KEY(organizationSlug),
    queryFn: () => fetchAiCredits(api, organizationSlug),
    retry: false,
  });
  const ask = useMutation({
    mutationFn: () => requestAiPack(api, organizationSlug),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AI_CREDITS_KEY(organizationSlug) });
    },
  });

  if (credits.isPending) {
    return placement === 'plan' ? null : (
      <div className="tm-aia-credits" aria-busy="true">
        <Skeleton />
      </div>
    );
  }
  if (credits.isError) {
    const status = credits.error instanceof ApiRequestError ? credits.error.status : 0;
    if (placement === 'plan') return null;
    if (status === 404 || status === 403) {
      return (
        <InlineAlert tone="neutral">
          {t(status === 404 ? 'AiUsage.notOn' : 'AiUsage.noAccess')}
        </InlineAlert>
      );
    }
    return (
      <div className="tm-aia-state">
        <InlineAlert tone="danger" live>
          {t('AiUsage.loadFailed')}
        </InlineAlert>
        <div>
          <Button tone="outline" size="compact" onClick={() => void credits.refetch()}>
            {t('AiUsage.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }

  const view = credits.data;
  const used = view.usedCredits + view.heldCredits;
  const total = view.allowanceCredits + view.packCreditsThisMonth;
  const tone = creditsTone(used, total);
  const share = total <= 0 ? 1 : Math.min(1, used / total);
  const usedText = t('AiUsage.used', { used: number(used), total: number(total) });
  const useBy = packsUseBy(view);
  const open = view.openRequest?.status === 'open' ? view.openRequest : null;
  const declined = view.openRequest?.status === 'declined';
  const askFailed =
    ask.isError && !(ask.error instanceof ApiRequestError && ask.error.status === 409);
  const mayAsk = view.canRequestPack && open === null && !ask.isPending;
  const offerAsk = mayAsk && (declined || tone !== 'default');

  const block = (
    <div className="tm-aia-credits">
      <div className="tm-aia-row">
        <h2 className="tm-aia-credits__title">{t('AiUsage.thisMonth')}</h2>
        <span className="tm-aia-spacer" />
        <span className="tm-aia-muted">{usedText}</span>
      </div>
      <div
        className="tm-aic-meter tm-aia-meter"
        data-tone={tone}
        role="meter"
        aria-label={t('AiUsage.thisMonth')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(used, total)}
        aria-valuetext={usedText}
      >
        <span style={{ inlineSize: `${String(share * 100)}%` }} />
      </div>
      {view.packBalanceCredits > 0 ? (
        <p className="tm-aia-credits__extra">
          {useBy === null
            ? t('AiUsage.extra', { count: number(view.packBalanceCredits) })
            : t('AiUsage.extraUseBy', {
                count: number(view.packBalanceCredits),
                date: day(useBy),
              })}
        </p>
      ) : null}
      <p className="tm-aia-muted">{t('AiUsage.resets', { date: day(view.resetsOn) })}</p>
      <div aria-live="polite" className="tm-aia-credits__notice">
        {open !== null ? (
          <InlineAlert tone="neutral">
            {t('AiUsage.requestOpen', { date: day(open.requestedAt) })}
          </InlineAlert>
        ) : declined ? (
          <InlineAlert tone="neutral">{t('AiUsage.requestDeclined')}</InlineAlert>
        ) : null}
        {askFailed ? <InlineAlert tone="danger">{t('AiUsage.requestFailed')}</InlineAlert> : null}
      </div>
      {offerAsk || placement === 'plan' ? (
        <div className="tm-aia-row tm-aia-credits__actions">
          {offerAsk ? (
            <Button
              tone="outline"
              size="accessible"
              loading={ask.isPending}
              onClick={() => ask.mutate()}
            >
              {t(declined ? 'AiUsage.askAgain' : 'AiUsage.getMore')}
            </Button>
          ) : null}
          {placement === 'plan' ? (
            <Link
              href={`/${encodeURIComponent(organizationSlug)}/admin/ai/usage`}
              className="tm-button tm-button--text tm-button--accessible"
            >
              {t('AiUsage.seeUsage')}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  // On the Plan page the block is its own card (Figma G14 772:46252 inside the plan card).
  return placement === 'plan' ? (
    <section className="tm-pu-card" aria-label={t('AiUsage.thisMonth')}>
      {block}
    </section>
  ) : (
    block
  );
}
