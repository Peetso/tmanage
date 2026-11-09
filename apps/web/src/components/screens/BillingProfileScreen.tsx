'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  fetchBillingProfile,
  updateBillingProfile,
  type BillingProfileView,
} from '../../lib/api/billing';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/billing.css';

export interface BillingProfileScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

interface FormState {
  billingEmail: string;
  companyName: string;
  taxId: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

const EMPTY_FORM: FormState = {
  billingEmail: '',
  companyName: '',
  taxId: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
};

function toForm(profile: BillingProfileView): FormState {
  return {
    billingEmail: profile.billingEmail ?? '',
    companyName: profile.companyName ?? '',
    taxId: profile.taxId ?? '',
    line1: profile.address.line1 ?? '',
    line2: profile.address.line2 ?? '',
    city: profile.address.city ?? '',
    region: profile.address.region ?? '',
    postalCode: profile.address.postalCode ?? '',
    country: profile.address.country ?? '',
  };
}

/**
 * **Billing settings (module 19, x180).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing ("billing settings") — the billing-contact,
 * company, tax-id and address a studio keeps for its invoices. It reads
 * `GET /v1/organizations/:orgSlug/billing/profile` and saves through the paired `PUT`, both gated on
 * `org.manage`, so a member without it gets the API's 403 rather than a blank page.
 *
 * ## What it does not have
 *
 * - **No rail item.** `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations and
 *   billing is not among them, so — like the storage-usage screen — none is invented; it has its own
 *   route and is reached from there.
 * - **No card or bank fields, deliberately.** Payment instruments are held by the payment provider,
 *   never here (`04-SECURITY-PRIVACY` §4); this form captures billing *metadata* only, and the API
 *   rejects any card/PAN-shaped value into these fields.
 */
export function BillingProfileScreen({
  organizationSlug,
  organizationName,
  client,
}: BillingProfileScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const profile = useQuery({
    queryKey: ['billing-profile', organizationSlug],
    queryFn: () => fetchBillingProfile(api, organizationSlug),
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saved, setSaved] = useState(false);

  // Seed the form from the loaded profile once it arrives. Keyed on `dataUpdatedAt` so a refetch
  // after a save re-seeds from the server's canonical values.
  useEffect(() => {
    if (profile.data) setForm(toForm(profile.data));
  }, [profile.data]);

  const save = useMutation({
    mutationFn: () =>
      updateBillingProfile(api, organizationSlug, {
        billingEmail: form.billingEmail.trim() === '' ? null : form.billingEmail.trim(),
        companyName: form.companyName.trim() === '' ? null : form.companyName.trim(),
        taxId: form.taxId.trim() === '' ? null : form.taxId.trim(),
        address: {
          line1: form.line1.trim() === '' ? null : form.line1.trim(),
          line2: form.line2.trim() === '' ? null : form.line2.trim(),
          city: form.city.trim() === '' ? null : form.city.trim(),
          region: form.region.trim() === '' ? null : form.region.trim(),
          postalCode: form.postalCode.trim() === '' ? null : form.postalCode.trim(),
          country: form.country.trim() === '' ? null : form.country.trim(),
        },
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['billing-profile', organizationSlug] });
    },
  });

  const set = (patch: Partial<FormState>) => {
    setSaved(false);
    setForm((current) => ({ ...current, ...patch }));
  };

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('BillingProfileScreen.eyebrow')}
      title={t('BillingProfileScreen.title')}
      description={t('BillingProfileScreen.description')}
    >
      <div className="tm-bil">
        {profile.isError ? (
          <InlineAlert tone="danger" title={t('BillingProfileScreen.errorLoadTitle')} live>
            {describeError(t, profile.error)}
          </InlineAlert>
        ) : null}

        {profile.isPending ? (
          <LoadingRegion
            label={t('BillingProfileScreen.loadingLabel')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!profile.isPending && !profile.isError ? (
          <form
            className="tm-panel tm-stack"
            noValidate
            aria-label={t('BillingProfileScreen.formLabel')}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <section className="tm-stack" aria-labelledby="tm-billing-contact-heading">
              <h2 id="tm-billing-contact-heading" className="tm-eyebrow">
                {t('BillingProfileScreen.contactHeading')}
              </h2>
              <Field
                label={t('BillingProfileScreen.emailLabel')}
                name="billingEmail"
                type="email"
                value={form.billingEmail}
                onChange={(event) => set({ billingEmail: event.target.value })}
                hint={t('BillingProfileScreen.emailHint')}
              />
              <Field
                label={t('BillingProfileScreen.companyLabel')}
                name="companyName"
                value={form.companyName}
                onChange={(event) => set({ companyName: event.target.value })}
              />
              <Field
                label={t('BillingProfileScreen.taxIdLabel')}
                name="taxId"
                value={form.taxId}
                onChange={(event) => set({ taxId: event.target.value })}
                hint={t('BillingProfileScreen.taxIdHint')}
              />
            </section>

            <fieldset className="tm-stack tm-fieldset">
              <legend className="tm-field__label">{t('BillingProfileScreen.addressLegend')}</legend>
              <Field
                label={t('BillingProfileScreen.line1')}
                name="line1"
                value={form.line1}
                onChange={(event) => set({ line1: event.target.value })}
              />
              <Field
                label={t('BillingProfileScreen.line2')}
                name="line2"
                value={form.line2}
                onChange={(event) => set({ line2: event.target.value })}
              />
              <Field
                label={t('BillingProfileScreen.city')}
                name="city"
                value={form.city}
                onChange={(event) => set({ city: event.target.value })}
              />
              <Field
                label={t('BillingProfileScreen.region')}
                name="region"
                value={form.region}
                onChange={(event) => set({ region: event.target.value })}
              />
              <Field
                label={t('BillingProfileScreen.postalCode')}
                name="postalCode"
                value={form.postalCode}
                onChange={(event) => set({ postalCode: event.target.value })}
              />
              <Field
                label={t('BillingProfileScreen.country')}
                name="country"
                value={form.country}
                onChange={(event) => set({ country: event.target.value })}
                hint={t('BillingProfileScreen.countryHint')}
              />
            </fieldset>

            {save.isError ? (
              <InlineAlert tone="danger" title={t('BillingProfileScreen.errorSaveTitle')} live>
                {describeError(t, save.error)}
              </InlineAlert>
            ) : null}

            {saved && !save.isError ? (
              <InlineAlert tone="success" title={t('BillingProfileScreen.savedTitle')} live>
                {t('BillingProfileScreen.savedBody')}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={save.isPending}
                loadingLabel={t('BillingProfileScreen.saving')}
              >
                {t('BillingProfileScreen.saveButton')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </SettingsShell>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('BillingProfileScreen.errorApiUnreachable');
  return t('BillingProfileScreen.errorGeneric');
}
