'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createBillingDiscount,
  deleteBillingDiscount,
  listBillingDiscounts,
  type BillingDiscountView,
} from '../../lib/api/billing-discounts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import '../../styles/screens/billing.css';

export interface BillingDiscountsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

type DiscountKind = 'percent' | 'fixed';

/**
 * **Billing discounts (Billing & plan management, module 19, x330).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing & plan management (adjustments). This screen owns
 * the organization's discount / adjustment register — each record a label, a kind (a percentage off or a
 * fixed amount off), an amount, and an optional expiry — and shows whether each record is active or
 * expired. It is disjoint from the billing profile, contacts, credits and usage-alerts screens.
 *
 * The reads and writes are gated on the server by `org.manage` — owners only — so a member who opens
 * this screen sees the API's 403 rather than a blank page. This is bookkeeping only: recording a
 * discount stores a row, it moves no money and settles no charge (applying it to a real charge is
 * Needs-Peter), and a discount is created and removed, never edited — a change is a delete-and-recreate.
 */
export function BillingDiscountsScreen({
  organizationSlug,
  organizationName,
  client,
}: BillingDiscountsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tOr = useTOr();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

  const discounts = useQuery({
    queryKey: ['billing-discounts', organizationSlug],
    queryFn: () => listBillingDiscounts(api, organizationSlug),
  });

  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<DiscountKind>('percent');
  const [amount, setAmount] = useState('');
  const [expiresOn, setExpiresOn] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['billing-discounts', organizationSlug] });

  const amountValue = toAmount(kind, amount);

  const create = useMutation({
    mutationFn: () =>
      createBillingDiscount(api, organizationSlug, {
        label: label.trim(),
        kind,
        amount: amountValue ?? 0,
        expiresOn: expiresOn.trim() === '' ? null : expiresOn,
      }),
    onSuccess: async () => {
      setLabel('');
      setAmount('');
      setExpiresOn('');
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBillingDiscount(api, organizationSlug, id),
    onSuccess: async () => invalidate(),
  });

  const rows = discounts.data?.discounts ?? [];
  const canCreate = label.trim() !== '' && amountValue !== null && !create.isPending;

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('BillingDiscountsScreen.eyebrow')}
      title={t('BillingDiscountsScreen.title')}
      description={t('BillingDiscountsScreen.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-discount-add-heading">
          <h2 id="tm-discount-add-heading" className="tm-eyebrow">
            {t('BillingDiscountsScreen.recordHeading')}
          </h2>
          <form
            ref={firstStep}
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canCreate) create.mutate();
            }}
          >
            <Field
              label={t('BillingDiscountsScreen.labelLabel')}
              name="label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              hint={t('BillingDiscountsScreen.labelHint')}
              required
            />
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-discount-kind">
                {t('BillingDiscountsScreen.kindLabel')}
              </label>
              <select
                id="tm-discount-kind"
                className="tm-field__control"
                value={kind}
                onChange={(event) => setKind(event.target.value === 'fixed' ? 'fixed' : 'percent')}
              >
                <option value="percent">{t('BillingDiscountsScreen.kindPercent')}</option>
                <option value="fixed">{t('BillingDiscountsScreen.kindFixed')}</option>
              </select>
            </div>
            <Field
              label={
                kind === 'percent'
                  ? t('BillingDiscountsScreen.percentage')
                  : t('BillingDiscountsScreen.amount')
              }
              name="amount"
              type="number"
              step={kind === 'percent' ? '1' : '0.01'}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              hint={
                kind === 'percent'
                  ? t('BillingDiscountsScreen.percentHint')
                  : t('BillingDiscountsScreen.amountHint')
              }
              required
            />
            <Field
              label={t('BillingDiscountsScreen.expiresLabel')}
              name="expiresOn"
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
              hint={t('BillingDiscountsScreen.expiresHint')}
            />

            {create.isError ? (
              <InlineAlert tone="danger" title={t('BillingDiscountsScreen.errorRecordTitle')} live>
                {describeError(t, create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel={t('BillingDiscountsScreen.recording')}
                disabled={!canCreate}
              >
                {t('BillingDiscountsScreen.recordButton')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-discount-list-heading"
        >
          <h2 id="tm-discount-list-heading" className="tm-eyebrow">
            {t('BillingDiscountsScreen.discountsHeading')}{' '}
            {discounts.isSuccess ? `(${rows.length})` : ''}
          </h2>

          {discounts.isError ? (
            <InlineAlert tone="danger" title={t('BillingDiscountsScreen.errorLoadTitle')} live>
              {describeError(t, discounts.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title={t('BillingDiscountsScreen.errorRemoveTitle')} live>
              {describeError(t, remove.error)}
            </InlineAlert>
          ) : null}

          {discounts.isPending ? (
            <LoadingRegion label={t('BillingDiscountsScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {discounts.isSuccess && rows.length === 0 ? (
            <TeachingEmptyState
              title={t('BillingDiscountsScreen.emptyTitle')}
              explanation={tOr(
                'teachEmpty.billingDiscountsBody',
                'Record a discount, a percentage or a fixed amount with an end date if it has one, and see which ones are still active.',
              )}
              action={
                canUse('billing.manage') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {tOr('teachEmpty.billingDiscountsAction', 'Add a discount')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                {t('BillingDiscountsScreen.caption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('BillingDiscountsScreen.colLabel')}</th>
                  <th scope="col">{t('BillingDiscountsScreen.colAmount')}</th>
                  <th scope="col">{t('BillingDiscountsScreen.colExpires')}</th>
                  <th scope="col">{t('BillingDiscountsScreen.colStatus')}</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">
                      {t('BillingDiscountsScreen.actionsColumn')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((discount) => (
                  <tr key={discount.id}>
                    <td>{discount.label}</td>
                    <td>{formatAmount(discount)}</td>
                    <td>{discount.expiresOn ?? t('BillingDiscountsScreen.never')}</td>
                    <td>
                      {discount.active
                        ? t('BillingDiscountsScreen.active')
                        : t('BillingDiscountsScreen.expired')}
                    </td>
                    <td>
                      <Button
                        type="button"
                        tone="text"
                        size="compact"
                        loading={remove.isPending && remove.variables === discount.id}
                        loadingLabel={t('BillingDiscountsScreen.removing')}
                        onClick={() => remove.mutate(discount.id)}
                      >
                        {t('BillingDiscountsScreen.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </SettingsShell>
  );
}

/** Parse the amount field into the integer the API expects for the chosen kind, or null when invalid. */
function toAmount(kind: DiscountKind, raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (kind === 'percent') {
    if (!Number.isInteger(value) || value < 0 || value > 100) return null;
    return value;
  }
  const minor = Math.round(value * 100);
  return minor < 0 ? null : minor;
}

/** Render a discount's magnitude — a percentage, or a currency amount (two decimals, no symbol). */
function formatAmount(discount: BillingDiscountView): string {
  return discount.kind === 'percent' ? `${discount.amount}%` : (discount.amount / 100).toFixed(2);
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('BillingDiscountsScreen.errorApiUnreachable');
  return t('BillingDiscountsScreen.errorGeneric');
}
