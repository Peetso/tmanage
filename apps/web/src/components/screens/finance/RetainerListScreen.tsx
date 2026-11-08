'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import { listClientOrganizations } from '../../../lib/api/clients';
import { readFinanceProfile } from '../../../lib/api/finance-core';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import { minutesAsHours } from './InvoiceRules';
import { listRetainerPeriods, listRetainers, transitionRetainer } from './RetainerApi';
import { RetainerForm } from './RetainerForm';
import type { RetainerRow } from './RetainerApi';
import '../../../styles/screens/finance-ledger.css';

export interface RetainerListScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const STATE_WORDS: Record<string, readonly [string, string, CapsuleState]> = {
  active: ['RetainerList.stateActive', 'Active', 'current'],
  paused: ['RetainerList.statePaused', 'Paused', 'waiting'],
  ended: ['RetainerList.stateEnded', 'Ended', 'archived'],
};

const PERIOD_WORDS: Record<string, readonly [string, string]> = {
  monthly: ['RetainerList.periodMonthly', 'Monthly'],
  quarterly: ['RetainerList.periodQuarterly', 'Quarterly'],
};

/**
 * **Retainers** — a client company's retainers and the selected one's periods (A10b). Retainers are
 * listed per client (`GET …/client-organizations/:id/retainers`, `work.read`), so the screen asks for
 * the company first. Pause and resume are `finance.manage`; the API refuses anyone else and the
 * refusal is shown as a sentence. The amount shows only when the API sends it (`finance.view`).
 * New retainer and Edit open the retainer form (R35 L6-52-09, `finance.manage`).
 */
export function RetainerListScreen({
  organizationSlug,
  organizationName,
  client,
}: RetainerListScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(null);
  /** The open form: `{ retainer: null }` writes a new one, a row edits it. */
  const [form, setForm] = useState<{ readonly retainer: RetainerRow | null } | null>(null);

  const clients = useQuery({
    queryKey: ['finance-client-names', organizationSlug],
    queryFn: () => listClientOrganizations(api, organizationSlug),
    retry: false,
  });
  const activeClients = (clients.data ?? []).filter((entry) => entry.archivedAt === null);
  const chosen = clientId || activeClients[0]?.id || '';

  const retainers = useQuery({
    queryKey: ['retainers', organizationSlug, chosen],
    queryFn: () => listRetainers(api, organizationSlug, chosen),
    enabled: chosen !== '',
  });
  const periods = useQuery({
    queryKey: ['retainer-periods', organizationSlug, selected],
    queryFn: () => listRetainerPeriods(api, organizationSlug, selected as string),
    enabled: selected !== null,
  });
  const transition = useMutation({
    mutationFn: (input: { id: string; event: 'pause' | 'resume' }) =>
      transitionRetainer(api, organizationSlug, input.id, input.event),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['retainers', organizationSlug, chosen] }),
  });

  const profile = useQuery({
    queryKey: ['finance-profile', organizationSlug],
    queryFn: () => readFinanceProfile(api, organizationSlug),
    retry: false,
  });

  const rows = retainers.data ?? [];
  const baseCurrency =
    rows.find((row) => row.currency)?.currency ?? profile.data?.baseCurrency ?? 'SAR';
  const selectedRow = rows.find((row) => row.id === selected) ?? null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('FinanceIndex.eyebrow', 'Finance')}
      title={tOr('RetainerList.title', 'Retainers')}
      actions={
        chosen !== '' && form === null ? (
          <Button type="button" tone="ink" onClick={() => setForm({ retainer: null })}>
            {tOr('RetainerForm.newTitle', 'New retainer')}
          </Button>
        ) : undefined
      }
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="retainers" />

        {clients.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('RetainerList.clientsError', 'Clients could not load')}
          >
            {describe(clients.error)}
          </InlineAlert>
        ) : null}

        {clients.isSuccess && activeClients.length === 0 ? (
          <InlineAlert tone="neutral" title={tOr('RetainerList.noClientsTitle', 'No clients yet')}>
            {tOr(
              'RetainerList.noClientsBody',
              'Add a client company first, then set up its retainer.',
            )}
          </InlineAlert>
        ) : null}

        {activeClients.length > 0 ? (
          <div className="tm-fin-form">
            <Select
              label={tOr('RetainerList.clientLabel', 'Client')}
              value={chosen}
              onChange={(event) => {
                setClientId(event.target.value);
                setSelected(null);
                setForm(null);
              }}
            >
              {activeClients.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {form !== null && chosen !== '' ? (
          <RetainerForm
            key={form.retainer?.id ?? 'new'}
            api={api}
            organizationSlug={organizationSlug}
            clientOrganizationId={chosen}
            retainer={form.retainer}
            currency={baseCurrency}
            onDone={(saved) => {
              setForm(null);
              if (saved) {
                setSelected(saved.id);
                void queryClient.invalidateQueries({
                  queryKey: ['retainers', organizationSlug, chosen],
                });
              }
            }}
          />
        ) : null}

        {retainers.isPending && chosen !== '' ? (
          <LoadingRegion
            label={tOr('RetainerList.loading', 'Loading retainers')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {retainers.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('RetainerList.errorTitle', 'Retainers could not load')}
            live
          >
            {describe(retainers.error)}
          </InlineAlert>
        ) : null}

        {transition.isError ? (
          <InlineAlert tone="danger" live>
            {describe(transition.error)}
          </InlineAlert>
        ) : null}

        {retainers.isSuccess && rows.length === 0 ? (
          <div className="tm-card tm-card--empty">
            <InlineAlert
              tone="neutral"
              title={tOr('RetainerList.emptyTitle', 'No retainers for this client')}
            >
              {tOr(
                'RetainerList.emptyBody',
                'A retainer sets the hours a client buys each period and tracks what is used.',
              )}
            </InlineAlert>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="tm-fin">
            <div className="tm-fin-table-card">
              <table className="tm-table">
                <thead>
                  <tr>
                    <th scope="col">{tOr('RetainerList.colName', 'Retainer')}</th>
                    <th scope="col">{tOr('RetainerList.colPeriod', 'Period')}</th>
                    <th scope="col" className="tm-fin-num">
                      {tOr('RetainerList.colHours', 'Hours')}
                    </th>
                    <th scope="col" className="tm-fin-num">
                      {tOr('RetainerList.colAmount', 'Amount')}
                    </th>
                    <th scope="col">{tOr('RetainerList.colStarts', 'Starts')}</th>
                    <th scope="col">{tOr('RetainerList.colState', 'State')}</th>
                    <th scope="col">
                      <span className="tm-visually-hidden">
                        {tOr('RetainerList.colActions', 'Actions')}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Button
                          type="button"
                          tone="text"
                          size="compact"
                          aria-pressed={row.id === selected}
                          onClick={() => setSelected(row.id)}
                        >
                          {row.name}
                        </Button>
                      </td>
                      <td>{tOr(...(PERIOD_WORDS[row.period] ?? PERIOD_WORDS['monthly']!))}</td>
                      <td className="tm-mono tm-fin-num">{row.hoursPerPeriod ?? '—'}</td>
                      <td className="tm-mono tm-fin-num">
                        {row.amountPerPeriodMinor != null && row.currency
                          ? money(row.amountPerPeriodMinor, row.currency)
                          : '—'}
                      </td>
                      <td>{day(row.startsOn)}</td>
                      <td>
                        <RetainerState row={row} />
                      </td>
                      <td className="tm-fin-num">
                        {row.state !== 'ended' ? (
                          <Button
                            type="button"
                            tone="text"
                            size="compact"
                            onClick={() => setForm({ retainer: row })}
                          >
                            {tOr('RetainerForm.edit', 'Edit')}
                          </Button>
                        ) : null}
                        {row.state === 'active' || row.state === 'paused' ? (
                          <Button
                            type="button"
                            tone="outline"
                            size="compact"
                            loading={transition.isPending && transition.variables?.id === row.id}
                            loadingLabel={tOr('RetainerList.saving', 'Saving')}
                            onClick={() =>
                              transition.mutate({
                                id: row.id,
                                event: row.state === 'active' ? 'pause' : 'resume',
                              })
                            }
                          >
                            {row.state === 'active'
                              ? tOr('RetainerList.pause', 'Pause')
                              : tOr('RetainerList.resume', 'Resume')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="tm-fin-col">
              <section className="tm-card" aria-labelledby="tm-fin-periods-heading">
                <h2 id="tm-fin-periods-heading" className="tm-fin-card-title">
                  {selectedRow?.name ?? tOr('RetainerList.periodsTitle', 'Periods')}
                </h2>
                {selected === null ? (
                  <p className="tm-fin-muted">
                    {tOr('RetainerList.pickRetainer', 'Choose a retainer to see its periods.')}
                  </p>
                ) : null}
                {periods.isError ? <p className="tm-fin-muted">{describe(periods.error)}</p> : null}
                {periods.data && periods.data.length === 0 ? (
                  <p className="tm-fin-muted">{tOr('RetainerList.noPeriods', 'No periods yet.')}</p>
                ) : null}
                {periods.data && periods.data.length > 0 ? (
                  <dl className="tm-fin-buckets">
                    {periods.data.map((period) => (
                      <div key={period.id}>
                        <dt>
                          {day(period.periodStart)} – {day(period.periodEnd)}
                          {period.locked ? ` · ${tOr('RetainerList.locked', 'Closed')}` : ''}
                        </dt>
                        <dd>
                          {minutesAsHours(period.usedMinutes)} /{' '}
                          {minutesAsHours(period.allowanceMinutes + period.rolloverInMinutes)}{' '}
                          {tOr('RetainerList.hoursUnit', 'h')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function RetainerState({ row }: { row: RetainerRow }) {
  const tOr = useTOr();
  const [key, english, state] = STATE_WORDS[row.state] ?? STATE_WORDS['active']!;
  return <StateCapsule state={state}>{tOr(key, english)}</StateCapsule>;
}
