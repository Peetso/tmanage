'use client';

import { useEffect, useId, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { fetchPlanUsagePreview } from '../../lib/api/plan-usage';
import type {
  PlanUsageChangeView,
  PlanUsageOverageView,
  PlanUsagePreviewView,
} from '../../lib/api/plan-usage';
import { createPlanChangeRequest } from '../../lib/api/plan-change-requests';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { PlanUsageCopyKey } from './plan-usage-copy';
import { dayMonth, fill, gb, money, planName, planUsageText } from './plan-usage-format';
import type { PlanUsageText } from './plan-usage-format';

export interface PlanChangeDialogProps {
  readonly organizationSlug: string;
  readonly targetPlanId: string;
  readonly client: ApiClient;
  /** `true` once the change request was recorded. */
  readonly onClose: (requested: boolean) => void;
}

/**
 * Change preview — Figma F4 390:22697 (upgrade) / 390:22759 (downgrade), phone 390:22881. Reads
 * `GET …/billing/plan-usage/preview?target=`; confirming records an audited plan-change request
 * (`POST …/billing/plan-change-requests`) effective on the preview's start date. Nothing is
 * charged here.
 */
export function PlanChangeDialog({
  organizationSlug,
  targetPlanId,
  client,
  onClose,
}: PlanChangeDialogProps) {
  const tr = planUsageText(useTOr());
  const locale = useActiveLocale();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  const preview = useQuery({
    queryKey: ['plan-usage-preview', organizationSlug, targetPlanId],
    queryFn: () => fetchPlanUsagePreview(client, organizationSlug, targetPlanId),
  });

  const confirm = useMutation({
    mutationFn: (view: PlanUsagePreviewView) =>
      createPlanChangeRequest(client, organizationSlug, {
        targetPlanCode: view.targetPlanId,
        effectiveOn: view.startsOn,
      }),
    onSuccess: () => onClose(true),
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose(false);
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const target = planName(targetPlanId);

  return (
    <div className="tm-pu-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="tm-pu-dialog"
      >
        <button type="button" className="tm-pu-dialog__back" onClick={() => onClose(false)}>
          <span aria-hidden="true">‹</span>
          {tr('PlanUsage.back')}
        </button>
        <h2 id={titleId} className="tm-pu-dialog__title">
          {fill(tr('PlanUsage.dialogTitle'), { plan: target })}
        </h2>
        <p className="tm-pu-dialog__lede">{tr('PlanUsage.dialogLede')}</p>

        {preview.isPending ? (
          <LoadingRegion
            label={tr('PlanUsage.previewLoading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="176px" />
            <Skeleton height="120px" />
          </LoadingRegion>
        ) : null}

        {preview.isError ? (
          <InlineAlert tone="danger" live>
            {preview.error instanceof ApiRequestError
              ? preview.error.message
              : tr('PlanUsage.previewError')}
          </InlineAlert>
        ) : null}

        {preview.isSuccess ? <PreviewBody view={preview.data} locale={locale} tr={tr} /> : null}

        {confirm.isError ? (
          <InlineAlert tone="danger" live>
            {confirm.error instanceof ApiRequestError && confirm.error.status === 409
              ? tr('PlanUsage.confirmPending')
              : tr('PlanUsage.confirmError')}
          </InlineAlert>
        ) : null}

        <hr className="tm-pu-rule" />
        <div className="tm-pu-dialog__actions">
          <Button type="button" tone="outline" onClick={() => onClose(false)}>
            {tr('PlanUsage.cancel')}
          </Button>
          <Button
            type="button"
            tone="ink"
            disabled={!preview.isSuccess}
            loading={confirm.isPending}
            onClick={() => (preview.data ? confirm.mutate(preview.data) : undefined)}
          >
            {fill(tr('PlanUsage.confirm'), { plan: target })}
          </Button>
        </div>
      </section>
    </div>
  );
}

function PreviewBody({
  view,
  locale,
  tr,
}: {
  view: PlanUsagePreviewView;
  locale: string;
  tr: PlanUsageText;
}) {
  const from = planName(view.currentPlanId);
  const to = planName(view.targetPlanId);
  const starts = dayMonth(view.startsOn, locale);
  const today = money(view.dueTodayCents, view.currency);

  return (
    <>
      <dl className="tm-pu-summary">
        <div className="tm-pu-summary__row">
          <dt>{tr('PlanUsage.rowPlan')}</dt>
          <dd>{fill(tr('PlanUsage.rowPlanValue'), { from, to })}</dd>
        </div>
        <div className="tm-pu-summary__row">
          <dt>{tr('PlanUsage.rowPrice')}</dt>
          <dd>
            {fill(tr('PlanUsage.rowPriceValue'), {
              price: money(view.targetMonthlyCents, view.currency),
              current: money(view.currentMonthlyCents, view.currency),
            })}
          </dd>
        </div>
        <div className="tm-pu-summary__row">
          <dt>{tr('PlanUsage.rowStarts')}</dt>
          <dd>
            {fill(tr(view.startsToday ? 'PlanUsage.startsToday' : 'PlanUsage.startsLater'), {
              date: starts,
            })}
          </dd>
        </div>
        <div className="tm-pu-summary__row">
          <dt>{tr('PlanUsage.rowToday')}</dt>
          <dd>
            {view.startsToday
              ? today
              : fill(tr('PlanUsage.todayDowngrade'), { amount: today, plan: from, date: starts })}
          </dd>
        </div>
      </dl>

      <h3 className="tm-pu-dialog__subhead">{tr('PlanUsage.changesHeading')}</h3>
      <ul className="tm-pu-changes">
        {view.changes.map((change) => (
          <li key={`${change.kind}:${change.feature ?? ''}`}>
            <StatusDot tone={changeTone(change)}>{changeText(change, tr)}</StatusDot>
          </li>
        ))}
      </ul>

      {view.overages.length > 0 && view.graceEndsOn !== null
        ? view.overages.map((overage) => (
            <InlineAlert key={overage.kind} tone="warning">
              {overageText(overage, to, dayMonth(view.graceEndsOn as string, locale), tr)}
            </InlineAlert>
          ))
        : null}

      {view.startsToday && view.dueTodayCents > 0 ? (
        <InlineAlert tone="neutral">
          {fill(tr(view.daysLeft === 1 ? 'PlanUsage.proratedOne' : 'PlanUsage.prorated'), {
            days: view.daysLeft,
            date: dayMonth(view.fullPriceFrom, locale),
            price: money(view.targetMonthlyCents, view.currency),
          })}
        </InlineAlert>
      ) : null}
    </>
  );
}

/** Gains are green; a loss the organization still fits is neutral; anything else is red. */
function changeTone(change: PlanUsageChangeView): StatusTone {
  if (change.direction === 'gain') return 'success';
  return change.kind !== 'feature' && change.fits ? 'neutral' : 'danger';
}

function changeText(change: PlanUsageChangeView, tr: PlanUsageText): string {
  if (change.kind === 'feature') {
    return tr(`PlanUsage.${change.direction}.${change.feature ?? ''}` as PlanUsageCopyKey);
  }
  const isStorage = change.kind === 'storage';
  const show = (value: number | null) =>
    value === null ? '' : isStorage ? gb(value) : String(value);
  const values = {
    from: show(change.fromLimit),
    to: show(change.toLimit),
    used: show(change.used),
  };
  if (isStorage) {
    return fill(
      tr(change.direction === 'gain' ? 'PlanUsage.storageGain' : 'PlanUsage.storageLose'),
      values,
    );
  }
  const prefix = change.kind === 'people' ? 'PlanUsage.people' : 'PlanUsage.projects';
  const key =
    change.direction === 'lose'
      ? `${prefix}Lose`
      : change.toLimit === null
        ? `${prefix}GainUnlimited`
        : `${prefix}Gain`;
  return fill(tr(key as PlanUsageCopyKey), values);
}

function overageText(
  overage: PlanUsageOverageView,
  plan: string,
  date: string,
  tr: PlanUsageText,
): string {
  const storage = overage.kind === 'storage';
  const key: PlanUsageCopyKey = storage
    ? 'PlanUsage.overStorage'
    : overage.kind === 'people'
      ? 'PlanUsage.overPeople'
      : 'PlanUsage.overProjects';
  return fill(tr(key), {
    over: storage ? gb(overage.over) : overage.over,
    limit: storage ? gb(overage.limit) : overage.limit,
    plan,
    date,
  });
}
