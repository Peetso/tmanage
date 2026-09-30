'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  cancelPlanChangeRequest,
  createPlanChangeRequest,
  listPlanChangeRequests,
  type PlanChangeRequestView as PlanChangeRequest,
} from '../../lib/api/plan-change-requests';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Plan-change request"
      description="Record a request to move to another plan. Nothing is charged — billing is arranged separately."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-plan-catalog-heading">
        <h2 id="tm-plan-catalog-heading" className="tm-eyebrow">
          Available plans
        </h2>
        <ul className="tm-stack tm-stack--tight">
          {PLAN_OPTIONS.map((plan) => (
            <li key={plan.id}>
              <span className="tm-mono">{plan.label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-plan-request-heading">
        <h2 id="tm-plan-request-heading" className="tm-eyebrow">
          Request a change
        </h2>
        <form
          className="tm-stack tm-stack--tight"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canRequest) create.mutate();
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

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not record the request" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Requesting"
              disabled={!canRequest}
            >
              Request change
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-plan-request-list-heading"
      >
        <h2 id="tm-plan-request-list-heading" className="tm-eyebrow">
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
          <InlineAlert tone="neutral" title="No plan-change requests yet">
            Request a change above to record where you would like to move.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
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
                  <td className="tm-mono">{planLabel(request.targetPlanCode)}</td>
                  <td className="tm-mono">{request.effectiveOn}</td>
                  <td className="tm-mono">{request.status}</td>
                  <td>{request.note ?? '—'}</td>
                  <td>
                    {request.status === 'pending' ? (
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
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
        ) : null}

        <InlineAlert tone="neutral" title="Recorded intent only">
          Recording a request does not charge you or change your plan. Billing is arranged
          separately.
        </InlineAlert>
      </section>
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
