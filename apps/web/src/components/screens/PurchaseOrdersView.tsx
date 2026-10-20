'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import {
  closePurchaseOrder,
  createPurchaseOrder,
  deletePurchaseOrder,
  listPurchaseOrders,
} from '../../lib/api/purchase-orders';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface PurchaseOrdersViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Render an integer minor amount and a currency as a plain figure, or a dash when absent. */
function formatAmount(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null) return '—';
  const major = (amountMinor / 100).toFixed(2);
  return currency ? `${major} ${currency}` : major;
}

/**
 * **Billing & entitlements (module 19, x282).**
 *
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §Billing; `22-SCREEN` §Billing profile. This screen owns
 * the org-scoped purchase-order (PO) references a billing admin records so a later invoice can cite
 * one: a PO number, an optional amount and currency, and an optional note. It records a PO, lists the
 * organization's POs with their open/closed status, and closes a PO. Every route is gated on the server
 * by `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **Nothing is charged here.** A PO reference is a record; there is no card or bank field, and
 *   nothing here transfers money. Invoices citing a PO are a later concern.
 */
export function PurchaseOrdersView({
  organizationSlug,
  organizationName,
  client,
}: PurchaseOrdersViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const purchaseOrders = useQuery({
    queryKey: ['purchase-orders', organizationSlug],
    queryFn: () => listPurchaseOrders(api, organizationSlug),
  });

  const [poNumber, setPoNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [note, setNote] = useState('');

  const rows = purchaseOrders.data ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['purchase-orders', organizationSlug] });

  const create = useMutation({
    mutationFn: () => {
      const trimmedCurrency = currency.trim();
      const trimmedNote = note.trim();
      return createPurchaseOrder(api, organizationSlug, {
        poNumber: poNumber.trim(),
        ...(amount.trim() === '' ? {} : { amount: Number(amount) }),
        ...(trimmedCurrency === '' ? {} : { currency: trimmedCurrency }),
        ...(trimmedNote === '' ? {} : { note: trimmedNote }),
      });
    },
    onSuccess: async () => {
      setPoNumber('');
      setAmount('');
      setCurrency('');
      setNote('');
      await invalidate();
    },
  });

  const close = useMutation({
    mutationFn: (id: string) => closePurchaseOrder(api, organizationSlug, id),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deletePurchaseOrder(api, organizationSlug, id),
    onSuccess: () => invalidate(),
  });

  const amountValue = amount.trim() === '' ? 0 : Number(amount);
  const amountValid = amount.trim() === '' || (Number.isInteger(amountValue) && amountValue >= 0);
  const canCreate = poNumber.trim() !== '' && amountValid && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('PurchaseOrdersView.eyebrow')}
      title={t('PurchaseOrdersView.title')}
      description={t('PurchaseOrdersView.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-po-new-heading">
          <h2 id="tm-po-new-heading" className="tm-eyebrow">
            {t('PurchaseOrdersView.newPurchaseOrder')}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canCreate) create.mutate();
            }}
          >
            <Field
              label={t('PurchaseOrdersView.poNumberLabel')}
              name="poNumber"
              value={poNumber}
              onChange={(event) => setPoNumber(event.target.value)}
              hint={t('PurchaseOrdersView.poNumberHint')}
              required
            />
            <Field
              label={t('PurchaseOrdersView.amountLabel')}
              name="amount"
              type="number"
              min={0}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              hint={t('PurchaseOrdersView.amountHint')}
            />
            <Field
              label={t('PurchaseOrdersView.currencyLabel')}
              name="currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              hint={t('PurchaseOrdersView.currencyHint')}
            />
            <Field
              label={t('PurchaseOrdersView.noteLabel')}
              name="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              hint={t('PurchaseOrdersView.noteHint')}
            />

            {create.isError ? (
              <InlineAlert tone="danger" title={t('PurchaseOrdersView.recordFailed')} live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel={t('PurchaseOrdersView.recording')}
                disabled={!canCreate}
              >
                {t('PurchaseOrdersView.recordPurchaseOrder')}
              </Button>
            </div>
          </form>
        </section>

        <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-po-list-heading">
          <h2 id="tm-po-list-heading" className="tm-eyebrow">
            {t('PurchaseOrdersView.purchaseOrders')}
          </h2>

          {purchaseOrders.isError ? (
            <InlineAlert tone="danger" title={t('PurchaseOrdersView.loadFailed')} live>
              {describeError(purchaseOrders.error)}
            </InlineAlert>
          ) : null}

          {close.isError || remove.isError ? (
            <InlineAlert tone="danger" title={t('PurchaseOrdersView.updateFailed')} live>
              {describeError(close.error ?? remove.error)}
            </InlineAlert>
          ) : null}

          {purchaseOrders.isPending ? (
            <LoadingRegion label={t('PurchaseOrdersView.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!purchaseOrders.isPending && !purchaseOrders.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('PurchaseOrdersView.emptyTitle')}>
              {t('PurchaseOrdersView.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <div
              className="tm-table-scroll"
              // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
              // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label={t('PurchaseOrdersView.purchaseOrders')}
            >
              <table className="tm-table">
                <caption className="tm-visually-hidden">
                  {t('PurchaseOrdersView.captionPrefix')}
                  {rows.length}
                  {t('PurchaseOrdersView.captionSuffix')}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('PurchaseOrdersView.colNumber')}</th>
                    <th scope="col">{t('PurchaseOrdersView.colAmount')}</th>
                    <th scope="col">{t('PurchaseOrdersView.colStatus')}</th>
                    <th scope="col">{t('PurchaseOrdersView.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((po) => (
                    <tr key={po.id}>
                      <th scope="row" className="tm-table__title">
                        {po.poNumber}
                      </th>
                      <td>{formatAmount(po.amountMinor, po.currency)}</td>
                      <td>
                        {po.status === 'closed'
                          ? t('PurchaseOrdersView.statusClosed')
                          : t('PurchaseOrdersView.statusOpen')}
                      </td>
                      <td>
                        <div className="tm-row">
                          {po.status === 'open' ? (
                            <Button
                              type="button"
                              tone="ink"
                              size="compact"
                              loading={close.isPending && close.variables === po.id}
                              loadingLabel={t('PurchaseOrdersView.closing')}
                              onClick={() => close.mutate(po.id)}
                            >
                              {t('PurchaseOrdersView.close')}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            tone="outline"
                            size="compact"
                            loading={remove.isPending && remove.variables === po.id}
                            loadingLabel={t('PurchaseOrdersView.removing')}
                            onClick={() => remove.mutate(po.id)}
                          >
                            {t('PurchaseOrdersView.remove')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
