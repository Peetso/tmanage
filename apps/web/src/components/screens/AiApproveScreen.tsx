'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { decideAiApproval, getAiApproval } from '../../lib/api/ai-approvals';
import type { AiApprovalView } from '../../lib/api/ai-approvals';
import type { ApiClient } from '../../lib/api/client';
import {
  clientInitial,
  fillTemplate,
  formatCountdown,
  localizedFieldLabel,
  localizedOpTitle,
  subjectLine,
} from '../../lib/ai-approval-presentation';
import type { CatalogLookup } from '../../lib/ai-approval-presentation';
import { translate, type MessageKey } from '../../lib/i18n/t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/ai-approve.css';

export interface AiApproveScreenProps {
  orgSlug: string;
  approvalId: string;
  client?: ApiClient;
  /** Injected by tests; defaults to the wall clock. */
  now?: () => number;
}

/**
 * **S0-3 Approve action** (MCP connector S10, Figma 365:1214 / 365:1251; result states
 * 365:1288 / 365:1307).
 *
 * An AI app asked to do something that needs a person — a delete, a send, an invite. This page
 * shows exactly what will happen, as the server describes it (never as the AI worded it), and
 * the member decides. Approve runs the action on the server, once; Decline runs nothing. The
 * request expires after ten minutes and can be used only by the member it was made for — anyone
 * else sees "Not available", the same as a link that never existed.
 */
export function AiApproveScreen({
  orgSlug,
  approvalId,
  client,
  now = Date.now,
}: AiApproveScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['ai-approval', orgSlug, approvalId] as const;

  const approval = useQuery({
    queryKey,
    queryFn: () => getAiApproval(api, orgSlug, approvalId),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'decline') =>
      decideAiApproval(api, orgSlug, approvalId, decision),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
  });

  return (
    <LiveAnnouncer label={t('Shell.liveAnnouncements')}>
      <div className="tm-approve">
        <SkipLink targetId="tm-main">{t('Shell.skipLink')}</SkipLink>
        <main id="tm-main" className="tm-approve__card" tabIndex={-1}>
          <BrandLockup />
          {approval.isPending ? (
            <LoadingRegion label={t('aiApprove.loading')}>
              <Skeleton height="var(--t-heading-page-line)" />
              <Skeleton height="var(--s24)" />
            </LoadingRegion>
          ) : approval.isError || approval.data === undefined ? (
            <OutcomeCard
              tone="muted"
              title={t('aiApprove.unavailableTitle')}
              body={t('aiApprove.unavailableBody')}
            />
          ) : (
            <ApprovalBody
              view={approval.data}
              now={now}
              busy={decide.isPending}
              failed={decide.isError}
              onDecide={(decision) => decide.mutate(decision)}
            />
          )}
        </main>
      </div>
    </LiveAnnouncer>
  );
}

function BrandLockup() {
  return (
    <div className="tm-approve__brand">
      <span className="tm-approve__orb" aria-hidden="true" />
      <span className="tm-approve__brand-name" dir="ltr">
        TManage
      </span>
    </div>
  );
}

interface ApprovalBodyProps {
  view: AiApprovalView;
  now: () => number;
  busy: boolean;
  failed: boolean;
  onDecide: (decision: 'approve' | 'decline') => void;
}

/**
 * A lookup for keys built at run time (registry op ids, argument ids): the catalog string, or
 * `undefined` when neither catalog holds the key, so the caller keeps the server's English.
 */
function useCatalogLookup(): CatalogLookup {
  const locale = useActiveLocale();
  return useCallback(
    (key: string) => {
      const text = translate(locale, key as MessageKey);
      return text === key ? undefined : text;
    },
    [locale],
  );
}

function ApprovalBody({ view, now, busy, failed, onDecide }: ApprovalBodyProps) {
  const t = useT();
  const lookup = useCatalogLookup();
  const formatters = useDisplayFormatters();
  const expiresAt = Date.parse(view.expiresAt);
  const [msLeft, setMsLeft] = useState(() => expiresAt - now());

  useEffect(() => {
    if (view.status !== 'pending') return undefined;
    const timer = window.setInterval(() => setMsLeft(expiresAt - now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, now, view.status]);

  const status = view.status === 'pending' && msLeft <= 0 ? 'expired' : view.status;
  const destructive = view.summary.destructive;
  const subject = subjectLine(lookup, view.summary.subject, destructive);

  if (status !== 'pending') {
    const time = view.decidedAt
      ? formatters.dateTime(view.decidedAt, { hour: 'numeric', minute: '2-digit' })
      : '';
    if (status === 'approved') {
      return (
        <OutcomeCard
          tone="success"
          title={t('aiApprove.approvedTitle')}
          body={fillTemplate(
            t(destructive ? 'aiApprove.approvedBodyDelete' : 'aiApprove.approvedBody'),
            { time },
          )}
        />
      );
    }
    const key = {
      expired: ['aiApprove.expiredTitle', 'aiApprove.expiredBody'],
      declined: ['aiApprove.declinedTitle', 'aiApprove.declinedBody'],
      failed: ['aiApprove.failedTitle', 'aiApprove.failedBody'],
    } as const;
    const [title, body] = key[status];
    return <OutcomeCard tone="muted" title={t(title)} body={t(body)} />;
  }

  return (
    <>
      <p className="tm-approve__eyebrow">{t('aiApprove.eyebrow')}</p>
      <h1 className="tm-approve__title">{t('aiApprove.title')}</h1>

      <div className="tm-approve__requester">
        <span className="tm-approve__client-orb" aria-hidden="true" dir="ltr">
          {clientInitial(view.clientName)}
        </span>
        <p className="tm-approve__requester-text">
          {fillTemplate(t('aiApprove.requestedBy'), {
            client: view.clientName,
            name: view.memberName,
          })}
        </p>
        <Avatar name={view.memberName} size="compact" decorative />
      </div>

      <section className="tm-approve__action" aria-labelledby="tm-approve-action">
        <p
          id="tm-approve-action"
          className={`tm-approve__kind${destructive ? ' tm-approve__kind--danger' : ''}`}
        >
          {localizedOpTitle(lookup, view.summary.opId, view.summary.title)}
        </p>
        {subject === null ? null : <p className="tm-approve__subject">{subject}</p>}
        <hr className="tm-approve__rule" />
        <dl className="tm-approve__fields">
          {view.summary.fields.map((field) => (
            <div key={field.name} className="tm-approve__field">
              <dt>{localizedFieldLabel(lookup, field.name)}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
        {destructive ? <p className="tm-approve__warning">{t('aiApprove.warningDelete')}</p> : null}
      </section>

      <div className="tm-approve__expiry">
        <span className="tm-approve__timer">
          <span aria-hidden="true">⏱</span>{' '}
          <span role="timer">
            {fillTemplate(t('aiApprove.expiresIn'), { time: formatCountdown(msLeft) })}
          </span>
        </span>
        <p className="tm-approve__note">{t('aiApprove.singleUse')}</p>
      </div>

      {failed ? (
        <p className="tm-approve__warning" role="alert">
          {t('aiApprove.decideError')}
        </p>
      ) : null}

      <div className="tm-approve__actions">
        <Button tone="outline" disabled={busy} onClick={() => onDecide('decline')}>
          {t('aiApprove.decline')}
        </Button>
        <Button
          tone={destructive ? 'destructive' : 'ink'}
          className={destructive ? 'tm-approve__confirm--danger' : undefined}
          disabled={busy}
          onClick={() => onDecide('approve')}
        >
          {busy
            ? t('aiApprove.working')
            : t(destructive ? 'aiApprove.approveDelete' : 'aiApprove.approve')}
        </Button>
      </div>

      <p className="tm-approve__note">
        {fillTemplate(t('aiApprove.signedInAs'), { email: view.memberEmail })}
      </p>
    </>
  );
}

function OutcomeCard({
  tone,
  title,
  body,
}: {
  tone: 'success' | 'muted';
  title: string;
  body: string;
}) {
  return (
    <section className={`tm-approve__outcome tm-approve__outcome--${tone}`} role="status">
      <div className="tm-approve__outcome-head">
        <span className="tm-approve__outcome-badge" aria-hidden="true">
          {tone === 'success' ? '✓' : '×'}
        </span>
        <h1 className="tm-approve__outcome-title">{title}</h1>
      </div>
      <p className="tm-approve__note">{body}</p>
    </section>
  );
}
