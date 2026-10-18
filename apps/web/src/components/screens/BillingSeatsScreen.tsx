'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  assignBillingSeat,
  listBillingSeats,
  releaseBillingSeat,
  type BillingSeat,
} from '../../lib/api/billing-seats';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface BillingSeatsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Billing seats (Billing module 19, x178).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing ("seat management"). This screen is disjoint
 * from the storage-usage billing screen: it owns the seat roster a manager assigns and reclaims. It
 * lists the organization's active seats and their count, assigns a seat to a membership, and reclaims
 * one.
 *
 * The reads and writes are gated on the server by `org.manage` — owners only — so a member who opens
 * this screen sees the API's 403 rather than a blank page. A seat is assigned by membership id and is
 * reclaimed with a soft close; charging and seat ceilings against a paid plan are out of scope
 * (Needs-Peter), so nothing here moves money.
 */
export function BillingSeatsScreen({
  organizationSlug,
  organizationName,
  client,
}: BillingSeatsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const seats = useQuery({
    queryKey: ['billing-seats', organizationSlug],
    queryFn: () => listBillingSeats(api, organizationSlug),
  });

  const [membershipId, setMembershipId] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['billing-seats', organizationSlug] });

  const assign = useMutation({
    mutationFn: () =>
      assignBillingSeat(api, organizationSlug, { membershipId: membershipId.trim() }),
    onSuccess: async () => {
      setMembershipId('');
      await invalidate();
    },
  });

  const release = useMutation({
    mutationFn: (seat: BillingSeat) => releaseBillingSeat(api, organizationSlug, seat.id),
    onSuccess: async () => {
      await invalidate();
    },
  });

  const rows = seats.data?.seats ?? [];
  const canAssign = membershipId.trim() !== '' && !assign.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Billing"
      title="Seats"
      description="Assign and reclaim the seats your team holds against your plan."
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-seat-assign-heading">
          <h2 id="tm-seat-assign-heading" className="tm-eyebrow">
            Assign a seat
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canAssign) assign.mutate();
            }}
          >
            <Field
              label="Membership ID"
              name="membershipId"
              value={membershipId}
              onChange={(event) => setMembershipId(event.target.value)}
              hint="The membership to grant a seat to."
              required
            />

            {assign.isError ? (
              <InlineAlert tone="danger" title="Could not assign the seat" live>
                {describeError(assign.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={assign.isPending}
                loadingLabel="Assigning"
                disabled={!canAssign}
              >
                Assign seat
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-seat-list-heading"
        >
          <h2 id="tm-seat-list-heading" className="tm-eyebrow">
            Active seats {seats.isSuccess ? `(${seats.data.activeCount})` : ''}
          </h2>

          {seats.isError ? (
            <InlineAlert tone="danger" title="Could not load the seats" live>
              {describeError(seats.error)}
            </InlineAlert>
          ) : null}

          {release.isError ? (
            <InlineAlert tone="danger" title="Could not reclaim the seat" live>
              {describeError(release.error)}
            </InlineAlert>
          ) : null}

          {seats.isPending ? (
            <LoadingRegion label="Loading the seats.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {seats.isSuccess && rows.length === 0 ? (
            <InlineAlert tone="neutral" title="No active seats yet">
              Assign a seat with the form to grant a membership a licence against your plan.
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                The organization&rsquo;s active seats.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Membership</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((seat) => (
                  <tr key={seat.id}>
                    <td>{seat.membershipId}</td>
                    <td>{new Date(seat.assignedAt).toLocaleDateString()}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={release.isPending && release.variables?.id === seat.id}
                        loadingLabel="Reclaiming"
                        onClick={() => release.mutate(seat)}
                      >
                        Reclaim
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
