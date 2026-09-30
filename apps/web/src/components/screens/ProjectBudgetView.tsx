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
      title="Budget"
      description="This project's budgeted effort and amount, against the effort already tracked."
    >
      {budget.isError ? (
        <InlineAlert tone="danger" title="Could not load the budget" live>
          {describeError(budget.error)}
        </InlineAlert>
      ) : null}

      {budget.isPending ? (
        <LoadingRegion label="Loading the project's budget.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {budget.data ? <BudgetSummary summary={budget.data} /> : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-budget-author">
        <h2 id="tm-budget-author" className="tm-eyebrow">
          Set the budget
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={save.isPending}>
            <Field
              label="Budgeted hours"
              name="budgetHours"
              type="number"
              inputMode="decimal"
              min={0}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              hint="Planned effort in hours. Leave blank to budget only an amount."
            />
            <Field
              label="Budgeted amount"
              name="budgetAmount"
              type="number"
              inputMode="decimal"
              min={0}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              hint="Planning figure in the currency's major unit. Leave blank to budget only hours."
            />
            <Field
              label="Currency"
              name="currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              hint="Three-letter code (e.g. USD). Required with an amount."
              maxLength={3}
            />
          </fieldset>

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not save the budget" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel="Saving"
              disabled={!hasDimension}
            >
              Save budget
            </Button>
          </div>
        </form>
      </section>
    </AppShell>
  );
}

/** The budget-vs-tracked headline: budgeted vs tracked hours, and what remains. */
function BudgetSummary({ summary }: { summary: ProjectBudgetSummary }) {
  const hasEffortBudget = summary.budgetHours !== null;
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-budget-summary-heading">
      <h2 id="tm-budget-summary-heading" className="tm-eyebrow">
        Budget vs tracked
      </h2>
      <dl className="tm-row">
        <div className="tm-stat">
          <dt className="tm-stat__label">Budgeted hours</dt>
          <dd className="tm-stat__value">{hasEffortBudget ? summary.budgetHours : '—'}</dd>
        </div>
        <div className="tm-stat">
          <dt className="tm-stat__label">Tracked hours</dt>
          <dd className="tm-stat__value">{summary.trackedHours}</dd>
        </div>
        <div className="tm-stat">
          <dt className="tm-stat__label">Remaining hours</dt>
          <dd className="tm-stat__value">
            {summary.remainingHours === null ? '—' : summary.remainingHours}
          </dd>
        </div>
        {summary.budgetAmountMinor !== null ? (
          <div className="tm-stat">
            <dt className="tm-stat__label">Budgeted amount</dt>
            <dd className="tm-stat__value">
              {(summary.budgetAmountMinor / 100).toFixed(2)} {summary.currency}
            </dd>
          </div>
        ) : null}
      </dl>
      {hasEffortBudget && summary.varianceHours !== null && summary.varianceHours > 0 ? (
        <InlineAlert tone="warning" title="Over budget">
          Tracked effort is {summary.varianceHours} hours over the budgeted effort.
        </InlineAlert>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
