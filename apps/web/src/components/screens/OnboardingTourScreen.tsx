'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  completeOnboardingTourStep,
  getOnboardingTour,
  type OnboardingTourStep,
} from '../../lib/api/onboarding-tour';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface OnboardingTourScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **ON-10 guided tour progress (x155).**
 *
 * `38-MODULE-MAP` §Onboarding (ON-10 "sample / guided tour"). A checklist of the fixed guided-tour
 * steps, each showing whether the signed-in member has finished it, with a control to mark one done.
 * Progress is the acting member's own — the API takes no membership id and returns only their
 * completions — so this screen never shows or changes anyone else's tour.
 *
 * ## What it does, and what it cannot
 *
 * - **Progress only.** ON-10's sample-data seeding and dismissable coach-marks are deferred (NS-13);
 *   this tracks which steps a member has completed, nothing about a step's content.
 * - **Complete, never un-complete.** A step is marked done and stays done — the API has no
 *   un-complete path — so there is no undo control here. Re-marking a done step is a harmless no-op.
 */
export function OnboardingTourScreen({
  organizationSlug,
  organizationName,
  client,
}: OnboardingTourScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['onboarding-tour', organizationSlug];

  const tour = useQuery({
    queryKey,
    queryFn: () => getOnboardingTour(api, organizationSlug),
  });

  const complete = useMutation({
    mutationFn: (step: OnboardingTourStep) =>
      completeOnboardingTourStep(api, organizationSlug, step),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });

  const steps = tour.data?.steps ?? [];
  const doneCount = steps.filter((step) => step.completed).length;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title="Guided tour"
      description="A short tour of TManage. Mark each step done as you go — your progress is your own."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-tour-heading">
        <h2 id="tm-tour-heading" className="tm-eyebrow">
          Your progress
        </h2>

        {tour.isError ? (
          <InlineAlert tone="danger" title="Could not load the tour" live>
            {describeError(tour.error)}
          </InlineAlert>
        ) : null}

        {complete.isError ? (
          <InlineAlert tone="danger" title="Could not mark that step done" live>
            {describeError(complete.error)}
          </InlineAlert>
        ) : null}

        {tour.isPending ? (
          <LoadingRegion label="Loading the tour.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!tour.isPending && !tour.isError ? (
          <>
            <p className="tm-prose" aria-live="polite">
              {doneCount} of {steps.length} steps done.
            </p>
            <ol className="tm-list tm-stack tm-stack--tight">
              {steps.map((step) => (
                <li key={step.step} className="tm-row">
                  <StateCapsule state={step.completed ? 'done' : 'future'}>
                    {step.completed ? 'Done' : 'To do'}
                  </StateCapsule>
                  <span className="tm-prose">{step.label}</span>
                  {step.completed ? (
                    <span className="tm-field__hint">Completed</span>
                  ) : (
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      loading={complete.isPending && complete.variables === step.step}
                      loadingLabel="Saving"
                      onClick={() => complete.mutate(step.step)}
                    >
                      Mark done
                      <span className="tm-visually-hidden">: {step.label}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
