'use client';

import { useId, useState } from 'react';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { decideAiApproval, type AiApprovalView } from '../../lib/api/ai-approvals';
import { ApiRequestError } from '../../lib/api/errors';
import { reauthenticate } from '../../lib/api/passkeys';
import {
  localizedFieldLabel,
  localizedOpTitle,
  readableFields,
} from '../../lib/ai-approval-presentation';
import { useFormCheck } from '../../lib/forms/form-check';
import { useCatalogLookup } from '../../lib/i18n/use-catalog-lookup';
import { parseTypedAmount } from '../ai-chat/ai-chat-model';
import { LockIcon } from '../ai-chat/icons';
import { useAiText } from '../ai-chat/use-ai-text';
import type { ApprovalOutcome } from './ai-panel-model';
import { useAiPanelT } from './use-ai-panel-t';

/** A request answered here that the server says is no longer waiting: it ended. */
function endedByServer(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 409);
}

/** "From Claude · ends 14:30": who asked, and until when. */
function FromLine({ view }: { readonly view: AiApprovalView }) {
  const t = useAiPanelT();
  const { time } = useAiText();
  return (
    <p className="tm-aip-note">
      {t('AiPanel.approval.from', { client: view.clientName, time: time(view.expiresAt) })}
    </p>
  );
}

/** The fields the server built from the action registry, never the AI's own words. */
function ApprovalFields({ view }: { readonly view: AiApprovalView }) {
  const lookup = useCatalogLookup();
  const fields = readableFields(view.summary.fields);
  if (fields.length === 0) return null;
  return (
    <dl className="tm-aip-fields">
      {fields.map((field) => (
        <div key={field.name} className="tm-aip-fields__row">
          <dt>{localizedFieldLabel(lookup, field.name)}</dt>
          <dd>
            <bdi>{field.value}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface AiApprovalCardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly view: AiApprovalView;
  /** Money or HR (`confirmation: 'step_up'`): "Review" opens the step-up card in this tab. */
  readonly onReview: (view: AiApprovalView) => void;
  /** The waiting list, the tab count and the activity are read again after an answer. */
  readonly onDecided: () => void;
  /** Injected by stories and tests to draw an answered card. */
  readonly initialOutcome?: ApprovalOutcome;
}

/**
 * One request in "Waiting for your approval" (Figma 857:1014; states 858:906: approved, rejected,
 * ended, approve failed; money/HR 858:1366). Reject at the start, Approve (Ink) at the far end.
 * A money or HR request never gets a one-click Approve: it shows "Needs your confirmation" and
 * "Review" (gap 3). The server refuses a bare approve of it either way; the screen is not the
 * control.
 */
export function AiApprovalCard({
  api,
  organizationSlug,
  view,
  onReview,
  onDecided,
  initialOutcome = { kind: 'open' },
}: AiApprovalCardProps) {
  const t = useAiPanelT();
  const { time } = useAiText();
  const lookup = useCatalogLookup();
  const titleId = useId();
  const [outcome, setOutcome] = useState<ApprovalOutcome>(initialOutcome);
  const needsReview = view.confirmation !== 'none';

  async function decide(decision: 'approve' | 'decline') {
    setOutcome({ kind: decision === 'approve' ? 'approving' : 'rejecting' });
    try {
      const next = await decideAiApproval(api, organizationSlug, view.id, decision);
      const at = next.decidedAt ?? new Date().toISOString();
      setOutcome(
        next.status === 'approved'
          ? { kind: 'approved', at }
          : next.status === 'declined'
            ? { kind: 'rejected', at }
            : next.status === 'expired'
              ? { kind: 'ended', at: view.expiresAt }
              : { kind: 'failed' },
      );
      onDecided();
    } catch (error) {
      if (endedByServer(error)) {
        setOutcome({ kind: 'ended', at: view.expiresAt });
        onDecided();
      } else {
        setOutcome({ kind: 'failed' });
      }
    }
  }

  const busy = outcome.kind === 'approving' || outcome.kind === 'rejecting';
  const title = localizedOpTitle(lookup, view.summary.opId, view.summary.title);

  return (
    <article className="tm-aip-card" aria-labelledby={titleId}>
      <div className="tm-aip-card__head">
        <h4 id={titleId} className="tm-aip-card__title">
          <bdi>{title}</bdi>
        </h4>
        {needsReview ? (
          <StateCapsule state="waiting" className="tm-aip-capsule">
            {t('AiPanel.approval.needsConfirmation')}
          </StateCapsule>
        ) : view.summary.notifies ? (
          <StateCapsule className="tm-aip-capsule">{t('AiPanel.approval.sendsEmail')}</StateCapsule>
        ) : null}
      </div>
      {view.summary.subject ? (
        <p className="tm-aip-card__subject">
          <bdi>{view.summary.subject}</bdi>
        </p>
      ) : null}
      <ApprovalFields view={view} />
      <FromLine view={view} />

      {outcome.kind === 'approved' || outcome.kind === 'rejected' || outcome.kind === 'ended' ? (
        <p className="tm-aip-card__result" role="status">
          <StateCapsule
            state={
              outcome.kind === 'approved'
                ? 'done'
                : outcome.kind === 'ended'
                  ? 'archived'
                  : 'neutral'
            }
            className="tm-aip-capsule"
          >
            {t(
              outcome.kind === 'approved'
                ? 'AiPanel.approval.approved'
                : outcome.kind === 'rejected'
                  ? 'AiPanel.approval.rejected'
                  : 'AiPanel.approval.ended',
            )}
          </StateCapsule>
          <span className="tm-aip-note">
            {t(
              outcome.kind === 'approved'
                ? 'AiPanel.approval.approvedAt'
                : outcome.kind === 'rejected'
                  ? 'AiPanel.approval.rejectedAt'
                  : 'AiPanel.approval.endedAt',
              { time: time(outcome.at) },
            )}
          </span>
        </p>
      ) : (
        <>
          {outcome.kind === 'failed' ? (
            <InlineAlert tone="danger" live>
              {t('AiPanel.approval.failed')}
            </InlineAlert>
          ) : null}
          <div className="tm-aip-card__actions">
            <Button
              tone="outline"
              size="compact"
              className="tm-aip-touch"
              disabled={busy}
              loading={outcome.kind === 'rejecting'}
              onClick={() => void decide('decline')}
            >
              {t('AiPanel.approval.reject')}
            </Button>
            <span className="tm-aip-spacer" />
            {needsReview ? (
              <Button
                tone="ink"
                size="compact"
                className="tm-aip-touch"
                disabled={busy}
                aria-label={t('AiPanel.approval.reviewFor', { title })}
                onClick={() => onReview(view)}
              >
                {t('AiPanel.approval.review')}
              </Button>
            ) : outcome.kind === 'failed' ? (
              <Button
                tone="outline"
                size="compact"
                className="tm-aip-touch"
                onClick={() => void decide('approve')}
              >
                {t('AiPanel.tryAgain')}
              </Button>
            ) : (
              <Button
                tone="ink"
                size="compact"
                className="tm-aip-touch"
                disabled={busy}
                loading={outcome.kind === 'approving'}
                onClick={() => void decide('approve')}
              >
                {t('AiPanel.approval.approve')}
              </Button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

export interface AiApprovalReviewProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly view: AiApprovalView;
  readonly onBack: () => void;
  readonly onDecided: () => void;
}

/**
 * "Review" for a money or HR request, inside the Your AI tab (Figma T1 865:2302 / AR 865:2362):
 * "Back to waiting", then the G6 v2 card with "From ChatGPT · ends 14:27", the rows, the
 * can't-be-undone line for a destructive action, the amount typed back, "Confirm it's you" and
 * the expiry. No chat bubble and no message box: the member's own AI asked, not the member.
 */
export function AiApprovalReview({
  api,
  organizationSlug,
  view,
  onBack,
  onDecided,
}: AiApprovalReviewProps) {
  const t = useAiPanelT();
  const text = useAiText();
  const lookup = useCatalogLookup();
  const titleId = useId();
  const check = useFormCheck();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [fault, setFault] = useState<'amount' | 'step_up' | 'error' | null>(null);
  const [phase, setPhase] = useState<'open' | 'working' | 'done' | 'ended'>('open');
  const title = localizedOpTitle(lookup, view.summary.opId, view.summary.title);
  const needsAmount = view.amount !== null;

  async function confirm() {
    setFault(null);
    let amount: number | undefined;
    if (needsAmount) {
      const value = parseTypedAmount(typed);
      if (value === null || value !== view.amount) {
        setFault('amount');
        return;
      }
      amount = value;
    }
    setPhase('working');
    let reauthToken: string;
    try {
      reauthToken = await reauthenticate(api, { password });
    } catch {
      setFault('step_up');
      setPhase('open');
      return;
    }
    try {
      await decideAiApproval(api, organizationSlug, view.id, 'approve', {
        reauthToken,
        ...(amount === undefined ? {} : { amount }),
      });
      setPhase('done');
      onDecided();
    } catch (error) {
      if (endedByServer(error)) {
        setPhase('ended');
        onDecided();
        return;
      }
      setFault(
        error instanceof ApiRequestError && error.code === 'reauthentication_required'
          ? 'step_up'
          : error instanceof ApiRequestError && error.status === 400
            ? 'amount'
            : 'error',
      );
      setPhase('open');
    }
  }

  return (
    <div className="tm-aip-review">
      <button type="button" className="tm-aip-link" onClick={onBack}>
        {t('AiPanel.review.back')}
      </button>
      <article className="tm-aip-card tm-aip-card--review" aria-labelledby={titleId}>
        <div className="tm-aip-card__head">
          <span className="tm-aip-review__lock" aria-hidden="true">
            <LockIcon />
          </span>
          <h4 id={titleId} className="tm-aip-card__title">
            <bdi>{view.summary.subject ? `${title} ${view.summary.subject}` : title}</bdi>
          </h4>
          <StateCapsule className="tm-aip-capsule">
            {t(needsAmount ? 'AiPanel.review.money' : 'AiPanel.review.people')}
          </StateCapsule>
        </div>
        <FromLine view={view} />
        <ApprovalFields view={view} />
        {view.summary.destructive ? (
          <InlineAlert tone="warning">{text.t('AiChat.card.cannotUndo')}</InlineAlert>
        ) : null}

        {phase === 'done' || phase === 'ended' ? (
          <p className="tm-aip-card__result" role="status">
            <StateCapsule state={phase === 'done' ? 'done' : 'archived'} className="tm-aip-capsule">
              {t(phase === 'done' ? 'AiPanel.approval.approved' : 'AiPanel.approval.ended')}
            </StateCapsule>
          </p>
        ) : (
          <form
            noValidate
            className="tm-aip-review__form"
            {...check.handlers(() => void confirm())}
          >
            {needsAmount ? (
              <Field
                label={text.t('AiChat.card.typeAmount')}
                hint={t('AiPanel.review.amountHint')}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                dir="ltr"
                required
                value={typed}
                onChange={(event) => setTyped(event.currentTarget.value)}
                {...(fault === 'amount'
                  ? { error: text.t('AiChat.card.wrongAmount') }
                  : check.error('amount') === undefined
                    ? {}
                    : { error: check.error('amount') })}
              />
            ) : null}
            <div className="tm-aic-stepup">
              <p className="tm-aic-stepup__title">{text.t('AiChat.card.stepUpTitle')}</p>
              <p className="tm-aic-note">{text.t('AiChat.card.stepUpBody')}</p>
              <Field
                label={text.t('AiChat.card.password')}
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                {...(fault === 'step_up'
                  ? { error: text.t('AiChat.card.stepUpFailed') }
                  : check.error('password') === undefined
                    ? {}
                    : { error: check.error('password') })}
              />
            </div>
            <p className="tm-aip-note">
              {text.t('AiChat.card.expires', { time: text.time(view.expiresAt) })}
            </p>
            {fault === 'error' ? (
              <InlineAlert tone="danger" live>
                {t('AiPanel.approval.failed')}
              </InlineAlert>
            ) : null}
            <div className="tm-aip-card__actions">
              <Button
                type="submit"
                tone="ink"
                className="tm-aip-touch"
                loading={phase === 'working'}
              >
                {title}
              </Button>
              <span className="tm-aip-spacer" />
              <Button type="button" tone="text" className="tm-aip-touch" onClick={onBack}>
                {t('AiPanel.review.cancel')}
              </Button>
            </div>
          </form>
        )}
      </article>
    </div>
  );
}
