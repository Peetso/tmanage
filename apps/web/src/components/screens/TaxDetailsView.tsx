'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  fetchTaxDetails,
  updateTaxDetails,
  type TaxDetailsView as TaxDetails,
} from '../../lib/api/billing-tax-details';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface TaxDetailsViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

interface FormState {
  legalName: string;
  taxId: string;
  registrationNo: string;
  taxCountry: string;
}

const EMPTY_FORM: FormState = {
  legalName: '',
  taxId: '',
  registrationNo: '',
  taxCountry: '',
};

function toForm(details: TaxDetails): FormState {
  return {
    legalName: details.legalName ?? '',
    taxId: details.taxId ?? '',
    registrationNo: details.registrationNo ?? '',
    taxCountry: details.taxCountry ?? '',
  };
}

/**
 * **Billing tax / legal-entity details (module 19, x283).**
 *
 * `49-PRICING-ENTITLEMENTS` / `33-LEGAL-AND-COMPLIANCE` — the studio's legal invoicing entity: a legal
 * name, a tax/VAT id, a registration number and a tax country, shown on the billing profile and later
 * on invoices. It reads `GET /v1/organizations/:orgSlug/billing/tax-details` and saves through the
 * paired `PUT`, both gated on `org.manage`, so a member without it gets the API's 403 rather than a
 * blank page.
 *
 * ## What it does not have
 *
 * - **No rail item.** Like the billing-settings screen, billing is not one of the fixed rail
 *   destinations (`22-SCREEN-BY-SCREEN` §1), so none is invented; it has its own route.
 * - **No card or bank fields, deliberately.** Payment instruments are held by the payment provider,
 *   never here (`04-SECURITY-PRIVACY` §4); this form captures legal/tax *metadata* only, and the API
 *   rejects any card/PAN-shaped value into these fields.
 * - **Distinct from the billing-profile contact slice (x180)** — legal/tax fields only, no contact and
 *   no address.
 */
export function TaxDetailsView({
  organizationSlug,
  organizationName,
  client,
}: TaxDetailsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const details = useQuery({
    queryKey: ['billing-tax-details', organizationSlug],
    queryFn: () => fetchTaxDetails(api, organizationSlug),
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (details.data) setForm(toForm(details.data));
  }, [details.data]);

  const save = useMutation({
    mutationFn: () =>
      updateTaxDetails(api, organizationSlug, {
        legalName: form.legalName.trim(),
        taxId: form.taxId.trim() === '' ? null : form.taxId.trim(),
        registrationNo: form.registrationNo.trim() === '' ? null : form.registrationNo.trim(),
        taxCountry: form.taxCountry.trim(),
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: ['billing-tax-details', organizationSlug],
      });
    },
  });

  const set = (patch: Partial<FormState>) => {
    setSaved(false);
    setForm((current) => ({ ...current, ...patch }));
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Billing"
      title="Tax and legal entity"
      description="Your legal billing entity and tax details, shown on invoices. No card details are stored here."
    >
      <div className="tm-bil">
        {details.isError ? (
          <InlineAlert tone="danger" title="Could not load tax details" live>
            {describeError(details.error)}
          </InlineAlert>
        ) : null}

        {details.isPending ? (
          <LoadingRegion label="Loading tax details." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!details.isPending && !details.isError ? (
          <form
            className="tm-panel tm-stack"
            noValidate
            aria-label="Tax and legal entity"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <section className="tm-stack" aria-labelledby="tm-tax-details-heading">
              <h2 id="tm-tax-details-heading" className="tm-eyebrow">
                Legal entity
              </h2>
              <Field
                label="Legal name"
                name="legalName"
                value={form.legalName}
                onChange={(event) => set({ legalName: event.target.value })}
                hint="The legal name of the entity billed. Required."
                required
              />
              <Field
                label="Tax / VAT ID"
                name="taxId"
                value={form.taxId}
                onChange={(event) => set({ taxId: event.target.value })}
                hint="VAT, EIN or equivalent. Not a card or account number."
              />
              <Field
                label="Registration number"
                name="registrationNo"
                value={form.registrationNo}
                onChange={(event) => set({ registrationNo: event.target.value })}
                hint="Company or business registration number, if any."
              />
              <Field
                label="Tax country"
                name="taxCountry"
                value={form.taxCountry}
                onChange={(event) => set({ taxCountry: event.target.value })}
                hint="A two-letter ISO country code, such as GB or US."
                required
              />
            </section>

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save tax details" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}

            {saved && !save.isError ? (
              <InlineAlert tone="success" title="Tax details saved" live>
                Your tax and legal entity details have been updated.
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={save.isPending}
                loadingLabel="Saving"
              >
                Save tax details
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
