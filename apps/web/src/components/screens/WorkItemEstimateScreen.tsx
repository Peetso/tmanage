'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getWorkItemEstimate,
  setWorkItemEstimate,
  type WorkItemEstimate,
} from '../../lib/api/work-items';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface WorkItemEstimateScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/** The ceiling the API bounds the same range to; it answers 400 beyond it. */
const MAX_MINUTES = 100_000;

/**
 * **Work item effort estimate (module Work, x258).**
 *
 * `38-MODULE-MAP` §Work — plan and execute the same object. A single planned estimate for one work
 * item, in minutes, read back beside the logged actual (x231's time logs) so a planner sees estimate
 * vs actual and the variance between them. Set it and revise it — there is one estimate per item, so
 * the write is an idempotent `PUT`, never an append.
 */
export function WorkItemEstimateScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemEstimateScreenProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tr = useTOr();

  const estimate = useQuery({
    queryKey: ['work-item-estimate', organizationSlug, workItemId],
    queryFn: () => getWorkItemEstimate(api, organizationSlug, workItemId),
  });

  const [minutes, setMinutes] = useState('');

  // Seed the field from the stored estimate once it loads, so revising starts from the current value.
  useEffect(() => {
    if (estimate.data?.estimateMinutes != null) {
      setMinutes(String(estimate.data.estimateMinutes));
    }
  }, [estimate.data?.estimateMinutes]);

  const parsedMinutes = Number(minutes);
  const minutesValid =
    minutes.trim() !== '' &&
    Number.isInteger(parsedMinutes) &&
    parsedMinutes > 0 &&
    parsedMinutes <= MAX_MINUTES;

  const save = useMutation({
    mutationFn: () =>
      setWorkItemEstimate(api, organizationSlug, workItemId, { minutes: parsedMinutes }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['work-item-estimate', organizationSlug, workItemId],
      });
    },
  });

  const data: WorkItemEstimate | undefined = estimate.data;
  const canSave = minutesValid && !save.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('WorkItemEstimateScreen.eyebrow')}
      title={t('WorkItemEstimateScreen.title')}
      description={t('WorkItemEstimateScreen.description')}
    >
      <div className="tm-wk-page tm-stack">
        <nav
          className="tm-segmented tm-wk-subnav"
          aria-label={t('WorkItemEstimateScreen.subnavLabel')}
        >
          <Link href={`/${organizationSlug}/work/${workItemId}`}>
            {t('WorkItemEstimateScreen.overview')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/activity`}>
            {t('WorkItemEstimateScreen.activity')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/links`}>
            {tr('WorkItemLinks.tab', 'Links')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/time-logs`}>
            {t('WorkItemEstimateScreen.time')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/estimate`} aria-current="page">
            {t('WorkItemEstimateScreen.estimate')}
          </Link>
        </nav>
        <section className="tm-panel tm-stack" aria-labelledby="tm-estimate-heading">
          <h2 id="tm-estimate-heading" className="tm-eyebrow">
            {t('WorkItemEstimateScreen.estimate')}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canSave) save.mutate();
            }}
          >
            <Field
              label={t('WorkItemEstimateScreen.estimatedMinutes')}
              name="minutes"
              type="number"
              min={1}
              max={MAX_MINUTES}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              hint={`${t('WorkItemEstimateScreen.minutesHintPrefix')} ${MAX_MINUTES}.`}
              required
            />
            {save.isError ? (
              <InlineAlert tone="danger" title={t('WorkItemEstimateScreen.saveError')} live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}
            <div className="tm-row">
              <Button type="submit" tone="ink" disabled={!canSave} loading={save.isPending}>
                {t('WorkItemEstimateScreen.saveEstimate')}
              </Button>
            </div>
          </form>
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-estimate-compare-heading">
          <h2 id="tm-estimate-compare-heading" className="tm-eyebrow">
            {t('WorkItemEstimateScreen.estimateVsActual')}
          </h2>

          {estimate.isError ? (
            <InlineAlert tone="danger" title={t('WorkItemEstimateScreen.loadError')} live>
              {describeError(estimate.error)}
            </InlineAlert>
          ) : null}

          {estimate.isPending ? (
            <LoadingRegion label={t('WorkItemEstimateScreen.loading')}>
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!estimate.isPending && !estimate.isError && data ? (
            <ComparisonBar
              estimateMinutes={data.estimateMinutes}
              actualMinutes={data.actualMinutes}
              varianceMinutes={data.varianceMinutes}
            />
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function ComparisonBar({
  estimateMinutes,
  actualMinutes,
  varianceMinutes,
}: {
  estimateMinutes: number | null;
  actualMinutes: number;
  varianceMinutes: number | null;
}) {
  const t = useT();
  if (estimateMinutes === null) {
    return (
      <InlineAlert tone="neutral" title={t('WorkItemEstimateScreen.noEstimateTitle')}>
        {`${t('WorkItemEstimateScreen.noEstimateSet')} ${formatMinutes(actualMinutes)} ${t('WorkItemEstimateScreen.loggedSoFar')}`}
      </InlineAlert>
    );
  }

  const scale = Math.max(estimateMinutes, actualMinutes, 1);
  const estimatePct = Math.round((estimateMinutes / scale) * 100);
  const actualPct = Math.round((actualMinutes / scale) * 100);
  const over = varianceMinutes !== null && varianceMinutes < 0;

  return (
    <div className="tm-stack">
      <div className="tm-row tm-row--between">
        <span className="tm-badge" aria-label={t('WorkItemEstimateScreen.estimatedEffort')}>
          {t('WorkItemEstimateScreen.estimateLabel')} {formatMinutes(estimateMinutes)}
        </span>
        <span className="tm-badge" aria-label={t('WorkItemEstimateScreen.loggedActualEffort')}>
          {t('WorkItemEstimateScreen.actualLabel')} {formatMinutes(actualMinutes)}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${t('WorkItemEstimateScreen.estimateLabel')} ${formatMinutes(estimateMinutes)}, ${t('WorkItemEstimateScreen.actualLower')} ${formatMinutes(actualMinutes)}`}
        className="tm-usage-meter"
      >
        <div className="tm-usage-meter__track" aria-hidden="true">
          <span className="tm-usage-meter__fill" style={{ inlineSize: `${estimatePct}%` }} />
        </div>
        <div className="tm-usage-meter__track" aria-hidden="true">
          <span className="tm-usage-meter__fill" style={{ inlineSize: `${actualPct}%` }} />
        </div>
      </div>
      <InlineAlert
        tone={over ? 'danger' : 'neutral'}
        title={
          over
            ? t('WorkItemEstimateScreen.overEstimate')
            : t('WorkItemEstimateScreen.withinEstimate')
        }
      >
        {varianceMinutes === null
          ? ''
          : over
            ? `${formatMinutes(Math.abs(varianceMinutes))} ${t('WorkItemEstimateScreen.overTheEstimate')}`
            : `${formatMinutes(varianceMinutes)} ${t('WorkItemEstimateScreen.remaining')}`}
      </InlineAlert>
    </div>
  );
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}
