'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPlanChangePreview } from '../../lib/api/plan-preview';
import type { PlanChangePreviewView } from '../../lib/api/plan-preview';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();
  const [target, setTarget] = useState<string>('pro');
  const [seats, setSeats] = useState<string>('1');

  const preview = useMutation({
    mutationFn: () => fetchPlanChangePreview(api, organizationSlug, target, Number(seats)),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Plan-change preview"
      description="Estimate what moving to another plan would cost, before you request the change."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-plan-preview-heading">
        <h2 id="tm-plan-preview-heading" className="tm-eyebrow">
          Estimate a change
        </h2>

        <form
          className="tm-stack tm-stack--tight"
          onSubmit={(event) => {
            event.preventDefault();
            preview.mutate();
          }}
        >
          <Select
            label="Target plan"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {PLAN_OPTIONS.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.label}
              </option>
            ))}
          </Select>

          <Field
            label="Seats"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
            hint="Previewing does not charge you. Billing is arranged separately."
          />

          <div>
            <Button type="submit" disabled={preview.isPending}>
              {preview.isPending ? 'Estimating…' : 'Preview change'}
            </Button>
          </div>
        </form>

        {preview.isError ? (
          <InlineAlert tone="danger" title="Could not estimate the change" live>
            {describe(preview.error)}
          </InlineAlert>
        ) : null}

        {preview.isSuccess ? <PreviewResult preview={preview.data} /> : null}
      </section>
    </AppShell>
  );
}

function PreviewResult({ preview }: { preview: PlanChangePreviewView }) {
  const delta = preview.estimatedDeltaCents;
  const direction = delta > 0 ? 'more' : delta < 0 ? 'less' : 'the same';

  return (
    <div className="tm-stack tm-stack--tight" aria-live="polite">
      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Current plan</dt>
          <dd className="tm-mono">{planLabel(preview.currentPlanId)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Target plan</dt>
          <dd className="tm-mono">{planLabel(preview.targetPlanId)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Seats</dt>
          <dd className="tm-mono">{preview.seats}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Current monthly</dt>
          <dd className="tm-mono">{money(preview.currentMonthlyCents, preview.currency)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>New monthly</dt>
          <dd className="tm-mono">{money(preview.targetMonthlyCents, preview.currency)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Estimated change</dt>
          <dd className="tm-mono">
            {money(delta, preview.currency)} / month ({direction})
          </dd>
        </div>
      </dl>

      <InlineAlert tone="neutral" title="Estimate only">
        This is an estimate — nothing has been charged. Request the change on the subscription
        screen; billing is arranged separately.
      </InlineAlert>
    </div>
  );
}

function planLabel(planId: string): string {
  return PLAN_OPTIONS.find((plan) => plan.id === planId)?.label ?? planId;
}

/** Format integer cents as a signed currency amount. Deterministic; the API sends integer cents. */
function money(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      signDisplay: 'exceptZero',
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
