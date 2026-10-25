'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  completeOnboardingTourStep,
  getOnboardingTour,
  type OnboardingTourStep,
} from '../../lib/api/onboarding-tour';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';

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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
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
  const nextIndex = steps.findIndex((step) => !step.completed);
  const next = nextIndex === -1 ? undefined : steps[nextIndex];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title={t('OnboardingTourScreen.title')}
      titleVariant="display"
      description={t('OnboardingTourScreen.description')}
    >
      <style href="tm-onboarding-tour" precedence="default">
        {TOUR_CSS}
      </style>

      {tour.isError ? (
        <InlineAlert tone="danger" title={t('OnboardingTourScreen.loadError')} live>
          {describeError(tour.error)}
        </InlineAlert>
      ) : null}

      {complete.isError ? (
        <InlineAlert tone="danger" title={t('OnboardingTourScreen.markStepError')} live>
          {describeError(complete.error)}
        </InlineAlert>
      ) : null}

      {tour.isPending ? (
        <LoadingRegion label={t('OnboardingTourScreen.loading')} className="tm-tour">
          <Skeleton height="72px" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!tour.isPending && !tour.isError ? (
        <div className="tm-tour">
          {next ? (
            <div className="tm-tour__next">
              <span className="tm-tour__next-orb" aria-hidden="true">
                ▸
              </span>
              <div>
                <p className="tm-tour__next-title">{next.label}</p>
                <p className="tm-tour__next-why">{t(STEP_COPY_KEYS[next.step])}</p>
              </div>
            </div>
          ) : (
            <div className="tm-tour__next tm-tour__next--done">
              <span className="tm-tour__next-orb" aria-hidden="true">
                ✓
              </span>
              <div>
                <p className="tm-tour__next-title">{t('OnboardingTourScreen.tourComplete')}</p>
                <p className="tm-tour__next-why">{t('OnboardingTourScreen.tourCompleteWhy')}</p>
              </div>
            </div>
          )}

          <section className="tm-tour__card" aria-labelledby="tm-tour-heading">
            <div className="tm-tour__head">
              <h2 id="tm-tour-heading" className="tm-tour__eyebrow">
                {t('OnboardingTourScreen.tourProgress')}
              </h2>
              <div className="tm-tour__dashes" aria-hidden="true">
                {steps.map((step, index) => (
                  <span
                    key={step.step}
                    className="tm-tour__dash"
                    data-state={
                      step.completed ? 'done' : index === nextIndex ? 'current' : 'future'
                    }
                  />
                ))}
              </div>
            </div>
            <p className="tm-tour__count" aria-live="polite">
              {doneCount} {t('OnboardingTourScreen.of')} {steps.length}{' '}
              {t('OnboardingTourScreen.stepsDone')}
            </p>
            <ol className="tm-tour__steps">
              {steps.map((step, index) => (
                <li
                  key={step.step}
                  className="tm-tour__step"
                  data-state={step.completed ? 'done' : index === nextIndex ? 'current' : 'future'}
                >
                  <span className="tm-tour__glyph" aria-hidden="true">
                    {step.completed ? '✓' : index + 1}
                  </span>
                  <span className="tm-tour__label">
                    {step.label}
                    <span className="tm-visually-hidden">
                      {step.completed
                        ? t('OnboardingTourScreen.dashDone')
                        : t('OnboardingTourScreen.dashToDo')}
                    </span>
                  </span>
                  {step.completed ? (
                    <span className="tm-tour__done">{t('OnboardingTourScreen.done')}</span>
                  ) : (
                    <Button
                      type="button"
                      tone={index === nextIndex ? 'ink' : 'outline'}
                      size="compact"
                      loading={complete.isPending && complete.variables === step.step}
                      loadingLabel={t('OnboardingTourScreen.saving')}
                      onClick={() => complete.mutate(step.step)}
                    >
                      {t('OnboardingTourScreen.markDone')}
                      <span className="tm-visually-hidden">: {step.label}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}

/** The message key for what each fixed step is for — the "says why" line under the next action. */
const STEP_COPY_KEYS: Record<OnboardingTourStep, MessageKey> = {
  welcome: 'OnboardingTourScreen.stepWelcome',
  create_project: 'OnboardingTourScreen.stepCreateProject',
  invite_team: 'OnboardingTourScreen.stepInviteTeam',
  explore_work: 'OnboardingTourScreen.stepExploreWork',
  share_portal: 'OnboardingTourScreen.stepSharePortal',
};

const TOUR_CSS = `
.tm-tour { display: flex; flex-direction: column; gap: 22px; max-inline-size: 760px; }
.tm-tour__next {
  display: flex; align-items: center; gap: 18px; padding: 12px 22px 12px 12px; border-radius: var(--r-capsule);
  background: var(--tm-ink-absolute); color: var(--tm-paper-absolute); box-shadow: 0 0 0 3px var(--lime-500);
}
.tm-tour__next--done { box-shadow: none; }
.tm-tour__next-orb {
  flex-shrink: 0; display: grid; place-items: center; inline-size: 48px; block-size: 48px;
  border-radius: var(--r-capsule); background: var(--lime-500); color: var(--tm-ink-absolute);
  font: 500 18px/1 var(--font-mono);
}
.tm-tour__next-title { margin: 0; font-size: 17px; line-height: 23px; font-weight: 600; }
.tm-tour__next-why { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: #a7aca0; }
.tm-tour__card {
  display: flex; flex-direction: column; gap: 14px; max-inline-size: 460px; padding: 24px;
  border: var(--b-structural) solid var(--ink-950); border-radius: var(--r-sheet); background: var(--paper-0);
  box-shadow: 0 24px 56px rgb(9 10 9 / 0.12);
}
.tm-tour__head { display: flex; align-items: center; gap: 12px; }
.tm-tour__eyebrow {
  margin: 0; font-family: var(--font-mono); font-size: 10px; line-height: 14px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-500);
}
.tm-tour__dashes { display: flex; gap: 5px; margin-inline-start: auto; }
.tm-tour__dash { inline-size: 22px; block-size: 5px; border-radius: var(--r-capsule); background: var(--line-300); }
.tm-tour__dash[data-state='done'] { background: var(--ink-950); }
.tm-tour__dash[data-state='current'] { background: var(--lime-600); }
.tm-tour__count { margin: 0; font-size: 20px; line-height: 27px; font-weight: 600; color: var(--ink-950); }
.tm-tour__steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tm-tour__step {
  display: flex; align-items: center; gap: 12px; min-block-size: 52px; padding: 6px 8px 6px 12px;
  border-radius: var(--r-control); background: var(--paper-50);
}
.tm-tour__glyph {
  flex-shrink: 0; display: grid; place-items: center; inline-size: 24px; block-size: 24px;
  border: var(--b-structural) solid var(--line-300); border-radius: var(--r-capsule);
  font: 600 10px/1 var(--font-mono); color: var(--ink-650);
}
.tm-tour__step[data-state='done'] .tm-tour__glyph { border-color: var(--tm-ink-absolute); background: var(--tm-ink-absolute); color: var(--lime-500); }
.tm-tour__step[data-state='current'] .tm-tour__glyph { border-color: var(--lime-500); background: var(--lime-500); color: var(--tm-ink-absolute); }
.tm-tour__label { flex: 1; min-inline-size: 0; font-size: var(--t-ui-md); line-height: 21px; color: var(--ink-800); }
.tm-tour__step[data-state='done'] .tm-tour__label { color: var(--ink-650); }
.tm-tour__done { padding-inline: 12px; font-family: var(--font-mono); font-size: 11px; line-height: 15px; text-transform: uppercase; color: var(--ink-500); }
@media (max-width: 40rem) {
  .tm-tour__next { border-radius: var(--r-card); }
  .tm-tour__card { padding: 18px; }
}
`;
