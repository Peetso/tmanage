'use client';

import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { resendApprovalEmail } from '../../../lib/api/deliverables';
import type {
  ApprovalEmailState,
  ApprovalReviewerView,
  DeliverableVersionView,
} from '../../../lib/api/deliverables';
import type { ApiClient } from '../../../lib/api/client';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { describeDeliverableError, useDeliverablesT } from '../DeliverablesScreen';
import type { DeliverablesKey } from '../DeliverablesScreen';

/**
 * **Who was asked, and did the e-mail reach them (QA-FIX-O H1).**
 *
 * Under a version that is out for approval: each approver's name and the address the request was
 * mailed to, and what happened to that e-mail, from the API's `approval_email_sends` rows. "Resend
 * email" is offered only when the API says so (`canResendEmail`, AR-9). NN/g heuristic 1
 * (visibility of system status) and heuristic 9 (help users recognize and recover from errors):
 * the page used to say "Waiting for the client" while no e-mail had gone at all.
 */

const STATE_CAPSULE: Readonly<Record<ApprovalEmailState, CapsuleState>> = {
  not_requested: 'neutral',
  queued: 'waiting',
  sent: 'done',
  failed: 'blocked',
  not_sent: 'blocked',
};

function lineFor(reviewer: ApprovalReviewerView): DeliverablesKey {
  switch (reviewer.emailState) {
    case 'not_requested':
      return 'Deliverables.emailNotRequested';
    case 'queued':
      return 'Deliverables.emailQueued';
    case 'sent':
      return 'Deliverables.emailSent';
    case 'failed':
      return 'Deliverables.emailFailed';
    case 'not_sent':
      if (reviewer.emailCause === 'mail_off') return 'Deliverables.emailOff';
      if (reviewer.emailCause === 'no_access') return 'Deliverables.emailNoAccess';
      return 'Deliverables.emailNoTransport';
  }
}

export interface ApprovalReviewerListProps {
  api: ApiClient;
  organizationSlug: string;
  deliverableId: string;
  approval: NonNullable<DeliverableVersionView['approval']>;
  onResent: () => void;
}

export function ApprovalReviewerList({
  api,
  organizationSlug,
  deliverableId,
  approval,
  onResent,
}: ApprovalReviewerListProps) {
  const t = useDeliverablesT();
  const fmt = useDisplayFormatters();
  const resend = useMutation({
    mutationFn: () => resendApprovalEmail(api, organizationSlug, deliverableId, approval.id),
    onSuccess: onResent,
  });
  if (approval.reviewers.length === 0) return null;

  return (
    <div className="tm-stack tm-stack--tight">
      <span className="tm-field__label">{t('Deliverables.askedHeading')}</span>
      <ul className="tm-list tm-stack tm-stack--tight">
        {approval.reviewers.map((reviewer) => {
          const when = reviewer.emailSettledAt ?? reviewer.emailRequestedAt;
          return (
            <li key={reviewer.userId} className="tm-row tm-row--wrap">
              <span className="tm-heading-3">
                {reviewer.displayName ?? t('Deliverables.reviewerGone')}
              </span>
              {reviewer.email ? (
                <span className="tm-meta-mono" dir="ltr">
                  {reviewer.email}
                </span>
              ) : null}
              <StateCapsule state={STATE_CAPSULE[reviewer.emailState]}>
                {t(lineFor(reviewer))}
              </StateCapsule>
              {when && reviewer.emailState !== 'not_requested' ? (
                <span className="tm-field__hint">{fmt.dateTime(when)}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {approval.reviewers.some((r) => r.emailState === 'failed') ? (
        <p className="tm-field__hint">{t('Deliverables.emailFailedHint')}</p>
      ) : null}
      {resend.isError ? (
        <InlineAlert tone="danger" title={t('Deliverables.resendFailed')} live>
          {describeDeliverableError(resend.error, t)}
        </InlineAlert>
      ) : null}
      {resend.isSuccess ? (
        <p className="tm-field__hint" role="status">
          {t('Deliverables.resendDone')}
        </p>
      ) : null}
      {approval.canResendEmail ? (
        <div>
          <Button
            tone="outline"
            size="compact"
            loading={resend.isPending}
            loadingLabel={t('Deliverables.resending')}
            onClick={() => resend.mutate()}
          >
            {t('Deliverables.resendEmail')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
