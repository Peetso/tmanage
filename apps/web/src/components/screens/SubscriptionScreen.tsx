'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSubscription, requestPlanChange } from '../../lib/api/subscription';
import type { SubscriptionView } from '../../lib/api/subscription';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SubscriptionScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Subscription** — the billing screen `38-…` §Billing asks for: view the current plan and request
 * a plan change. x177 ships the read (`GET …/billing/subscription`) and the change request
 * (`POST …/billing/subscription/change`), both behind `org.manage`.
 *
 * Three decisions worth stating:
 *
 * 1. **No rail item.** Like the storage-usage screen, billing is not one of `22-SCREEN-BY-SCREEN`
 *    §1's eight rail destinations, so none is invented; the screen has its own route.
 * 2. **Authorization is the API's.** Both routes sit behind `org.manage`; a member without it gets
 *    the ordinary 403, which `describe()` turns into the forbidden line, never a blank page.
 * 3. **No charge here.** A change is *requested*, not paid. The screen says so, and the returned
 *    status is `pending_change` until a later payment slice (an external provider) activates it.
 */

/** The plans a change may target. Kept in step with the API plan catalog (x157 pricing, later). */
const PLAN_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'starter', label: 'Starter' },
  { id: 'pro', label: 'Pro' },
  { id: 'business', label: 'Business' },
];

export function SubscriptionScreen({
  organizationSlug,
  organizationName,
  client,
}: SubscriptionScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const subscriptionKey = ['organization-subscription', organizationSlug];

  const subscription = useQuery({
    queryKey: subscriptionKey,
    queryFn: () => fetchSubscription(api, organizationSlug),
  });

  const change = useMutation({
    mutationFn: (planId: string) => requestPlanChange(api, organizationSlug, planId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subscriptionKey });
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Subscription"
      description="The plan this organization is on, and how to request a change."
    >
      {subscription.isPending ? (
        <LoadingRegion label="Loading subscription." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {subscription.isError ? (
        <InlineAlert tone="danger" title="Could not load the subscription" live>
          {describe(subscription.error)}
        </InlineAlert>
      ) : null}

      {subscription.isSuccess ? (
        <SubscriptionPanel
          subscription={subscription.data}
          onChange={(planId) => change.mutate(planId)}
          isChanging={change.isPending}
          changeError={change.isError ? describe(change.error) : null}
          changed={change.isSuccess ? change.data : null}
        />
      ) : null}
    </AppShell>
  );
}

function SubscriptionPanel({
  subscription,
  onChange,
  isChanging,
  changeError,
  changed,
}: {
  subscription: SubscriptionView;
  onChange: (planId: string) => void;
  isChanging: boolean;
  changeError: string | null;
  changed: SubscriptionView | null;
}) {
  const [target, setTarget] = useState<string>(subscription.planId);

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-subscription-heading">
      <h2 id="tm-subscription-heading" className="tm-eyebrow">
        Current plan
      </h2>

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Plan</dt>
          <dd className="tm-mono">{planLabel(subscription.planId)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Status</dt>
          <dd>
            <StateCapsule state={subscription.status === 'pending_change' ? 'waiting' : 'current'}>
              {subscription.status === 'pending_change' ? 'Change pending' : 'Active'}
            </StateCapsule>
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Renews</dt>
          <dd className="tm-mono">
            {subscription.currentPeriodEnd === null
              ? 'No renewal date'
              : formatMoment(subscription.currentPeriodEnd)}
          </dd>
        </div>
      </dl>

      <form
        className="tm-stack tm-stack--tight"
        onSubmit={(event) => {
          event.preventDefault();
          onChange(target);
        }}
      >
        <Select
          label="Change plan"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          hint="Requesting a change does not charge you. Billing is arranged separately."
        >
          {PLAN_OPTIONS.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.label}
            </option>
          ))}
        </Select>

        <div>
          <Button type="submit" disabled={isChanging}>
            {isChanging ? 'Requesting…' : 'Request plan change'}
          </Button>
        </div>
      </form>

      {changeError !== null ? (
        <InlineAlert tone="danger" title="Could not request the change" live>
          {changeError}
        </InlineAlert>
      ) : null}

      {changed !== null ? (
        <InlineAlert tone="success" title="Change requested" live>
          {`We recorded your request to move to ${planLabel(changed.planId)}. Nothing has been charged — billing is arranged separately.`}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function planLabel(planId: string): string {
  return PLAN_OPTIONS.find((plan) => plan.id === planId)?.label ?? planId;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
