'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  decideApprovalStep,
  listApprovalSteps,
  type ApprovalStep,
} from '../../lib/api/approval-steps';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface ApprovalStepsViewProps {
  organizationSlug: string;
  approvalId: string;
  api: ApiClient;
}

/**
 * **x315 — the sequential approval chain on an approval.** (Requests, decisions & approvals, module
 * §Requests; multi-step approval.)
 *
 * The ordered step list with the active step highlighted, and approve/reject on the active step
 * alone. The active step is the lowest position still pending; the server returns its id
 * (`activeStepId`) so the highlight and the buttons never drift from the chain rules. Deciding a step
 * invalidates the chain query so the list — and which step is active — reflects the server. **No
 * dispatch here**; this is the in-app chain view. Authored ready for the approval detail screen to
 * mount beside the single-decision panel.
 */
export function ApprovalStepsView({ organizationSlug, approvalId, api }: ApprovalStepsViewProps) {
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const t = useT();
  const queryKey = ['approval-steps', organizationSlug, approvalId] as const;

  const stateLabel = (state: ApprovalStep['state']): string => {
    if (state === 'approved') return t('ApprovalStepsView.stateApproved');
    if (state === 'rejected') return t('ApprovalStepsView.stateRejected');
    return t('ApprovalStepsView.statePending');
  };

  const chain = useQuery({
    queryKey,
    queryFn: () => listApprovalSteps(api, organizationSlug, approvalId),
  });

  const decide = useMutation({
    mutationFn: (input: { stepId: string; decision: 'approve' | 'reject' }) =>
      decideApprovalStep(api, organizationSlug, approvalId, input.stepId, input.decision),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey });
    },
  });

  const steps = chain.data?.steps ?? [];
  const activeStepId = chain.data?.activeStepId ?? null;
  const pending = decide.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-approval-steps">
      <h2 id="tm-approval-steps" className="tm-eyebrow">
        {t('ApprovalStepsView.heading')}
      </h2>

      {decide.isError ? (
        <InlineAlert tone="danger" title={t('ApprovalStepsView.decisionError')} live>
          {describe(decide.error)}
        </InlineAlert>
      ) : null}

      {chain.isPending ? (
        <LoadingRegion label={t('ApprovalStepsView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {chain.isError ? (
        <InlineAlert tone="danger" title={t('ApprovalStepsView.loadError')} live>
          {describe(chain.error)}
        </InlineAlert>
      ) : null}

      {chain.data ? (
        steps.length === 0 ? (
          <p className="tm-prose">{t('ApprovalStepsView.empty')}</p>
        ) : (
          <ol className="tm-list" aria-label={t('ApprovalStepsView.listLabel')}>
            {steps.map((step) => {
              const isActive = step.id === activeStepId;
              return (
                <li
                  key={step.id}
                  className="tm-stack"
                  aria-current={isActive ? 'step' : undefined}
                  data-active={isActive ? 'true' : undefined}
                >
                  <p className="tm-prose">
                    <span className="tm-eyebrow">
                      {t('ApprovalStepsView.stepPrefix')} {step.position + 1}
                    </span>{' '}
                    — {step.approverRole}
                  </p>
                  <span className="tm-eyebrow">{stateLabel(step.state)}</span>
                  {isActive ? (
                    <div className="tm-row">
                      <Button
                        type="button"
                        tone="ink"
                        size="accessible"
                        disabled={pending}
                        loading={pending}
                        loadingLabel={t('ApprovalStepsView.recording')}
                        onClick={() => decide.mutate({ stepId: step.id, decision: 'approve' })}
                      >
                        {t('ApprovalStepsView.approve')}
                      </Button>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        disabled={pending}
                        onClick={() => decide.mutate({ stepId: step.id, decision: 'reject' })}
                      >
                        {t('ApprovalStepsView.reject')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )
      ) : null}
    </section>
  );
}
