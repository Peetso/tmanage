'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import {
  addRateEntry,
  createRateCard,
  listRateCards,
  listRateEntries,
  type RateCard,
} from '../../../lib/api/finance-core';
import { EXPENSE_CURRENCIES, parseAmountToMinor } from '../../../lib/finance-presentation';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceCoreNav, useFinanceMe } from './FinanceCoreNav';

export interface FinanceRatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Rate cards (A10a).** The organization's hourly rate cards and, for the open card, its default
 * hourly rate over time. Reading needs `finance.view`; creating a card or adding a rate needs
 * `finance.manage`, so those forms are shown only to a finance manager.
 */
export function FinanceRatesScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceRatesScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const format = useDisplayFormatters();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const { can } = useFinanceMe(api, organizationSlug);
  const editable = can('finance.manage');
  const cardsKey = ['finance-rate-cards', organizationSlug];
  const cards = useQuery({
    queryKey: cardsKey,
    queryFn: () => listRateCards(api, organizationSlug),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const open: RateCard | undefined =
    cards.data?.find((card) => card.id === openId) ?? cards.data?.[0];
  const entriesKey = ['finance-rate-entries', organizationSlug, open?.id];
  const entries = useQuery({
    queryKey: entriesKey,
    queryFn: () => listRateEntries(api, organizationSlug, open?.id ?? ''),
    enabled: open !== undefined,
  });

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<string>('SAR');
  const [hourly, setHourly] = useState('');
  const [from, setFrom] = useState('');
  const hourlyMinor = open ? parseAmountToMinor(hourly, open.currency) : null;

  const create = useMutation({
    mutationFn: () => createRateCard(api, organizationSlug, { name: name.trim(), currency }),
    onSuccess: async (card) => {
      setName('');
      setOpenId(card.id);
      await queryClient.invalidateQueries({ queryKey: cardsKey });
    },
  });
  const addEntry = useMutation({
    mutationFn: () =>
      addRateEntry(api, organizationSlug, open?.id ?? '', {
        hourlyMinor: hourlyMinor ?? 0,
        effectiveFrom: from,
      }),
    onSuccess: async () => {
      setHourly('');
      await queryClient.invalidateQueries({ queryKey: entriesKey });
    },
  });

  const list = cards.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceCore.eyebrow', 'Finance')}
      title={tOr('FinanceRates.title', 'Rate cards')}
      description={tOr(
        'FinanceRates.description',
        'The hourly rates your billable time is priced at.',
      )}
    >
      <div className="tm-stack">
        <FinanceCoreNav organizationSlug={organizationSlug} active="rates" />

        {cards.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('FinanceRates.loadError', 'Rate cards could not be loaded')}
            live
          >
            {describeError(cards.error)}
          </InlineAlert>
        ) : null}
        {cards.isPending ? (
          <LoadingRegion label={tOr('FinanceRates.loading', 'Loading rate cards')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {cards.isSuccess && list.length === 0 ? (
          <InlineAlert tone="neutral" title={tOr('FinanceRates.emptyTitle', 'No rate cards yet')}>
            {tOr(
              'FinanceRates.emptyBody',
              'Create a rate card to price billable time on invoices.',
            )}
          </InlineAlert>
        ) : null}

        {list.length > 0 ? (
          <section className="tm-panel tm-stack" aria-labelledby="tm-fr-cards">
            <h2 id="tm-fr-cards" className="tm-eyebrow">
              {tOr('FinanceRates.cards', 'Rate cards')}
            </h2>
            <ul className="tm-stack tm-list">
              {list.map((card) => (
                <li key={card.id} className="tm-row tm-row--between tm-list__item">
                  <span className="tm-row">
                    <strong>{card.name}</strong>
                    <Badge>{card.currency}</Badge>
                    {card.archived ? (
                      <Badge>{tOr('FinanceRates.archived', 'Archived')}</Badge>
                    ) : null}
                  </span>
                  <Button
                    size="compact"
                    tone={card.id === open?.id ? 'ink' : 'outline'}
                    aria-pressed={card.id === open?.id}
                    onClick={() => setOpenId(card.id)}
                  >
                    {tOr('FinanceRates.show', 'Show rates')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {open ? (
          <section className="tm-panel tm-stack" aria-labelledby="tm-fr-entries">
            <h2 id="tm-fr-entries" className="tm-eyebrow">
              {tOr('FinanceRates.entries', 'Hourly rates')} · {open.name}
            </h2>
            {entries.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceRates.entriesError', 'Rates could not be loaded')}
                live
              >
                {describeError(entries.error)}
              </InlineAlert>
            ) : null}
            {entries.isSuccess && entries.data.length === 0 ? (
              <p className="tm-field__hint">
                {tOr('FinanceRates.noEntries', 'This card has no rates yet.')}
              </p>
            ) : null}
            {entries.data && entries.data.length > 0 ? (
              <div className="tm-table-scroll">
                <table
                  className="tm-table"
                  aria-label={tOr('FinanceRates.entries', 'Hourly rates')}
                >
                  <thead>
                    <tr>
                      <th scope="col">{tOr('FinanceRates.appliesTo', 'Applies to')}</th>
                      <th scope="col">{tOr('FinanceRates.hourly', 'Per hour')}</th>
                      <th scope="col">{tOr('FinanceRates.from', 'From')}</th>
                      <th scope="col">{tOr('FinanceRates.to', 'Until')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.data.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          {entry.targetType === 'default'
                            ? tOr('FinanceRates.everyone', 'Everyone')
                            : tOr(`FinanceRates.target.${entry.targetType}`, entry.targetType)}
                        </td>
                        <td>{format.money(entry.hourlyMinor, open.currency)}</td>
                        <td>{format.day(entry.effectiveFrom)}</td>
                        <td>
                          {entry.effectiveTo
                            ? format.day(entry.effectiveTo)
                            : tOr('FinanceRates.open', 'Open')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {editable ? (
              <form
                className="tm-row tm-row--wrap"
                noValidate
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  if (hourlyMinor !== null && from !== '') addEntry.mutate();
                }}
              >
                <Field
                  label={`${tOr('FinanceRates.hourly', 'Per hour')} (${open.currency})`}
                  inputMode="decimal"
                  value={hourly}
                  onChange={(event) => setHourly(event.target.value)}
                />
                <Field
                  label={tOr('FinanceRates.from', 'From')}
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
                <Button
                  type="submit"
                  tone="ink"
                  disabled={hourlyMinor === null || from === '' || addEntry.isPending}
                  loading={addEntry.isPending}
                >
                  {tOr('FinanceRates.addRate', 'Add rate')}
                </Button>
              </form>
            ) : null}
            {addEntry.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceRates.addError', 'The rate was not added')}
                live
              >
                {describeError(addEntry.error)}
              </InlineAlert>
            ) : null}
          </section>
        ) : null}

        {editable ? (
          <section className="tm-panel tm-stack" aria-labelledby="tm-fr-new">
            <h2 id="tm-fr-new" className="tm-eyebrow">
              {tOr('FinanceRates.newCard', 'New rate card')}
            </h2>
            <form
              className="tm-row tm-row--wrap"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (name.trim() !== '') create.mutate();
              }}
            >
              <Field
                label={tOr('FinanceRates.name', 'Name')}
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
              <Select
                label={tOr('FinanceExpenses.currency', 'Currency')}
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {EXPENSE_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
              <Button
                type="submit"
                tone="ink"
                disabled={name.trim() === '' || create.isPending}
                loading={create.isPending}
              >
                {tOr('FinanceRates.create', 'Create card')}
              </Button>
            </form>
            {create.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceRates.createError', 'The rate card was not created')}
                live
              >
                {describeError(create.error)}
              </InlineAlert>
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
