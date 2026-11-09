'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPlanChangePreview } from '../../lib/api/plan-preview';
import type { PlanChangePreviewView } from '../../lib/api/plan-preview';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/billing.css';

export interface PlanChangePreviewScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Plan-change preview** — Billing / module 19 (x198). Before an owner commits the plan change x177
 * records, this estimates what the change costs: pick a target plan and a seat count, and see the new
 * monthly figure and the delta against the current subscription.
 *
 * Three decisions worth stating:
 *
 * 1. **Estimate, not a charge.** The endpoint reads and computes; it never bills. The screen says so,
 *    and a change is still requested on the subscription screen (a later payment slice activates it).
 * 2. **Authorization is the API's.** The preview sits behind `org.manage`; a member without it gets
 *    the ordinary 403, turned into a line by `describe()`, never a blank page.
 * 3. **Own route, no rail item.** Like the subscription screen, billing is not one of
 *    `22-SCREEN-BY-SCREEN` §1's eight rail destinations, so none is invented.
 */

/** The plans a preview may target. Kept in step with the API plan catalog (x157 pricing, later). */
const PLAN_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'starter', label: 'Starter' },
  { id: 'pro', label: 'Pro' },
  { id: 'business', label: 'Business' },
];

export function PlanChangePreviewScreen({
  organizationSlug,
  organizationName,
  client,
}: PlanChangePreviewScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const [target, setTarget] = useState<string>('pro');
  const [seats, setSeats] = useState<string>('1');

  const preview = useMutation({
    mutationFn: () => fetchPlanChangePreview(api, organizationSlug, target, Number(seats)),
  });

  const seatCount = Number(seats);
  const stepSeats = (by: number) => {
    const next = Math.min(1000, Math.max(1, (Number.isFinite(seatCount) ? seatCount : 1) + by));
    setSeats(String(next));
  };

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('PlanChangePreviewScreen.eyebrow')}
      title={t('PlanChangePreviewScreen.title')}
      description={t('PlanChangePreviewScreen.description')}
      headerAside={<p className="tm-bil-aside-note">{t('PlanChangePreviewScreen.headerNote')}</p>}
    >
      <form
        className="tm-bil-stack"
        aria-labelledby="tm-plan-preview-heading"
        onSubmit={(event) => {
          event.preventDefault();
          preview.mutate();
        }}
      >
        <h2 id="tm-plan-preview-heading" className="tm-visually-hidden">
          {t('PlanChangePreviewScreen.estimateHeading')}
        </h2>

        <fieldset className="tm-bil-plans">
          <legend className="tm-visually-hidden">
            {t('PlanChangePreviewScreen.targetPlanLegend')}
          </legend>
          {PLAN_OPTIONS.map((plan) => (
            <label key={plan.id} className="tm-bil-plan">
              <input
                type="radio"
                name="previewPlan"
                value={plan.id}
                checked={target === plan.id}
                onChange={() => setTarget(plan.id)}
              />
              <span className="tm-bil-plan__head">
                <span className="tm-bil-eyebrow">{t('PlanChangePreviewScreen.planEyebrow')}</span>
                {preview.data?.currentPlanId === plan.id ? (
                  <span className="tm-bil-status tm-bil-status--lime">
                    {t('PlanChangePreviewScreen.current')}
                  </span>
                ) : null}
              </span>
              <span className="tm-bil-plan__name">{plan.label}</span>
              <span className="tm-bil-plan__foot">
                <span className="tm-bil-pill-wide">
                  {target === plan.id
                    ? t('PlanChangePreviewScreen.selectedForEstimate')
                    : `${t('PlanChangePreviewScreen.estimateWord')} ${plan.label}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="tm-bil-split">
          <section className="tm-bil-card tm-card tm-card--ink" aria-live="polite">
            {preview.isSuccess ? (
              <PreviewResult preview={preview.data} />
            ) : (
              <>
                <p className="tm-bil-eyebrow">{t('PlanChangePreviewScreen.pickPlanEyebrow')}</p>
                <p className="tm-bil-card__lead">{t('PlanChangePreviewScreen.pickPlanLead')}</p>
              </>
            )}

            {preview.isError ? (
              <InlineAlert
                tone="danger"
                title={t('PlanChangePreviewScreen.estimateErrorTitle')}
                live
              >
                {describe(preview.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-bil-actions tm-bil-actions--foot">
              <Button type="submit" tone="lime" disabled={preview.isPending}>
                {preview.isPending
                  ? t('PlanChangePreviewScreen.estimating')
                  : t('PlanChangePreviewScreen.previewChange')}
              </Button>
            </div>
          </section>

          <section
            className="tm-bil-card tm-bil-card--paper"
            aria-labelledby="tm-plan-seats-heading"
          >
            <h3 id="tm-plan-seats-heading" className="tm-bil-card__title">
              {t('PlanChangePreviewScreen.seatsFor')} {planLabel(target)}
            </h3>
            <div className="tm-bil-stepper">
              <button
                type="button"
                className="tm-bil-stepper__button"
                aria-label={t('PlanChangePreviewScreen.oneSeatFewer')}
                disabled={seatCount <= 1}
                onClick={() => stepSeats(-1)}
              >
                −
              </button>
              <Field
                label={t('PlanChangePreviewScreen.seatsLabel')}
                type="number"
                min={1}
                max={1000}
                step={1}
                value={seats}
                onChange={(event) => setSeats(event.target.value)}
                className="tm-bil-stepper__field"
              />
              <button
                type="button"
                className="tm-bil-stepper__button"
                aria-label={t('PlanChangePreviewScreen.oneSeatMore')}
                disabled={seatCount >= 1000}
                onClick={() => stepSeats(1)}
              >
                +
              </button>
            </div>
            <p className="tm-bil-card__body">{t('PlanChangePreviewScreen.previewNote')}</p>
            <p className="tm-bil-card__foot">{t('PlanChangePreviewScreen.requestNote')}</p>
          </section>
        </div>
      </form>
    </SettingsShell>
  );
}

function PreviewResult({ preview }: { preview: PlanChangePreviewView }) {
  const t = useT();
  const delta = preview.estimatedDeltaCents;
  const direction = delta > 0 ? 'more' : delta < 0 ? 'less' : 'the same';
  const lead =
    delta === 0
      ? t('PlanChangePreviewScreen.sameEachMonth')
      : `${money(Math.abs(delta), preview.currency, false)} ${direction} a month. Nothing is charged by this estimate.`;

  return (
    <>
      <p className="tm-bil-eyebrow">
        {t('PlanChangePreviewScreen.ifYouGoFrom')} {planLabel(preview.currentPlanId)}{' '}
        {t('PlanChangePreviewScreen.toWord')} {planLabel(preview.targetPlanId)}
      </p>
      <p className="tm-bil-card__lead">{lead}</p>
      <ul className="tm-bil-points">
        <li>
          {planLabel(preview.targetPlanId)} for {preview.seats}{' '}
          {preview.seats === 1 ? 'seat' : 'seats'} is{' '}
          {money(preview.targetMonthlyCents, preview.currency, false)} a month
        </li>
        <li>
          Today {planLabel(preview.currentPlanId)} is{' '}
          {money(preview.currentMonthlyCents, preview.currency, false)} a month
        </li>
        <li data-tone={delta > 0 ? 'warning' : undefined}>
          Estimated change {money(delta, preview.currency)} / month ({direction})
        </li>
      </ul>
    </>
  );
}

function planLabel(planId: string): string {
  return PLAN_OPTIONS.find((plan) => plan.id === planId)?.label ?? planId;
}

/** Format integer cents as a currency amount (signed by default). The API sends integer cents. */
function money(cents: number, currency: string, signed = true): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}
