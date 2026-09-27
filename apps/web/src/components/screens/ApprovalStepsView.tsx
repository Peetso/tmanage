'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  decideApprovalStep,
  listApprovalSteps,
  type ApprovalStep,
} from '../../lib/api/approval-steps';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ApprovalStepsViewProps {
  organizationSlug: string;
  approvalId: string;
  api: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

function stateLabel(state: ApprovalStep['state']): string {
  if (state === 'approved') return 'Approved';
  if (state === 'rejected') return 'Rejected';
  return 'Pending';
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
  const queries = useQueryClient();
  const queryKey = ['approval-steps', organizationSlug, approvalId] as const;

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
        Approval steps
      </h2>

      {decide.isError ? (
        <InlineAlert tone="danger" title="That decision did not go through" live>
          {describe(decide.error)}
        </InlineAlert>
      ) : null}

      {chain.isPending ? (
        <LoadingRegion label="Loading the approval chain.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {chain.isError ? (
        <InlineAlert tone="danger" title="Could not load the approval chain" live>
          {describe(chain.error)}
        </InlineAlert>
      ) : null}

      {chain.data ? (
        steps.length === 0 ? (
          <p className="tm-prose">No approval steps have been defined yet.</p>
        ) : (
          <ol className="tm-list" aria-label="Approval steps in order">
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
                    <span className="tm-eyebrow">Step {step.position + 1}</span> —{' '}
                    {step.approverRole}
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
                        loadingLabel="Recording"
                        onClick={() => decide.mutate({ stepId: step.id, decision: 'approve' })}
                      >
                        Approve
                      </Button>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        disabled={pending}
                        onClick={() => decide.mutate({ stepId: step.id, decision: 'reject' })}
                      >
                        Reject
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
