'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getCoachMarks, saveCoachMarks, shouldShowTour } from '../../lib/api/coach-marks';
import type { CoachMarkTour as TourId, CoachMarksPatch } from '../../lib/api/coach-marks';
import { useTOr } from '../../lib/i18n/use-t-or';
import { COACH_MARK_STEPS } from './coach-mark-tours';
import './coach-marks.css';

/**
 * Row 55-09 — a short first-visit tour (Figma R49 L2, node 592:33601): one non-modal card,
 * "n of 3", Back / Next, "Skip tour" and "Don't show tours again". It opens only when the member
 * has never finished or skipped this tour and has not turned tours off; the outcome is kept in
 * their own preferences, so it never shows twice on any device. The step's target, when present on
 * the page, is scrolled into view and outlined. The card never steals focus from the screen.
 */
export function CoachMarkTour({
  organizationSlug,
  tour,
  client,
}: {
  readonly organizationSlug: string;
  readonly tour: TourId;
  readonly client?: ApiClient;
}) {
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const key = ['coach-marks', organizationSlug] as const;
  const state = useQuery({ queryKey: key, queryFn: () => getCoachMarks(api, organizationSlug) });
  const save = useMutation({
    mutationFn: (patch: CoachMarksPatch) => saveCoachMarks(api, organizationSlug, patch),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  const [step, setStep] = useState(0);
  const [neverAgain, setNeverAgain] = useState(false);
  const [closed, setClosed] = useState(false);
  const titleId = useId();
  const steps = COACH_MARK_STEPS[tour];
  const open = !closed && shouldShowTour(state.data, tour);
  const current = steps[step];

  useEffect(() => {
    if (!open || current?.target === undefined) return undefined;
    const target = document.querySelector<HTMLElement>(current.target);
    if (target === null) return undefined;
    target.setAttribute('data-coach-active', '');
    target.scrollIntoView?.({ block: 'nearest' });
    return () => target.removeAttribute('data-coach-active');
  }, [open, current]);

  if (!open || current === undefined) return null;

  const finish = (outcome: 'done' | 'skipped') => {
    setClosed(true);
    save.mutate(neverAgain ? { tour, outcome, neverAgain: true } : { tour, outcome });
  };
  const last = step === steps.length - 1;

  return (
    <section className="tm-coach" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <p className="tm-coach__step">
        {tOr('CoachMarks.stepOf', '{n} of {total}')
          .replace('{n}', String(step + 1))
          .replace('{total}', String(steps.length))}
      </p>
      <h2 id={titleId} className="tm-coach__title">
        {tOr(`${current.key}.title`, current.title)}
      </h2>
      <p className="tm-coach__body">{tOr(`${current.key}.body`, current.body)}</p>
      <label className="tm-coach__never">
        <input
          type="checkbox"
          checked={neverAgain}
          onChange={(event) => setNeverAgain(event.target.checked)}
        />
        {tOr('CoachMarks.neverAgain', 'Don’t show tours again')}
      </label>
      <div className="tm-coach__actions">
        <button type="button" className="tm-coach__skip" onClick={() => finish('skipped')}>
          {tOr('CoachMarks.skip', 'Skip tour')}
        </button>
        <span className="tm-coach__spacer" />
        {step > 0 ? (
          <Button tone="outline" onClick={() => setStep(step - 1)}>
            {tOr('CoachMarks.back', 'Back')}
          </Button>
        ) : null}
        <Button tone="lime" onClick={() => (last ? finish('done') : setStep(step + 1))}>
          {last ? tOr('CoachMarks.done', 'Done') : tOr('CoachMarks.next', 'Next')}
        </Button>
      </div>
    </section>
  );
}
