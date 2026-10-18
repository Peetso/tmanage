'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  cancelPlanChangeRequest,
  createPlanChangeRequest,
  listPlanChangeRequests,
  type PlanChangeRequestView as PlanChangeRequest,
} from '../../lib/api/plan-change-requests';
import { fetchSubscription } from '../../lib/api/subscription';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface PlanChangeRequestViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Plan-change request** — Billing / module 19 (x284). Record an organization's intent to move to
 * another plan: pick a target plan and an effective date, optionally add a note, and see the pending
 * request with a way to cancel it.
 *
 * Three decisions worth stating:
 *
 * 1. **A recorded intent, not a charge.** The endpoint records only which plan an admin asked to move
 *    to and when; it never bills, calls a provider, or changes an entitlement. The screen says so.
 * 2. **Authorization is the API's.** Every route sits behind `org.manage` (owners only); a member
 *    without it gets the ordinary 403, turned into a line by `describeError()`, never a blank page.
 * 3. **One pending request at a time.** A second request while one is pending is the API's 409, shown
 *    inline. Cancel the pending one first — the cancel is idempotent.
 *
 * The plan catalog (free/starter/pro/business) is the same closed set the preview screen shows, kept in
 * step with the API plan catalog (`plan-catalog.ts`).
 */

/** The plans a request may target — kept in step with the API plan catalog. */
const PLAN_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'starter', label: 'Starter' },
  { id: 'pro', label: 'Pro' },
  { id: 'business', label: 'Business' },
];

/** Today in `YYYY-MM-DD` (UTC), the earliest effective date the form offers and the API accepts. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function PlanChangeRequestView({
  organizationSlug,
  organizationName,
  client,
}: PlanChangeRequestViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const requests = useQuery({
    queryKey: ['plan-change-requests', organizationSlug],
    queryFn: () => listPlanChangeRequests(api, organizationSlug),
  });

  // The plan the studio is on, for the "Current" capsule. A refused read just leaves it off.
  const subscription = useQuery({
    queryKey: ['organization-subscription', organizationSlug],
    queryFn: () => fetchSubscription(api, organizationSlug),
  });

  const [target, setTarget] = useState<string>('pro');
  const [effectiveOn, setEffectiveOn] = useState<string>(todayIso());
  const [note, setNote] = useState<string>('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['plan-change-requests', organizationSlug] });

  const create = useMutation({
    mutationFn: () =>
      createPlanChangeRequest(api, organizationSlug, {
        targetPlanCode: target,
        effectiveOn,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: async () => {
      setNote('');
      await invalidate();
    },
  });

  const cancel = useMutation({
    mutationFn: (request: PlanChangeRequest) =>
      cancelPlanChangeRequest(api, organizationSlug, request.id),
    onSuccess: async () => {
      await invalidate();
    },
  });

  const rows = requests.data?.requests ?? [];
  const canRequest = effectiveOn !== '' && !create.isPending;

  const currentPlanId =
    subscription.isSuccess && typeof subscription.data?.planId === 'string'
      ? subscription.data.planId
      : null;
  const pending = rows.find((request) => request.status === 'pending') ?? null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Billing · Change plan"
      title="Change plan"
      headerAside={
        <p className="tm-bil-aside-note">Nothing is charged — billing is arranged separately</p>
      }
    >
      <form
        className="tm-bil-stack"
        noValidate
        aria-labelledby="tm-plan-request-heading"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canRequest) create.mutate();
        }}
      >
        <fieldset className="tm-bil-plans" aria-labelledby="tm-plan-catalog-heading">
          <legend id="tm-plan-catalog-heading" className="tm-visually-hidden">
            Available plans
          </legend>
          {PLAN_OPTIONS.map((plan) => (
            <label key={plan.id} className="tm-bil-plan">
              <input
                type="radio"
                name="targetPlan"
                value={plan.id}
                checked={target === plan.id}
                onChange={() => setTarget(plan.id)}
              />
              <span className="tm-bil-plan__head">
                <span className="tm-bil-eyebrow">Plan</span>
                {plan.id === currentPlanId ? (
                  <span className="tm-bil-status tm-bil-status--lime">Current</span>
                ) : null}
              </span>
              <span className="tm-bil-plan__name">{plan.label}</span>
              <span className="tm-bil-plan__foot">
                <span className="tm-bil-pill-wide">
                  {plan.id === currentPlanId
                    ? 'The plan the studio is on'
                    : target === plan.id
                      ? 'Selected'
                      : `Move to ${plan.label}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="tm-bil-split">
          <section
            className="tm-bil-card tm-card tm-card--ink"
            aria-labelledby="tm-plan-request-heading"
          >
            <h2 id="tm-plan-request-heading" className="tm-bil-eyebrow">
              {currentPlanId && currentPlanId !== target
                ? `If you go from ${planLabel(currentPlanId)} to ${planLabel(target)}`
                : `Request a change to ${planLabel(target)}`}
            </h2>
            <p className="tm-bil-card__lead">
              Nothing is charged and nobody loses access when the request is recorded.
            </p>
            <ul className="tm-bil-points">
              <li>The change is recorded for {effectiveOn || 'the date you pick'}</li>
              <li>Billing is arranged separately, after the request</li>
              <li data-tone="warning">Only one request can be pending at a time</li>
            </ul>

            <div className="tm-row tm-row--wrap tm-bil-request-fields">
              <Field
                label="Effective date"
                type="date"
                min={todayIso()}
                value={effectiveOn}
                onChange={(event) => setEffectiveOn(event.target.value)}
                hint="When the change should take effect — today or later."
                required
              />

              <Field
                label="Note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                hint="Optional — why you are requesting this change."
              />
            </div>

            {create.isError ? (
              <InlineAlert tone="danger" title="Could not record the request" live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-bil-actions">
              <Button
                type="submit"
                tone="lime"
                size="accessible"
                loading={create.isPending}
                loadingLabel="Requesting"
                disabled={!canRequest}
              >
                Request {planLabel(target)}
              </Button>
            </div>
          </section>

          <section
            className="tm-bil-card tm-bil-card--paper"
            aria-labelledby="tm-plan-request-list-heading"
          >
            <h2 id="tm-plan-request-list-heading" className="tm-bil-card__title">
              Requests {requests.isSuccess ? `(${rows.length})` : ''}
            </h2>

            {requests.isError ? (
              <InlineAlert tone="danger" title="Could not load the requests" live>
                {describeError(requests.error)}
              </InlineAlert>
            ) : null}

            {cancel.isError ? (
              <InlineAlert tone="danger" title="Could not cancel the request" live>
                {describeError(cancel.error)}
              </InlineAlert>
            ) : null}

            {requests.isPending ? (
              <LoadingRegion label="Loading the requests.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {requests.isSuccess && rows.length === 0 ? (
              <p className="tm-bil-card__body">
                No plan-change requests yet. Pick a plan and request it to record where you would
                like to move.
              </p>
            ) : null}

            {pending ? (
              <p className="tm-bil-card__body">
                {planLabel(pending.targetPlanCode)} is requested from {pending.effectiveOn}.
              </p>
            ) : null}

            {rows.length > 0 ? (
              <div className="tm-bil-table-card">
                <table className="tm-table">
                  <caption className="tm-visually-hidden">
                    The organization&rsquo;s plan-change requests.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Target plan</th>
                      <th scope="col">Effective date</th>
                      <th scope="col">Status</th>
                      <th scope="col">Note</th>
                      <th scope="col">
                        <span className="tm-visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((request) => (
                      <tr key={request.id}>
                        <td>{planLabel(request.targetPlanCode)}</td>
                        <td className="tm-mono">{request.effectiveOn}</td>
                        <td>
                          <span
                            className={`tm-bil-status${request.status === 'pending' ? ' tm-bil-status--warning' : ''}`}
                          >
                            {request.status}
                          </span>
                        </td>
                        <td>{request.note ?? '—'}</td>
                        <td className="tm-bil-num">
                          {request.status === 'pending' ? (
                            <Button
                              type="button"
                              tone="destructive"
                              size="compact"
                              loading={cancel.isPending && cancel.variables?.id === request.id}
                              loadingLabel="Cancelling"
                              onClick={() => cancel.mutate(request)}
                            >
                              Cancel
                            </Button>
                          ) : (
                            <span className="tm-visually-hidden">No actions</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <p className="tm-bil-card__foot">
              Recording a request does not charge you or change your plan. Billing is arranged
              separately.
            </p>
          </section>
        </div>
      </form>
    </AppShell>
  );
}

function planLabel(planId: string): string {
  return PLAN_OPTIONS.find((plan) => plan.id === planId)?.label ?? planId;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
