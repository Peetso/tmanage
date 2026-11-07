'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import { closePeriod, listPeriodLocks, reopenPeriod } from './PeriodLockApi';
import { isReopenReasonValid, monthWindow } from './PeriodLockRules';
import '../../../styles/screens/finance-ledger.css';

export interface PeriodLockScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Period locks** — close a month so its time, expenses and invoice dates cannot change, and reopen
 * it with a reason (A10b, 52-03). The list is `finance.view`; closing and reopening are
 * `finance.manage`, enforced by the API, whose refusal is shown as a sentence. Whole months only,
 * the API's rule, so the form asks for a month rather than two dates.
 */
export function PeriodLockScreen({
  organizationSlug,
  organizationName,
  client,
}: PeriodLockScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { day } = useDisplayFormatters();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState('');
  const [monthError, setMonthError] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const locks = useQuery({
    queryKey: ['period-locks', organizationSlug],
    queryFn: () => listPeriodLocks(api, organizationSlug),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['period-locks', organizationSlug] });
  const close = useMutation({
    mutationFn: (window: { periodStart: string; periodEnd: string }) =>
      closePeriod(api, organizationSlug, window),
    onSuccess: () => {
      setMonth('');
      void refresh();
    },
  });
  const reopen = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      reopenPeriod(api, organizationSlug, input.id, input.reason.trim()),
    onSuccess: () => {
      setReopening(null);
      setReason('');
      void refresh();
    },
  });

  function submitClose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const window = monthWindow(month);
    if (window === null) {
      setMonthError(tOr('PeriodLock.monthInvalid', 'Choose a month to close.'));
      return;
    }
    setMonthError(null);
    close.mutate(window);
  }

  function submitReopen(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (!isReopenReasonValid(reason)) {
      setReasonError(tOr('PeriodLock.reasonInvalid', 'Say why, in 3 to 500 characters.'));
      return;
    }
    setReasonError(null);
    reopen.mutate({ id, reason });
  }

  const rows = locks.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('FinanceIndex.eyebrow', 'Finance')}
      title={tOr('PeriodLock.title', 'Period locks')}
      description={tOr(
        'PeriodLock.description',
        'A closed month keeps its time, expenses and invoice dates as they are.',
      )}
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="period-locks" />

        <div className="tm-fin">
          <div className="tm-stack">
            {locks.isPending ? (
              <LoadingRegion
                label={tOr('PeriodLock.loading', 'Loading period locks')}
                className="tm-stack tm-stack--tight"
              >
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {locks.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PeriodLock.errorTitle', 'Period locks could not load')}
                live
              >
                {describe(locks.error)}
              </InlineAlert>
            ) : null}
            {reopen.isError ? (
              <InlineAlert tone="danger" live>
                {describe(reopen.error)}
              </InlineAlert>
            ) : null}
            {locks.isSuccess && rows.length === 0 ? (
              <div className="tm-card tm-card--empty">
                <InlineAlert
                  tone="neutral"
                  title={tOr('PeriodLock.emptyTitle', 'No month is closed')}
                >
                  {tOr(
                    'PeriodLock.emptyBody',
                    'Close a month once its time and invoices are final.',
                  )}
                </InlineAlert>
              </div>
            ) : null}
            {rows.length > 0 ? (
              <div className="tm-fin-table-card">
                <table className="tm-table">
                  <thead>
                    <tr>
                      <th scope="col">{tOr('PeriodLock.colPeriod', 'Period')}</th>
                      <th scope="col">{tOr('PeriodLock.colState', 'State')}</th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('PeriodLock.colEntries', 'Time entries')}
                      </th>
                      <th scope="col">{tOr('PeriodLock.colClosedOn', 'Closed on')}</th>
                      <th scope="col">
                        <span className="tm-visually-hidden">
                          {tOr('PeriodLock.colActions', 'Actions')}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {day(row.periodStart)} – {day(row.periodEnd)}
                        </td>
                        <td>
                          <StateCapsule state={row.open ? 'blocked' : 'archived'}>
                            {row.open
                              ? tOr('PeriodLock.stateClosed', 'Closed')
                              : tOr('PeriodLock.stateReopened', 'Reopened')}
                          </StateCapsule>
                          {!row.open && row.reason ? (
                            <p className="tm-fin-muted">{row.reason}</p>
                          ) : null}
                        </td>
                        <td className="tm-mono tm-fin-num">{row.entriesLocked}</td>
                        <td>{day(row.lockedAt)}</td>
                        <td>
                          {row.open && reopening !== row.id ? (
                            <Button
                              type="button"
                              tone="outline"
                              size="compact"
                              onClick={() => {
                                setReopening(row.id);
                                setReason('');
                                setReasonError(null);
                              }}
                            >
                              {tOr('PeriodLock.reopen', 'Reopen')}
                            </Button>
                          ) : null}
                          {reopening === row.id ? (
                            <form
                              className="tm-fin-form"
                              onSubmit={(event) => submitReopen(event, row.id)}
                            >
                              <Field
                                label={tOr('PeriodLock.reasonLabel', 'Why reopen it')}
                                value={reason}
                                maxLength={500}
                                required
                                error={reasonError ?? undefined}
                                onChange={(event) => setReason(event.target.value)}
                              />
                              <Button
                                type="submit"
                                tone="destructive"
                                size="compact"
                                loading={reopen.isPending}
                                loadingLabel={tOr('PeriodLock.saving', 'Saving')}
                              >
                                {tOr('PeriodLock.reopenConfirm', 'Reopen month')}
                              </Button>
                              <Button
                                type="button"
                                tone="text"
                                size="compact"
                                onClick={() => setReopening(null)}
                              >
                                {tOr('PeriodLock.cancel', 'Cancel')}
                              </Button>
                            </form>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="tm-fin-col">
            <section className="tm-card" aria-labelledby="tm-fin-close-heading">
              <h2 id="tm-fin-close-heading" className="tm-fin-card-title">
                {tOr('PeriodLock.closeTitle', 'Close a month')}
              </h2>
              <p className="tm-fin-muted">
                {tOr(
                  'PeriodLock.closeBody',
                  'Time, expenses and invoices dated in it can no longer change.',
                )}
              </p>
              <form className="tm-stack tm-stack--tight" onSubmit={submitClose}>
                <Field
                  type="month"
                  label={tOr('PeriodLock.monthLabel', 'Month')}
                  value={month}
                  required
                  error={monthError ?? undefined}
                  onChange={(event) => setMonth(event.target.value)}
                />
                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    loading={close.isPending}
                    loadingLabel={tOr('PeriodLock.saving', 'Saving')}
                  >
                    {tOr('PeriodLock.closeAction', 'Close month')}
                  </Button>
                </div>
              </form>
              {close.isError ? (
                <InlineAlert tone="danger" live>
                  {describe(close.error)}
                </InlineAlert>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
