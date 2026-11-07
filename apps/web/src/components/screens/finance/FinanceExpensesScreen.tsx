'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Field,
  InlineAlert,
  LoadingRegion,
  Select,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import {
  createExpense,
  decideExpense,
  listExpenses,
  type Expense,
} from '../../../lib/api/finance-core';
import {
  EXPENSE_CURRENCIES,
  isCannotApproveOwn,
  mayDecide,
  parseAmountToMinor,
  stateCapsule,
} from '../../../lib/finance-presentation';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceCoreNav, useFinanceMe, usePersonName } from './FinanceCoreNav';

export interface FinanceExpensesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const CATEGORIES = ['Ads', 'Software', 'Travel', 'Print', 'Freelancer', 'Other'] as const;

/**
 * **Expenses (A10a).** A member records an expense and submits it; an approver (`project.manage`
 * or `finance.manage`) approves or rejects somebody else's submitted expense. Approve / Reject are
 * never shown on the member's own expense (B20); should the API still answer
 * `cannot_approve_own`, the screen says so in the member's language.
 */
export function FinanceExpensesScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceExpensesScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const format = useDisplayFormatters();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const { me, can } = useFinanceMe(api, organizationSlug);
  const canApprove = can('project.manage') || can('finance.manage');
  const queryKey = ['finance-expenses', organizationSlug];
  const nameOf = usePersonName(api, organizationSlug, me?.membershipId, canApprove);

  const expenses = useQuery({ queryKey, queryFn: () => listExpenses(api, organizationSlug) });

  const [category, setCategory] = useState<string>('Software');
  const [spentOn, setSpentOn] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>('SAR');
  const [note, setNote] = useState('');
  const [billable, setBillable] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const amountMinor = parseAmountToMinor(amount, currency);
  const formValid = amountMinor !== null && /^\d{4}-\d{2}-\d{2}$/u.test(spentOn);

  const create = useMutation({
    mutationFn: (state: 'draft' | 'submitted') =>
      createExpense(api, organizationSlug, {
        spentOn,
        category,
        amountMinor: amountMinor ?? 0,
        currency,
        billable,
        note: note.trim() === '' ? null : note.trim(),
        state,
      }),
    onSuccess: async () => {
      setAmount('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; action: 'submit' | 'approve' | 'reject'; note?: string }) =>
      decideExpense(api, organizationSlug, input.id, input.action, input.note),
    onSuccess: async () => {
      setRejecting(null);
      setRejectNote('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = expenses.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceCore.eyebrow', 'Finance')}
      title={tOr('FinanceExpenses.title', 'Expenses')}
      description={tOr(
        'FinanceExpenses.description',
        'Record what you spent and send it for approval.',
      )}
    >
      <div className="tm-stack">
        <FinanceCoreNav organizationSlug={organizationSlug} active="expenses" />

        <section className="tm-panel tm-stack" aria-labelledby="tm-fx-new">
          <h2 id="tm-fx-new" className="tm-eyebrow">
            {tOr('FinanceExpenses.newHeading', 'New expense')}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (formValid) create.mutate('submitted');
            }}
          >
            <div className="tm-row tm-row--wrap">
              <Select
                label={tOr('FinanceExpenses.category', 'Category')}
                name="category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {tOr(`FinanceExpenses.category.${value}`, value)}
                  </option>
                ))}
              </Select>
              <Field
                label={tOr('FinanceExpenses.date', 'Date')}
                name="spentOn"
                type="date"
                value={spentOn}
                onChange={(event) => setSpentOn(event.target.value)}
                required
              />
              <Field
                label={tOr('FinanceExpenses.amount', 'Amount')}
                name="amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
              <Select
                label={tOr('FinanceExpenses.currency', 'Currency')}
                name="currency"
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {EXPENSE_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
              <Field
                label={tOr('FinanceExpenses.note', 'Note')}
                name="note"
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <Checkbox
              label={tOr('FinanceExpenses.billable', 'Billable to the client')}
              checked={billable}
              onChange={(event) => setBillable(event.target.checked)}
            />
            {create.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceExpenses.saveError', 'The expense was not saved')}
                live
              >
                {describeError(create.error)}
              </InlineAlert>
            ) : null}
            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                disabled={!formValid || create.isPending}
                loading={create.isPending}
              >
                {tOr('FinanceExpenses.submit', 'Submit for approval')}
              </Button>
              <Button
                tone="outline"
                disabled={!formValid || create.isPending}
                onClick={() => create.mutate('draft')}
              >
                {tOr('FinanceExpenses.saveDraft', 'Save draft')}
              </Button>
            </div>
          </form>
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-fx-list">
          <h2 id="tm-fx-list" className="tm-eyebrow">
            {tOr('FinanceExpenses.listHeading', 'Expenses')}
          </h2>

          {expenses.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('FinanceExpenses.loadError', 'Expenses could not be loaded')}
              live
            >
              {describeError(expenses.error)}
            </InlineAlert>
          ) : null}

          {expenses.isPending ? (
            <LoadingRegion label={tOr('FinanceExpenses.loading', 'Loading expenses')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {expenses.isSuccess && rows.length === 0 ? (
            <InlineAlert
              tone="neutral"
              title={tOr('FinanceExpenses.emptyTitle', 'No expenses yet')}
            >
              {tOr(
                'FinanceExpenses.emptyBody',
                'Add your first expense with the form above and submit it for approval.',
              )}
            </InlineAlert>
          ) : null}

          {decide.isError ? (
            isCannotApproveOwn(decide.error) ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceExpenses.ownTitle', 'You cannot decide on your own expense')}
                live
              >
                {tOr(
                  'FinanceExpenses.ownBody',
                  'Someone else with approval rights must approve or reject it.',
                )}
              </InlineAlert>
            ) : (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceExpenses.decideError', 'The decision was not saved')}
                live
              >
                {describeError(decide.error)}
              </InlineAlert>
            )
          ) : null}

          {rows.length > 0 ? (
            <div className="tm-table-scroll">
              <table
                className="tm-table"
                aria-label={tOr('FinanceExpenses.tableLabel', 'Expenses')}
              >
                <thead>
                  <tr>
                    <th scope="col">{tOr('FinanceExpenses.date', 'Date')}</th>
                    {canApprove ? (
                      <th scope="col">{tOr('FinanceExpenses.person', 'Person')}</th>
                    ) : null}
                    <th scope="col">{tOr('FinanceExpenses.category', 'Category')}</th>
                    <th scope="col">{tOr('FinanceExpenses.amount', 'Amount')}</th>
                    <th scope="col">{tOr('FinanceExpenses.state', 'State')}</th>
                    <th scope="col">
                      <span className="tm-visually-hidden">
                        {tOr('FinanceExpenses.actions', 'Actions')}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((expense: Expense) => {
                    const own = expense.membershipId === me?.membershipId;
                    const decidable = mayDecide(
                      expense.membershipId,
                      me?.membershipId,
                      canApprove,
                      expense.state,
                    );
                    return (
                      <tr key={expense.id}>
                        <td>{format.day(expense.spentOn)}</td>
                        {canApprove ? <td>{nameOf(expense.membershipId)}</td> : null}
                        <td>
                          {tOr(`FinanceExpenses.category.${expense.category}`, expense.category)}
                          {expense.note ? ` — ${expense.note}` : ''}
                        </td>
                        <td>{format.money(expense.amountMinor, expense.currency)}</td>
                        <td>
                          <StateCapsule state={stateCapsule(expense.state)}>
                            {tOr(`FinanceExpenses.state.${expense.state}`, expense.state)}
                          </StateCapsule>
                        </td>
                        <td>
                          <div className="tm-row tm-row--wrap">
                            {own && (expense.state === 'draft' || expense.state === 'rejected') ? (
                              <Button
                                size="compact"
                                tone="outline"
                                disabled={decide.isPending}
                                onClick={() => decide.mutate({ id: expense.id, action: 'submit' })}
                              >
                                {tOr('FinanceExpenses.submitOne', 'Submit')}
                              </Button>
                            ) : null}
                            {own && expense.state === 'submitted' && canApprove ? (
                              <span className="tm-field__hint">
                                {tOr(
                                  'FinanceExpenses.awaitingOther',
                                  'Waiting for another approver',
                                )}
                              </span>
                            ) : null}
                            {decidable && rejecting !== expense.id ? (
                              <>
                                <Button
                                  size="compact"
                                  tone="ink"
                                  disabled={decide.isPending}
                                  onClick={() =>
                                    decide.mutate({ id: expense.id, action: 'approve' })
                                  }
                                >
                                  {tOr('FinanceExpenses.approve', 'Approve')}
                                </Button>
                                <Button
                                  size="compact"
                                  tone="destructive"
                                  disabled={decide.isPending}
                                  onClick={() => setRejecting(expense.id)}
                                >
                                  {tOr('FinanceExpenses.reject', 'Reject')}
                                </Button>
                              </>
                            ) : null}
                            {decidable && rejecting === expense.id ? (
                              <form
                                className="tm-row tm-row--wrap"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  if (rejectNote.trim().length >= 3)
                                    decide.mutate({
                                      id: expense.id,
                                      action: 'reject',
                                      note: rejectNote.trim(),
                                    });
                                }}
                              >
                                <Field
                                  label={tOr('FinanceExpenses.rejectReason', 'Reason')}
                                  name="rejectNote"
                                  value={rejectNote}
                                  minLength={3}
                                  maxLength={500}
                                  onChange={(event) => setRejectNote(event.target.value)}
                                />
                                <Button
                                  type="submit"
                                  size="compact"
                                  tone="destructive"
                                  disabled={rejectNote.trim().length < 3 || decide.isPending}
                                >
                                  {tOr('FinanceExpenses.confirmReject', 'Reject expense')}
                                </Button>
                                <Button
                                  size="compact"
                                  tone="text"
                                  onClick={() => setRejecting(null)}
                                >
                                  {tOr('FinanceCore.cancel', 'Cancel')}
                                </Button>
                              </form>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
