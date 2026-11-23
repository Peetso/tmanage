'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  Field,
  LiveAnnouncer,
  LoadingRegion,
  Skeleton,
  SkipLink,
} from '@tmanage/ui';
import { ApiRequestError } from '../../lib/api/errors';
import { reauthenticate } from '../../lib/api/passkeys';
import { parseTypedAmount } from '../ai-chat/ai-chat-model';
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
  readableFields,
  subjectLine,
} from '../../lib/ai-approval-presentation';
import { useCatalogLookup } from '../../lib/i18n/use-catalog-lookup';
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
    // A money or HR action (`confirmation: 'step_up'`) is refused by the server without a fresh
    // step-up and, when it names an amount, the amount typed back (API lane AI-PANEL-API).
    mutationFn: async ({ decision, stepUp }: Decision) => {
      if (decision === 'decline' || stepUp === undefined) {
        return decideAiApproval(api, orgSlug, approvalId, decision);
      }
      const reauthToken = await reauthenticate(api, { password: stepUp.password });
      return decideAiApproval(api, orgSlug, approvalId, 'approve', {
        reauthToken,
        ...(stepUp.amount === undefined ? {} : { amount: stepUp.amount }),
      });
    },
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
              stepUpFailed={
                decide.error instanceof ApiRequestError &&
                (decide.error.status === 401 || decide.error.code === 'reauthentication_required')
              }
              onDecide={(decision, stepUp) =>
                decide.mutate(stepUp === undefined ? { decision } : { decision, stepUp })
              }
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

interface StepUp {
  readonly password: string;
  readonly amount?: number;
}

interface Decision {
  readonly decision: 'approve' | 'decline';
  readonly stepUp?: StepUp;
}

interface ApprovalBodyProps {
  view: AiApprovalView;
  now: () => number;
  busy: boolean;
  failed: boolean;
  stepUpFailed: boolean;
  onDecide: (decision: 'approve' | 'decline', stepUp?: StepUp) => void;
}

function ApprovalBody({ view, now, busy, failed, stepUpFailed, onDecide }: ApprovalBodyProps) {
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
  const stepUp = view.confirmation === 'step_up';
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [wrongAmount, setWrongAmount] = useState(false);

  function approve() {
    if (!stepUp) {
      onDecide('approve');
      return;
    }
    let amount: number | undefined;
    if (view.amount !== null) {
      const value = parseTypedAmount(typed);
      if (value === null || value !== view.amount) {
        setWrongAmount(true);
        return;
      }
      amount = value;
    }
    setWrongAmount(false);
    if (password === '') return;
    onDecide('approve', amount === undefined ? { password } : { password, amount });
  }

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
          {readableFields(view.summary.fields).map((field) => (
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

      {stepUp ? (
        <div className="tm-approve__stepup">
          {view.amount !== null ? (
            <Field
              label={t('AiChat.card.typeAmount')}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              dir="ltr"
              required
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
              {...(wrongAmount ? { error: t('AiChat.card.wrongAmount') } : {})}
            />
          ) : null}
          <p className="tm-approve__kind">{t('AiChat.card.stepUpTitle')}</p>
          <p className="tm-approve__note">{t('AiChat.card.stepUpBody')}</p>
          <Field
            label={t('AiChat.card.password')}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            {...(stepUpFailed ? { error: t('AiChat.card.stepUpFailed') } : {})}
          />
        </div>
      ) : null}

      {failed && !stepUpFailed ? (
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
          onClick={approve}
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
