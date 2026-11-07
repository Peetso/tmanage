'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import {
  readFinanceProfile,
  saveFinanceProfile,
  type FinanceProfile,
} from '../../../lib/api/finance-core';
import { EXPENSE_CURRENCIES } from '../../../lib/finance-presentation';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceCoreNav, useFinanceMe } from './FinanceCoreNav';

export interface FinanceProfileScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

interface Draft {
  legalNameEn: string;
  legalNameAr: string;
  country: string;
  baseCurrency: string;
  taxScheme: string;
  vatRegistrationStatus: string;
  taxRegistrationNo: string;
  taxRatePercent: string;
  invoicePrefix: string;
  paymentTermsDays: string;
  addressEn: string;
  addressAr: string;
}

function draftOf(profile: FinanceProfile): Draft {
  return {
    legalNameEn: profile.legalNameEn ?? '',
    legalNameAr: profile.legalNameAr ?? '',
    country: profile.country,
    baseCurrency: profile.baseCurrency,
    taxScheme: profile.taxScheme,
    vatRegistrationStatus: profile.vatRegistrationStatus,
    taxRegistrationNo: profile.taxRegistrationNo ?? '',
    taxRatePercent: String(profile.defaultTaxRateBp / 100),
    invoicePrefix: profile.invoicePrefix,
    paymentTermsDays: String(profile.paymentTermsDays),
    addressEn: profile.addressEn ?? '',
    addressAr: profile.addressAr ?? '',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * **Finance profile (A10a).** The organization's legal names, tax registration, base currency,
 * invoice numbering prefix and payment terms. Everyone with `finance.view` reads it; the fields
 * are editable only with `finance.manage` (the API refuses the save otherwise). The save sends the
 * version it read, so an edit made elsewhere answers "changed elsewhere" instead of overwriting.
 */
export function FinanceProfileScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceProfileScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const { can } = useFinanceMe(api, organizationSlug);
  const editable = can('finance.manage');
  const queryKey = ['finance-profile', organizationSlug];
  const profile = useQuery({ queryKey, queryFn: () => readFinanceProfile(api, organizationSlug) });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (profile.data) setDraft(draftOf(profile.data));
  }, [profile.data]);

  const taxRateBp = draft ? Math.round(Number(draft.taxRatePercent) * 100) : NaN;
  const terms = draft ? Number(draft.paymentTermsDays) : NaN;
  const valid =
    draft !== null &&
    /^[A-Z]{2}$/u.test(draft.country) &&
    Number.isInteger(taxRateBp) &&
    taxRateBp >= 0 &&
    taxRateBp <= 10_000 &&
    Number.isInteger(terms) &&
    terms >= 0 &&
    terms <= 365 &&
    draft.invoicePrefix.trim() !== '';

  const save = useMutation({
    mutationFn: () => {
      const d = draft as Draft;
      return saveFinanceProfile(api, organizationSlug, {
        version: profile.data?.version,
        legalNameEn: orNull(d.legalNameEn),
        legalNameAr: orNull(d.legalNameAr),
        country: d.country,
        baseCurrency: d.baseCurrency,
        taxScheme: d.taxScheme,
        vatRegistrationStatus: d.vatRegistrationStatus,
        taxRegistrationNo: orNull(d.taxRegistrationNo),
        defaultTaxRateBp: taxRateBp,
        invoicePrefix: d.invoicePrefix.trim(),
        paymentTermsDays: terms,
        addressEn: orNull(d.addressEn),
        addressAr: orNull(d.addressAr),
      });
    },
    onSuccess: (saved) => queryClient.setQueryData(queryKey, saved),
  });

  const set = (key: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((current) => (current ? { ...current, [key]: event.target.value } : current));

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceCore.eyebrow', 'Finance')}
      title={tOr('FinanceProfile.title', 'Finance profile')}
      description={tOr(
        'FinanceProfile.description',
        'The legal and tax details printed on your invoices.',
      )}
    >
      <div className="tm-stack">
        <FinanceCoreNav organizationSlug={organizationSlug} active="profile" />

        {profile.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('FinanceProfile.loadError', 'The finance profile could not be loaded')}
            live
          >
            {describeError(profile.error)}
          </InlineAlert>
        ) : null}
        {profile.isPending ? (
          <LoadingRegion label={tOr('FinanceProfile.loading', 'Loading the finance profile')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {profile.data && !profile.data.saved ? (
          <InlineAlert
            tone="neutral"
            title={tOr('FinanceProfile.unsavedTitle', 'Finance profile not set up yet')}
          >
            {tOr(
              'FinanceProfile.unsavedBody',
              'These are the defaults for your country. Review them and save before you invoice.',
            )}
          </InlineAlert>
        ) : null}

        {draft ? (
          <form
            className="tm-panel tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (editable && valid) save.mutate();
            }}
          >
            <fieldset className="tm-stack" disabled={!editable}>
              <legend className="tm-eyebrow">{tOr('FinanceProfile.company', 'Company')}</legend>
              <div className="tm-row tm-row--wrap">
                <Field
                  label={tOr('FinanceProfile.legalNameEn', 'Legal name (English)')}
                  value={draft.legalNameEn}
                  maxLength={200}
                  onChange={set('legalNameEn')}
                />
                <Field
                  label={tOr('FinanceProfile.legalNameAr', 'Legal name (Arabic)')}
                  value={draft.legalNameAr}
                  dir="rtl"
                  maxLength={200}
                  onChange={set('legalNameAr')}
                />
                <Field
                  label={tOr('FinanceProfile.country', 'Country code')}
                  value={draft.country}
                  maxLength={2}
                  hint={tOr('FinanceProfile.countryHint', 'Two letters, for example SA or AE.')}
                  onChange={(event) =>
                    setDraft({ ...draft, country: event.target.value.toUpperCase() })
                  }
                />
              </div>
              <div className="tm-row tm-row--wrap">
                <Field
                  label={tOr('FinanceProfile.addressEn', 'Address (English)')}
                  value={draft.addressEn}
                  maxLength={500}
                  onChange={set('addressEn')}
                />
                <Field
                  label={tOr('FinanceProfile.addressAr', 'Address (Arabic)')}
                  value={draft.addressAr}
                  dir="rtl"
                  maxLength={500}
                  onChange={set('addressAr')}
                />
              </div>
            </fieldset>

            <fieldset className="tm-stack" disabled={!editable}>
              <legend className="tm-eyebrow">
                {tOr('FinanceProfile.tax', 'Tax and currency')}
              </legend>
              <div className="tm-row tm-row--wrap">
                <Select
                  label={tOr('FinanceProfile.baseCurrency', 'Base currency')}
                  value={draft.baseCurrency}
                  onChange={set('baseCurrency')}
                >
                  {EXPENSE_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
                <Select
                  label={tOr('FinanceProfile.taxScheme', 'Tax scheme')}
                  value={draft.taxScheme}
                  onChange={set('taxScheme')}
                >
                  <option value="VAT">VAT</option>
                  <option value="GST">GST</option>
                  <option value="NONE">{tOr('FinanceProfile.taxNone', 'No tax')}</option>
                </Select>
                <Select
                  label={tOr('FinanceProfile.vatStatus', 'VAT registration')}
                  value={draft.vatRegistrationStatus}
                  onChange={set('vatRegistrationStatus')}
                >
                  <option value="registered">
                    {tOr('FinanceProfile.vatRegistered', 'Registered')}
                  </option>
                  <option value="not_registered">
                    {tOr('FinanceProfile.vatNotRegistered', 'Not registered')}
                  </option>
                </Select>
              </div>
              <div className="tm-row tm-row--wrap">
                <Field
                  label={tOr('FinanceProfile.taxNumber', 'Tax registration number')}
                  value={draft.taxRegistrationNo}
                  maxLength={32}
                  onChange={set('taxRegistrationNo')}
                />
                <Field
                  label={tOr('FinanceProfile.taxRate', 'Default tax rate (%)')}
                  inputMode="decimal"
                  value={draft.taxRatePercent}
                  onChange={set('taxRatePercent')}
                />
              </div>
            </fieldset>

            <fieldset className="tm-stack" disabled={!editable}>
              <legend className="tm-eyebrow">{tOr('FinanceProfile.invoicing', 'Invoicing')}</legend>
              <div className="tm-row tm-row--wrap">
                <Field
                  label={tOr('FinanceProfile.invoicePrefix', 'Invoice number prefix')}
                  value={draft.invoicePrefix}
                  maxLength={16}
                  onChange={set('invoicePrefix')}
                />
                <Field
                  label={tOr('FinanceProfile.paymentTerms', 'Payment terms (days)')}
                  type="number"
                  min={0}
                  max={365}
                  value={draft.paymentTermsDays}
                  onChange={set('paymentTermsDays')}
                />
              </div>
            </fieldset>

            {save.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceProfile.saveError', 'The finance profile was not saved')}
                live
              >
                {describeError(save.error)}
              </InlineAlert>
            ) : null}
            {save.isSuccess ? (
              <InlineAlert tone="success" title={tOr('FinanceProfile.saved', 'Saved')} live>
                {tOr('FinanceProfile.savedBody', 'Your finance profile is up to date.')}
              </InlineAlert>
            ) : null}
            {editable ? (
              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  disabled={!valid || save.isPending}
                  loading={save.isPending}
                >
                  {tOr('FinanceProfile.save', 'Save profile')}
                </Button>
              </div>
            ) : (
              <p className="tm-field__hint">
                {tOr('FinanceProfile.readOnly', 'Only finance managers can change these details.')}
              </p>
            )}
          </form>
        ) : null}
      </div>
    </AppShell>
  );
}
