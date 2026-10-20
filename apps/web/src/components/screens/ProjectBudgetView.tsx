'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getProjectBudget, saveProjectBudget } from '../../lib/api/project-budget';
import type { ProjectBudgetSummary } from '../../lib/api/project-budget';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

type Translate = ReturnType<typeof useT>;

export interface ProjectBudgetViewProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose budget this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

/**
 * **Project budget (x293).**
 *
 * `22-SCREEN-INVENTORY` §PRJ / `38-MODULE-MAP` §Projects: a budget panel on the project detail. It
 * reads `GET …/projects/:id/budget` for the budget-vs-tracked summary — budgeted hours against the
 * effort already logged on the project's work items, with the amount remaining — and writes
 * `PUT …/projects/:id/budget` to set or edit it, both gated on the server by `project.manage`. The
 * amount is a planning figure, never a payment.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence.
 */
export function ProjectBudgetView({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectBudgetViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [hours, setHours] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');

  const budget = useQuery({
    queryKey: ['project-budget', organizationSlug, projectId],
    queryFn: () => getProjectBudget(api, organizationSlug, projectId),
  });

  // Seed the form from the loaded budget once, so an editor starts from the current figures.
  useEffect(() => {
    if (!budget.data) return;
    setHours(budget.data.budgetHours === null ? '' : String(budget.data.budgetHours));
    setAmount(
      budget.data.budgetAmountMinor === null ? '' : String(budget.data.budgetAmountMinor / 100),
    );
    setCurrency(budget.data.currency ?? '');
  }, [budget.data]);

  const save = useMutation({
    mutationFn: () => {
      const hoursValue = hours.trim() === '' ? undefined : Number(hours);
      const amountMajor = amount.trim() === '' ? undefined : Number(amount);
      const amountMinor = amountMajor === undefined ? undefined : Math.round(amountMajor * 100);
      const currencyValue = currency.trim() === '' ? undefined : currency.trim().toUpperCase();
      return saveProjectBudget(api, organizationSlug, projectId, {
        ...(hoursValue === undefined ? {} : { budgetHours: hoursValue }),
        ...(amountMinor === undefined ? {} : { budgetAmountMinor: amountMinor }),
        ...(currencyValue === undefined ? {} : { currency: currencyValue }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['project-budget', organizationSlug, projectId],
      });
    },
  });

  const hasDimension = hours.trim() !== '' || amount.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasDimension || save.isPending) return;
    save.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('ProjectBudgetView.title')}
      description={t('ProjectBudgetView.description')}
    >
      {budget.isError ? (
        <InlineAlert tone="danger" title={t('ProjectBudgetView.couldNotLoad')} live>
          {describeError(budget.error, t)}
        </InlineAlert>
      ) : null}

      {budget.isPending ? (
        <LoadingRegion label={t('ProjectBudgetView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {budget.data ? <BudgetSummary summary={budget.data} t={t} /> : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-budget-author">
        <h2 id="tm-budget-author" className="tm-eyebrow">
          {t('ProjectBudgetView.setBudgetHeading')}
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={save.isPending}>
            <Field
              label={t('ProjectBudgetView.budgetedHoursLabel')}
              name="budgetHours"
              type="number"
              inputMode="decimal"
              min={0}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              hint={t('ProjectBudgetView.budgetedHoursHint')}
            />
            <Field
              label={t('ProjectBudgetView.budgetedAmountLabel')}
              name="budgetAmount"
              type="number"
              inputMode="decimal"
              min={0}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              hint={t('ProjectBudgetView.budgetedAmountHint')}
            />
            <Field
              label={t('ProjectBudgetView.currencyLabel')}
              name="currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              hint={t('ProjectBudgetView.currencyHint')}
              maxLength={3}
            />
          </fieldset>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('ProjectBudgetView.couldNotSave')} live>
              {describeError(save.error, t)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel={t('ProjectBudgetView.saving')}
              disabled={!hasDimension}
            >
              {t('ProjectBudgetView.saveButton')}
            </Button>
          </div>
        </form>
      </section>
    </AppShell>
  );
}

/** The budget-vs-tracked headline: budgeted vs tracked hours, and what remains. */
function BudgetSummary({ summary, t }: { summary: ProjectBudgetSummary; t: Translate }) {
  const hasEffortBudget = summary.budgetHours !== null;
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-budget-summary-heading">
      <h2 id="tm-budget-summary-heading" className="tm-eyebrow">
        {t('ProjectBudgetView.budgetVsTracked')}
      </h2>
      <dl className="tm-row">
        <div className="tm-stat">
          <dt className="tm-stat__label">{t('ProjectBudgetView.statBudgetedHours')}</dt>
          <dd className="tm-stat__value">{hasEffortBudget ? summary.budgetHours : '—'}</dd>
        </div>
        <div className="tm-stat">
          <dt className="tm-stat__label">{t('ProjectBudgetView.statTrackedHours')}</dt>
          <dd className="tm-stat__value">{summary.trackedHours}</dd>
        </div>
        <div className="tm-stat">
          <dt className="tm-stat__label">{t('ProjectBudgetView.statRemainingHours')}</dt>
          <dd className="tm-stat__value">
            {summary.remainingHours === null ? '—' : summary.remainingHours}
          </dd>
        </div>
        {summary.budgetAmountMinor !== null ? (
          <div className="tm-stat">
            <dt className="tm-stat__label">{t('ProjectBudgetView.statBudgetedAmount')}</dt>
            <dd className="tm-stat__value">
              {(summary.budgetAmountMinor / 100).toFixed(2)} {summary.currency}
            </dd>
          </div>
        ) : null}
      </dl>
      {hasEffortBudget && summary.varianceHours !== null && summary.varianceHours > 0 ? (
        <InlineAlert tone="warning" title={t('ProjectBudgetView.overBudget')}>
          {t('ProjectBudgetView.overBudgetLead')} {summary.varianceHours}{' '}
          {t('ProjectBudgetView.overBudgetTail')}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectBudgetView.apiError');
  return t('ProjectBudgetView.genericError');
}
