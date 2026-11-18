'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchAdminOverview } from '../../lib/api/admin-overview';
import {
  assignBillingSeat,
  listBillingSeats,
  releaseBillingSeat,
  type BillingSeat,
} from '../../lib/api/billing-seats';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { MembershipSelect, usePeopleDirectory } from '../people/MembershipSelect';
import '../../styles/screens/billing.css';
import { appLocale } from '../../lib/i18n/app-locale';

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
  const t = useT();
  const tOr = useTOr();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

  const seats = useQuery({
    queryKey: ['billing-seats', organizationSlug],
    queryFn: () => listBillingSeats(api, organizationSlug),
  });

  // The organization's active-member count, so the seat roster is read in context: the overview
  // counts members, this screen counts seats assigned by hand, and showing both together stops the
  // "0 seats but 4 members" contradiction a reader otherwise hits (BIL-02). Same org.manage gate.
  const overview = useQuery({
    queryKey: ['admin-overview', organizationSlug],
    queryFn: () => fetchAdminOverview(api, organizationSlug),
  });
  const activeMembers = overview.data?.activeMembers;

  // A seat is given to, and listed by, a person's name; the membership id is only what the API keeps.
  const people = usePeopleDirectory(api, organizationSlug);
  const roster = people.data?.people ?? [];
  const holderName = (membershipId: string): string => {
    if (!people.isSuccess) return '';
    return (
      roster.find((person) => person.membershipId === membershipId)?.displayName ??
      t('BillingSeatsScreen.formerMember')
    );
  };

  const [membershipId, setMembershipId] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['billing-seats', organizationSlug] });

  const assign = useMutation({
    mutationFn: () => assignBillingSeat(api, organizationSlug, { membershipId }),
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
  const canAssign = membershipId !== '' && !assign.isPending;

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('BillingSeatsScreen.eyebrow')}
      title={t('BillingSeatsScreen.title')}
      description={t('BillingSeatsScreen.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-seat-assign-heading">
          <h2 id="tm-seat-assign-heading" className="tm-eyebrow">
            {t('BillingSeatsScreen.assignHeading')}
          </h2>
          <form
            ref={firstStep}
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canAssign) assign.mutate();
            }}
          >
            {people.isError ? (
              <InlineAlert tone="danger" title={t('BillingSeatsScreen.errorPeopleTitle')} live>
                {describeError(t, people.error)}
              </InlineAlert>
            ) : null}
            <MembershipSelect
              label={t('BillingSeatsScreen.memberLabel')}
              hint={t('BillingSeatsScreen.memberHint')}
              placeholder={t('BillingSeatsScreen.chooseMember')}
              people={roster}
              name="membershipId"
              value={membershipId}
              onChange={setMembershipId}
              required
            />

            {assign.isError ? (
              <InlineAlert tone="danger" title={t('BillingSeatsScreen.errorAssignTitle')} live>
                {describeError(t, assign.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={assign.isPending}
                loadingLabel={t('BillingSeatsScreen.assigning')}
                disabled={!canAssign}
              >
                {t('BillingSeatsScreen.assignButton')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-seat-list-heading"
        >
          <h2 id="tm-seat-list-heading" className="tm-eyebrow">
            {t('BillingSeatsScreen.activeSeatsHeading')}{' '}
            {seats.isSuccess ? `(${seats.data.activeCount})` : ''}
          </h2>

          {seats.isSuccess && activeMembers !== undefined ? (
            <p className="tm-muted">
              {activeMembers === 1
                ? t('BillingSeatsScreen.onePersonIs')
                : `${activeMembers} ${t('BillingSeatsScreen.peopleAre')}`}{' '}
              {t('BillingSeatsScreen.activeInWorkspace')}
            </p>
          ) : null}

          {seats.isError ? (
            <InlineAlert tone="danger" title={t('BillingSeatsScreen.errorLoadTitle')} live>
              {describeError(t, seats.error)}
            </InlineAlert>
          ) : null}

          {release.isError ? (
            <InlineAlert tone="danger" title={t('BillingSeatsScreen.errorReclaimTitle')} live>
              {describeError(t, release.error)}
            </InlineAlert>
          ) : null}

          {seats.isPending ? (
            <LoadingRegion label={t('BillingSeatsScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {seats.isSuccess && rows.length === 0 ? (
            <TeachingEmptyState
              title={t('BillingSeatsScreen.emptyTitle')}
              explanation={tOr(
                'teachEmpty.billingSeatsBody',
                'Give a member a seat on your plan, and see here who holds each seat and how many are in use.',
              )}
              action={
                canUse('billing.manage') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {tOr('teachEmpty.billingSeatsAction', 'Assign a seat')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table">
              <caption className="tm-visually-hidden">{t('BillingSeatsScreen.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('BillingSeatsScreen.colMember')}</th>
                  <th scope="col">{t('BillingSeatsScreen.colAssigned')}</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">
                      {t('BillingSeatsScreen.actionsColumn')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((seat) => (
                  <tr key={seat.id}>
                    <td>{holderName(seat.membershipId)}</td>
                    <td>{new Date(seat.assignedAt).toLocaleDateString(appLocale())}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={release.isPending && release.variables?.id === seat.id}
                        loadingLabel={t('BillingSeatsScreen.reclaiming')}
                        onClick={() => release.mutate(seat)}
                      >
                        {t('BillingSeatsScreen.reclaim')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </SettingsShell>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('BillingSeatsScreen.errorApiUnreachable');
  return t('BillingSeatsScreen.errorGeneric');
}
