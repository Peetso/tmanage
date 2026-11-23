'use client';

import { useId } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { dismissGettingStarted, getGettingStarted, STEP_HREF } from '../../lib/api/getting-started';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { gettingStartedQueryKey, STEP_LABEL } from '../onboarding/GettingStartedCard';
import { RowMenu } from './RowMenu';

/**
 * **Getting started** (spec MYDAY-V4 §5): the checklist of v3.1 drawn as two rows of the old side
 * column. Row 1: "3 of 6" and the next step as an outline button. Row 2: "Take the tour", which
 * starts the My Day coach marks on demand. The "⋯" orb hides it (the checklist is dismissed and
 * the widget stays listed in Edit widgets). Done or dismissed, it leaves the page.
 */
export function GettingStartedRows({
  api,
  slug,
  onHide,
  onTour,
}: {
  readonly api: ApiClient;
  readonly slug: string;
  readonly onHide: () => void;
  readonly onTour: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const headingId = useId();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: gettingStartedQueryKey(slug),
    queryFn: () => getGettingStarted(api, slug),
    retry: false,
  });
  const dismiss = useMutation({
    mutationFn: () => dismissGettingStarted(api, slug),
    onSuccess: (next) => queryClient.setQueryData(gettingStartedQueryKey(slug), next),
  });
  const data = view.data;
  // A failed or pending read draws nothing: a checklist must never put an error on My Day.
  if (!data || data.dismissed || data.completedCount >= data.totalCount) return null;
  const next = data.nextStep ?? null;
  const title = t('MyDay.w.gettingStarted');

  return (
    <section
      className="tm-home-saved tm-home-start"
      aria-labelledby={headingId}
      data-widget="gettingStarted"
    >
      <div className="tm-home-saved__head">
        <h2 id={headingId} className="tm-home-saved__heading">
          {title}
        </h2>
        <RowMenu
          label={fill(t('MyDay.rowMore'), { title })}
          items={[
            {
              id: 'hide',
              label: t('MyDay.hide'),
              onSelect: () => {
                onHide();
                dismiss.mutate();
              },
            },
          ]}
        />
      </div>
      <ul className="tm-home-saved__list">
        <li className="tm-home-saved__item">
          <span className="tm-home-orb" aria-hidden="true">
            {data.completedCount}
          </span>
          <span className="tm-home-saved__text">
            <span
              className="tm-home-saved__title"
              role="progressbar"
              aria-label={title}
              aria-valuemin={0}
              aria-valuemax={data.totalCount}
              aria-valuenow={data.completedCount}
            >
              {fill(t('MyDay.stepsDone'), { done: data.completedCount, total: data.totalCount })}
            </span>
          </span>
          {next ? (
            <Link
              href={`/${slug}${STEP_HREF[next]}`}
              className="tm-button tm-button--outline tm-button--compact"
            >
              {tOr(...STEP_LABEL[next])}
            </Link>
          ) : null}
        </li>
        <li className="tm-home-saved__item">
          <span className="tm-home-orb" aria-hidden="true">
            ?
          </span>
          <span className="tm-home-saved__text">
            <span className="tm-home-saved__title">{t('MyDay.takeTour')}</span>
          </span>
          <button
            type="button"
            className="tm-button tm-button--outline tm-button--compact"
            onClick={onTour}
          >
            {t('MyDay.start')}
            <span className="tm-visually-hidden">: {t('MyDay.takeTour')}</span>
          </button>
        </li>
      </ul>
    </section>
  );
}
