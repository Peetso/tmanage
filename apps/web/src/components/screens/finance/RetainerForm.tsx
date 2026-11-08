'use client';

import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, Select } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { createRetainer, updateRetainer, type RetainerRow } from './RetainerApi';
import {
  BILLING_TIMINGS,
  RETAINER_PERIODS,
  ROLLOVER_RULES,
  newRetainerDraft,
  retainerDraftToBody,
  retainerToDraft,
  type RetainerDraft,
  type RetainerField,
} from './RetainerFormRules';

export interface RetainerFormProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly clientOrganizationId: string;
  /** `null` writes a new retainer. */
  readonly retainer: RetainerRow | null;
  /** The organization's base currency — the retainer amount is kept in it. */
  readonly currency: string;
  readonly onDone: (saved: RetainerRow | null) => void;
}

const OPTION_WORDS: Record<string, readonly [string, string]> = {
  monthly: ['RetainerList.periodMonthly', 'Monthly'],
  quarterly: ['RetainerList.periodQuarterly', 'Quarterly'],
  none: ['RetainerForm.rolloverNone', 'Expire at the end of the period'],
  cap: ['RetainerForm.rolloverCap', 'Roll over up to a cap'],
  unlimited: ['RetainerForm.rolloverUnlimited', 'Roll over without a cap'],
  advance: ['RetainerForm.billingAdvance', 'In advance'],
  arrears: ['RetainerForm.billingArrears', 'In arrears'],
};

const PROBLEM_WORDS: Record<RetainerField, readonly [string, string]> = {
  name: ['RetainerForm.problemName', 'Give the retainer a name of up to 120 characters.'],
  hours: [
    'RetainerForm.problemHours',
    'Enter whole hours from 1 to 10,000 — needed when there is no amount or hours roll over.',
  ],
  amount: ['RetainerForm.problemAmount', 'Enter an amount such as 18000 or 18000.50.'],
  capHours: ['RetainerForm.problemCap', 'Enter the most hours that may roll over.'],
  startsOn: ['RetainerForm.problemStarts', 'Choose the first day of the retainer.'],
  endsOn: ['RetainerForm.problemEnds', 'The end cannot be before the start.'],
};

/**
 * **New / edit retainer** (52-06), drawn as the R35 L6-52-09 Figma frame "Retainers · New / edit
 * retainer": amount, period, hours bucket and rollover. `POST …/client-organizations/:id/retainers`
 * or `PUT …/retainers/:id` on `finance.manage`; the API re-checks every rule. Period, billing timing
 * and start date are fixed once the retainer exists.
 */
export function RetainerForm({
  api,
  organizationSlug,
  clientOrganizationId,
  retainer,
  currency,
  onDone,
}: RetainerFormProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const editing = retainer !== null;
  const [draft, setDraft] = useState<RetainerDraft>(() =>
    retainer === null ? newRetainerDraft(new Date()) : retainerToDraft(retainer, currency),
  );
  const [problem, setProblem] = useState<RetainerField | null>(null);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof createRetainer>[3]) =>
      retainer === null
        ? createRetainer(api, organizationSlug, clientOrganizationId, body)
        : updateRetainer(api, organizationSlug, retainer.id, body),
    onSuccess: (saved) => onDone(saved),
  });

  const change = (patch: Partial<RetainerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const errorOf = (field: RetainerField) =>
    problem === field ? tOr(...PROBLEM_WORDS[field]) : undefined;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = retainerDraftToBody(draft, currency, editing ? 'edit' : 'create');
    if (!result.ok) {
      setProblem(result.field);
      return;
    }
    save.mutate(result.body);
  };

  return (
    <form
      className="tm-card tm-stack"
      aria-labelledby="tm-retainer-form"
      onSubmit={onSubmit}
      noValidate
    >
      <h2 id="tm-retainer-form" className="tm-fin-card-title">
        {editing
          ? tOr('RetainerForm.editTitle', 'Edit retainer')
          : tOr('RetainerForm.newTitle', 'New retainer')}
      </h2>
      <div className="tm-fin-form">
        <Field
          label={tOr('RetainerForm.name', 'Name')}
          value={draft.name}
          maxLength={120}
          error={errorOf('name')}
          onChange={(event) => change({ name: event.target.value })}
        />
        <Select
          label={tOr('RetainerForm.period', 'Period')}
          value={draft.period}
          disabled={editing}
          hint={tOr('RetainerForm.fixedHint', 'Period and start date cannot change later')}
          onChange={(event) => change({ period: event.target.value })}
        >
          {RETAINER_PERIODS.map((value) => (
            <option key={value} value={value}>
              {tOr(...OPTION_WORDS[value]!)}
            </option>
          ))}
        </Select>
      </div>
      <div className="tm-fin-form">
        <Field
          label={tOr('RetainerForm.hours', 'Hours per period')}
          inputMode="numeric"
          value={draft.hours}
          error={errorOf('hours')}
          onChange={(event) => change({ hours: event.target.value })}
        />
        <Field
          label={`${tOr('RetainerForm.amount', 'Amount per period')} (${currency})`}
          inputMode="decimal"
          value={draft.amount}
          error={errorOf('amount')}
          onChange={(event) => change({ amount: event.target.value })}
        />
        <Select
          label={tOr('RetainerForm.billing', 'Billing')}
          value={draft.billingTiming}
          disabled={editing}
          onChange={(event) => change({ billingTiming: event.target.value })}
        >
          {BILLING_TIMINGS.map((value) => (
            <option key={value} value={value}>
              {tOr(...OPTION_WORDS[value]!)}
            </option>
          ))}
        </Select>
      </div>
      <div className="tm-fin-form">
        <Select
          label={tOr('RetainerForm.rollover', 'Unused hours')}
          value={draft.rollover}
          onChange={(event) => change({ rollover: event.target.value })}
        >
          {ROLLOVER_RULES.map((value) => (
            <option key={value} value={value}>
              {tOr(...OPTION_WORDS[value]!)}
            </option>
          ))}
        </Select>
        {draft.rollover === 'cap' ? (
          <Field
            label={tOr('RetainerForm.cap', 'Cap (hours)')}
            inputMode="numeric"
            value={draft.capHours}
            error={errorOf('capHours')}
            onChange={(event) => change({ capHours: event.target.value })}
          />
        ) : null}
      </div>
      <div className="tm-fin-form">
        <Field
          label={tOr('RetainerForm.startsOn', 'Starts on')}
          type="date"
          value={draft.startsOn}
          readOnly={editing}
          error={errorOf('startsOn')}
          onChange={(event) => change({ startsOn: event.target.value })}
        />
        <Field
          label={tOr('RetainerForm.endsOn', 'Ends on')}
          type="date"
          value={draft.endsOn}
          hint={tOr('RetainerForm.optional', 'Optional')}
          error={errorOf('endsOn')}
          onChange={(event) => change({ endsOn: event.target.value })}
        />
      </div>
      <Checkbox
        label={tOr('RetainerForm.clientVisible', 'The client can see this retainer')}
        checked={draft.clientVisible}
        onChange={(event) => change({ clientVisible: event.target.checked })}
      />
      {save.isError ? (
        <InlineAlert tone="danger" live>
          {describe(save.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-row">
        <Button
          type="submit"
          tone="ink"
          loading={save.isPending}
          loadingLabel={tOr('RetainerList.saving', 'Saving')}
        >
          {tOr('RetainerForm.save', 'Save retainer')}
        </Button>
        <Button type="button" tone="outline" onClick={() => onDone(null)}>
          {tOr('RetainerForm.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}
