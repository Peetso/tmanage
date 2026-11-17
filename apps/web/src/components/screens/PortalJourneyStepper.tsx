'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { getPortalJourney } from '../../lib/api/portal';
import type {
  PortalJourney,
  PortalJourneyStep,
  PortalJourneyStepKind,
  PortalJourneyStepTurn,
} from '../../lib/api/portal';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { shortDay } from './PortalParts';

export interface PortalJourneyStepperProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  providerName: string;
}

const BUTTON = 'tm-button tm-button--default';

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The words and the screen of each client step kind's "Your turn" card. */
const STEP_TURN: Readonly<
  Record<
    PortalJourneyStepKind,
    {
      readonly body: MessageKey;
      readonly action: MessageKey;
      href(turn: PortalJourneyStepTurn): string;
    }
  >
> = {
  form: {
    body: 'PortalJourney.formBody',
    action: 'PortalJourney.openForm',
    href: (turn) => `journey/${encodeURIComponent(turn.stepId)}`,
  },
  upload: {
    body: 'PortalJourney.uploadBody',
    action: 'PortalJourney.sendFiles',
    href: () => 'files',
  },
  sign: {
    body: 'PortalJourney.signBody',
    action: 'PortalJourney.signNow',
    href: (turn) => `sign/${encodeURIComponent(turn.targetId ?? '')}`,
  },
  meeting: {
    body: 'PortalJourney.meetingBody',
    action: 'PortalJourney.openMeeting',
    href: (turn) => `meetings/${encodeURIComponent(turn.targetId ?? '')}`,
  },
};

const KIND_LABEL: Readonly<Record<PortalJourneyStepKind, MessageKey>> = {
  form: 'PortalJourney.kindForm',
  upload: 'PortalJourney.kindUpload',
  sign: 'PortalJourney.kindSign',
  meeting: 'PortalJourney.kindMeeting',
};

/**
 * **52-27 Client journey** — the portal home stepper (Figma 604:33897).
 *
 * The steps, their states and the client's one open action all come from the API
 * (`GET …/portal/projects/:id/journey`); this component only lays them out. The "Your turn"
 * button opens the real screen for that action: the review-and-approve screen for a version, or
 * the existing form, Files, e-sign or meeting screen for a client journey step.
 */
export function PortalJourneyStepper({
  api,
  organizationSlug,
  projectId,
  providerName,
}: PortalJourneyStepperProps) {
  const t = useT();
  const journey = useQuery({
    queryKey: ['portal-journey', organizationSlug, projectId],
    queryFn: () => getPortalJourney(api, organizationSlug, projectId),
  });
  const portal = `/${organizationSlug}/portal`;

  if (journey.isPending) {
    return (
      <section className="tm-pt-journey-card">
        <h2 className="tm-pt-journey-card__title">{t('PortalJourney.title')}</h2>
        <LoadingRegion
          className="tm-pt-journey-card__loading"
          label={t('PortalJourney.loadingLabel')}
        >
          <span className="tm-pt-journey-dots" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((dot) => (
              <Skeleton key={dot} width="20px" height="20px" radius="var(--r-capsule)" />
            ))}
          </span>
          <Skeleton width="300px" height="12px" radius="6px" />
          <Skeleton width="220px" height="12px" radius="6px" />
          <Skeleton width="260px" height="12px" radius="6px" />
        </LoadingRegion>
      </section>
    );
  }

  if (journey.isError) {
    return (
      <section className="tm-pt-journey-card">
        <h2 className="tm-pt-journey-card__title">{t('PortalJourney.title')}</h2>
        <InlineAlert tone="warning" title={t('PortalJourney.errorTitle')} live>
          {t('PortalJourney.errorBody')}
        </InlineAlert>
        <button
          type="button"
          className={`${BUTTON} tm-button--outline`}
          onClick={() => void journey.refetch()}
        >
          {t('PortalJourney.tryAgain')}
        </button>
      </section>
    );
  }

  const { steps, yourTurn, completed } = journey.data;
  const nowStep = steps.find((step) => step.state === 'now');

  if (steps.length === 0 && yourTurn === null) {
    return (
      <section className="tm-pt-journey-card">
        <h2 className="tm-pt-journey-card__title">{t('PortalJourney.title')}</h2>
        <p className="tm-pt-journey-card__body">
          {fill(t('PortalJourney.empty'), { provider: providerName })}
        </p>
        <Link className={`${BUTTON} tm-button--outline`} href={`${portal}/chat`}>
          {t('PortalJourney.sendMessage')}
        </Link>
      </section>
    );
  }

  if (completed) {
    const lastDay = steps[steps.length - 1]?.dueOn ?? null;
    return (
      <section className="tm-pt-journey-card">
        <h2 className="tm-pt-journey-card__title">{t('PortalJourney.title')}</h2>
        <StateCapsule state="done">{t('PortalJourney.allDone')}</StateCapsule>
        <p className="tm-pt-journey-card__body">
          {lastDay
            ? fill(t('PortalJourney.allDoneBodyOn'), {
                provider: providerName,
                date: shortDay(lastDay),
              })
            : fill(t('PortalJourney.allDoneBody'), { provider: providerName })}
        </p>
        <Link className={`${BUTTON} tm-button--ink`} href={`${portal}/files`}>
          {t('PortalJourney.openFinalFiles')}
        </Link>
      </section>
    );
  }

  return (
    <div className="tm-pt-journey">
      {steps.length > 0 ? <StepTrack journey={journey.data} /> : null}

      <div className="tm-pt-journey__next">
        <section className="tm-pt-journey__turn">
          {yourTurn && yourTurn.kind !== 'review' ? (
            <>
              <StateCapsule state="client">{t('PortalJourney.yourTurn')}</StateCapsule>
              <h2 className="tm-pt-journey__turn-title">{yourTurn.title}</h2>
              <p className="tm-pt-journey__turn-body">
                {fill(t(STEP_TURN[yourTurn.kind].body), { provider: providerName })}
              </p>
              <div className="tm-pt-journey__actions">
                <Link
                  className={`${BUTTON} tm-button--ink`}
                  href={`${portal}/${STEP_TURN[yourTurn.kind].href(yourTurn)}`}
                >
                  {t(STEP_TURN[yourTurn.kind].action)}
                </Link>
                <Link className={`${BUTTON} tm-button--outline`} href={`${portal}/chat`}>
                  {t('PortalJourney.askQuestion')}
                </Link>
              </div>
            </>
          ) : yourTurn ? (
            <>
              <StateCapsule state="client">{t('PortalJourney.yourTurn')}</StateCapsule>
              <h2 className="tm-pt-journey__turn-title">
                {fill(t('PortalJourney.turnTitle'), { title: yourTurn.title })}
              </h2>
              <p className="tm-pt-journey__turn-body">
                {fill(t('PortalJourney.turnBody'), {
                  provider: providerName,
                  date: shortDay(yourTurn.sentAt),
                })}
              </p>
              <div className="tm-pt-journey__actions">
                <Link
                  className={`${BUTTON} tm-button--ink`}
                  href={`${portal}/deliverables/${encodeURIComponent(yourTurn.deliverableVersionId)}`}
                >
                  {t('PortalJourney.reviewAndApprove')}
                </Link>
                <Link className={`${BUTTON} tm-button--outline`} href={`${portal}/chat`}>
                  {t('PortalJourney.askQuestion')}
                </Link>
              </div>
            </>
          ) : (
            <>
              <StateCapsule state="current">
                {fill(t('PortalJourney.withProvider'), { provider: providerName })}
              </StateCapsule>
              <h2 className="tm-pt-journey__turn-title">
                {fill(
                  t(
                    nowStep && nowStep.kind !== 'milestone'
                      ? 'PortalJourney.preparingTitle'
                      : 'PortalJourney.workingTitle',
                  ),
                  { provider: providerName, step: nowStep?.title ?? '' },
                )}
              </h2>
              <p className="tm-pt-journey__turn-body">{t('PortalJourney.workingBody')}</p>
              <div className="tm-pt-journey__actions">
                <Link className={`${BUTTON} tm-button--outline`} href={`${portal}/chat`}>
                  {t('PortalJourney.askQuestion')}
                </Link>
              </div>
            </>
          )}
        </section>

        <section className="tm-pt-journey__later">
          <h2 className="tm-pt-journey__later-title">{t('PortalJourney.whatNext')}</h2>
          <ul className="tm-pt-journey__later-list">
            <li>{fill(t('PortalJourney.next1'), { provider: providerName })}</li>
            <li>{t('PortalJourney.next2')}</li>
            <li>{t('PortalJourney.next3')}</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function StepTrack({ journey }: { journey: PortalJourney }) {
  const t = useT();
  return (
    <ol className="tm-pt-journey__steps" aria-label={t('PortalJourney.stepsLabel')}>
      {journey.steps.map((step, index) => (
        <li
          key={step.id}
          className={`tm-pt-jstep tm-pt-jstep--${step.state}`}
          aria-current={step.state === 'now' ? 'step' : undefined}
        >
          <span className="tm-pt-jstep__track">
            <span className="tm-pt-jstep__dot" aria-hidden="true">
              {step.state === 'done' ? '✓' : index + 1}
            </span>
            <span className="tm-pt-jstep__line" aria-hidden="true" />
          </span>
          <span className="tm-pt-jstep__text">
            <span className="tm-pt-jstep__name">{step.title}</span>
            <span className="tm-pt-jstep__date">
              {stepNote(step, journey.yourTurn !== null, t)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function stepNote(
  step: PortalJourneyStep,
  clientTurn: boolean,
  t: ReturnType<typeof useT>,
): string {
  if (step.state === 'now') {
    return t(clientTurn ? 'PortalJourney.nowYourTurn' : 'PortalJourney.now');
  }
  if (step.missed) return t('PortalJourney.missed');
  if (step.kind !== 'milestone') {
    return t(step.state === 'done' ? 'PortalJourney.done' : KIND_LABEL[step.kind]);
  }
  if (step.dueOn === null) {
    return t(step.state === 'done' ? 'PortalJourney.done' : 'PortalJourney.notDated');
  }
  return step.state === 'done'
    ? shortDay(step.dueOn)
    : fill(t('PortalJourney.plannedOn'), { date: shortDay(step.dueOn) });
}
