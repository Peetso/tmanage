'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createApprovalDelegation,
  listApprovalDelegations,
  revokeApprovalDelegation,
} from '../../lib/api/approval-delegations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ApprovalDelegationViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/** A `datetime-local` value ("2026-10-01T09:00") to an ISO-8601 instant, or null if unset/invalid. */
function toInstant(local: string): string | null {
  if (local.trim() === '') return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * **x300 — approval delegation.** (Approvals module, APR screen.)
 *
 * "Delegate my approvals": an approver hands their approval authority to another member for a window,
 * sees their active delegations, and revokes one. Create and revoke are gated on the server by
 * `approval.decide` (the delegator delegates the authority they hold) and the list by `approval.read`,
 * so a member without the capability sees the API's refusal rather than a blank page. The delegator is
 * always the acting member — this screen never names one — and the delegate is resolved active and in
 * the same tenant by the API, which answers a cross-tenant delegate with a not-found.
 */
export function ApprovalDelegationView({
  organizationSlug,
  organizationName,
  client,
}: ApprovalDelegationViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['approval-delegations', organizationSlug] as const;

  const [delegateMembershipId, setDelegate] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const delegations = useQuery({
    queryKey,
    queryFn: () => listApprovalDelegations(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () => {
      const starts = toInstant(startsAt);
      const ends = toInstant(endsAt);
      if (starts === null || ends === null) {
        throw new Error('Enter both a start and an end for the delegation window.');
      }
      return createApprovalDelegation(api, organizationSlug, {
        delegateMembershipId: delegateMembershipId.trim(),
        startsAt: starts,
        endsAt: ends,
      });
    },
    onSuccess: async () => {
      setDelegate('');
      setStartsAt('');
      setEndsAt('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApprovalDelegation(api, organizationSlug, id),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = delegations.data ?? [];
  const canCreate =
    delegateMembershipId.trim() !== '' && startsAt !== '' && endsAt !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Delegate my approvals"
      description="Let another member act on approvals for you during a window."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-delegation-new-heading">
        <h2 id="tm-delegation-new-heading" className="tm-eyebrow">
          New delegation
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
            label="Delegate membership id"
            name="delegateMembershipId"
            value={delegateMembershipId}
            onChange={(event) => setDelegate(event.target.value)}
            hint="The member who may act on your approvals during the window."
            required
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-delegation-starts">
              Starts
            </label>
            <input
              id="tm-delegation-starts"
              className="tm-field__control"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-delegation-ends">
              Ends
            </label>
            <input
              id="tm-delegation-ends"
              className="tm-field__control"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>

          {failure ? (
            <InlineAlert tone="danger" title="Could not delegate" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Saving"
              disabled={!canCreate}
            >
              Delegate
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-delegation-list-heading">
        <h2 id="tm-delegation-list-heading" className="tm-eyebrow">
          Active delegations
        </h2>
        {delegations.isPending ? (
          <LoadingRegion label="Loading your delegations.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {delegations.isError ? (
          <InlineAlert tone="danger" title="Could not load your delegations" live>
            {describe(delegations.error)}
          </InlineAlert>
        ) : null}

        {delegations.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">No delegations yet.</p>
          ) : (
            <ul className="tm-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {rows.map((delegation) => (
                <li key={delegation.id} className="tm-row tm-row--between">
                  <span className="tm-prose">
                    {delegation.delegateMembershipId} — {delegation.startsAt} to {delegation.endsAt}
                  </span>
                  <Button
                    type="button"
                    tone="text"
                    size="accessible"
                    loading={revoke.isPending}
                    loadingLabel="Revoking"
                    onClick={() => revoke.mutate(delegation.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
