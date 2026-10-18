'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { MemberSelect } from '../MemberSelect';
import { browserApiClient } from '../../lib/api/browser-client';
import { useMembers, memberKeys } from '../../lib/use-members';
import { useHydrated } from '../../lib/use-hydrated';
import { memberDisplayName } from '../../lib/members-presentation';
import { getOffboardingImpact, offboardMember } from '../../lib/api/offboarding';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface OffboardingScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **ADM-12 / ADM-13 — member offboarding.** "If {name} left today": the metric cards of what
 * would be left without an owner, the table of what the member holds, and the black card that
 * carries the irreversible step.
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Administration: offboarding shows the access and work a
 * member holds *before* the revocation, then executes it. This screen is that — a member picker, the
 * access-impact preview for whoever is chosen, and a confirmed offboard behind an explicit
 * acknowledgement that it cannot be undone.
 *
 * ## Why the acknowledgement, and why the API still owns the refusals
 *
 * Offboarding never restores access (`OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS`), so the destructive
 * button is inert until the person ticks that they understand — a client-side courtesy, not a
 * control. The controls live on the API: it refuses a caller offboarding themselves, offboarding the
 * last member who can still administer the organization, and re-offboarding someone already
 * terminal, each with no write. This screen renders those refusals rather than trying to reproduce
 * them, because the browser cannot know who the last administrator is and must not pretend to.
 *
 * The picker offers active members only — the directory the API returns is active-only — so a member
 * who has just been offboarded drops out of it once the list is refetched, which is the visible
 * confirmation that the revocation took.
 */
export function OffboardingScreen({
  organizationSlug,
  organizationName,
  client,
}: OffboardingScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  // The picker ships disabled until React hydrates: a name typed into the server HTML would be
  // wiped by hydration and never reach the directory search.
  const hydrated = useHydrated();
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const directory = useMembers(api, organizationSlug, search);

  const impact = useQuery({
    queryKey: ['offboarding-impact', organizationSlug, selectedUserId],
    queryFn: () => getOffboardingImpact(api, organizationSlug, selectedUserId),
    enabled: selectedUserId !== '',
  });

  const offboard = useMutation({
    mutationFn: () => offboardMember(api, organizationSlug, selectedUserId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all(organizationSlug) });
      void queryClient.invalidateQueries({ queryKey: ['offboarding-impact', organizationSlug] });
      setSelectedUserId('');
      setAcknowledged(false);
    },
  });

  const chosenName =
    selectedUserId === ''
      ? ''
      : memberDisplayName(selectedUserId, directory.members, directory.isPending);

  const canOffboard =
    selectedUserId !== '' &&
    impact.isSuccess &&
    impact.data.offboardable &&
    acknowledged &&
    !offboard.isPending;

  const who = chosenName || 'this member';

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="offboarding"
      crumbs={chosenName ? ['Members', chosenName, 'Offboarding'] : ['Members', 'Offboarding']}
      title={chosenName ? `If ${chosenName} left today` : 'Who is leaving?'}
      description="Nothing here is a guess. Every number is a live count of what names this person as responsible. Offboarding cannot be undone."
      actions={
        <Link
          href={`/${organizationSlug}/people`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          Back to members
        </Link>
      }
    >
      <div className="tm-cc-card">
        <MemberSelect
          label="Member to offboard"
          members={directory.members}
          value={selectedUserId}
          onChange={(userId) => {
            setSelectedUserId(userId);
            setAcknowledged(false);
          }}
          onSearchChange={setSearch}
          loading={directory.isPending}
          failed={directory.isError}
          disabled={!hydrated}
          hint="Only active members can be offboarded."
        />
      </div>

      {offboard.isSuccess ? (
        <InlineAlert tone="success" title="Member offboarded" live>
          Their access has been revoked. They no longer appear in the member list.
        </InlineAlert>
      ) : null}

      {selectedUserId === '' ? null : (
        <section className="tm-cc-column" aria-label={`Offboarding impact for ${who}`}>
          <h2 className="tm-visually-hidden">What {who} holds</h2>

          {impact.isPending ? (
            <LoadingRegion
              label="Loading the access this member holds."
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {impact.isError ? (
            <InlineAlert tone="danger" title="Could not load the impact preview" live>
              {describe(impact.error)}
            </InlineAlert>
          ) : null}

          {impact.isSuccess ? (
            <>
              <ul className="tm-cc-metrics" aria-label="If nothing is done">
                <li
                  className={
                    impact.data.ownedWorkItemCount > 0
                      ? 'tm-cc-metric tm-cc-metric--attention'
                      : 'tm-cc-metric'
                  }
                >
                  <p className="tm-cc-metric__value">{impact.data.ownedWorkItemCount}</p>
                  <p className="tm-cc-metric__label">open work items lose their owner</p>
                  <p className="tm-cc-metric__source">Reassign before access ends</p>
                </li>
                <li className="tm-cc-metric">
                  <p className="tm-cc-metric__value">{impact.data.projectMembershipCount}</p>
                  <p className="tm-cc-metric__label">projects lose this member</p>
                  <p className="tm-cc-metric__source">Memberships end at once</p>
                </li>
                <li className="tm-cc-metric">
                  <p className="tm-cc-metric__value">{impact.data.role}</p>
                  <p className="tm-cc-metric__label">role that stops applying</p>
                  <p className="tm-cc-metric__source">Access is revoked, never restored</p>
                </li>
              </ul>

              <div className="tm-cc-split tm-cc-split--even tm-cc-split--stretch">
                <div className="tm-cc-card tm-cc-card--flush">
                  <table className="tm-table tm-cc-table" aria-label={`What ${who} holds`}>
                    <thead>
                      <tr>
                        <th scope="col">What {chosenName ? 'they own' : 'is held'}</th>
                        <th scope="col" className="tm-cc-end">
                          Count
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <span className="tm-cc-cell-title">Projects</span>
                          <span className="tm-cc-cell-sub">memberships that end</span>
                        </td>
                        <td className="tm-cc-end">
                          <span className="tm-cc-pill">
                            {impact.data.projectMembershipCount} project memberships
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span className="tm-cc-cell-title">Owned work</span>
                          <span className="tm-cc-cell-sub">items that name them as owner</span>
                        </td>
                        <td className="tm-cc-end">
                          <span
                            className={
                              impact.data.ownedWorkItemCount > 0
                                ? 'tm-cc-pill tm-cc-pill--warning'
                                : 'tm-cc-pill'
                            }
                          >
                            {impact.data.ownedWorkItemCount} work items
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span className="tm-cc-cell-title">Status</span>
                          <span className="tm-cc-cell-sub">membership today</span>
                        </td>
                        <td className="tm-cc-end">
                          <StatusDot tone={impact.data.offboardable ? 'neutral' : 'danger'}>
                            {impact.data.status}
                          </StatusDot>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="tm-cc-card tm-cc-card--ink">
                  {impact.data.offboardable ? (
                    <>
                      <p className="tm-cc-eyebrow">Before you offboard</p>
                      <p className="tm-cc-card__lead">
                        {impact.data.ownedWorkItemCount > 0
                          ? `Transfer ${impact.data.ownedWorkItemCount} work items first, or they land unowned.`
                          : `${who} owns no open work. Offboarding ends their access everywhere.`}
                      </p>
                      <p className="tm-cc-card__body">
                        Offboarding revokes access at once. It cannot be undone.
                      </p>
                      <hr className="tm-cc-rule" />
                      <Checkbox
                        label="I understand offboarding cannot be undone."
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      <div className="tm-cc-card__actions tm-cc-card__actions--end">
                        <Button
                          tone="lime"
                          size="accessible"
                          loading={offboard.isPending}
                          loadingLabel="Offboarding"
                          disabled={!canOffboard}
                          onClick={() => offboard.mutate()}
                        >
                          Offboard {who}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="tm-cc-eyebrow">Nothing left to do</p>
                      <p className="tm-cc-card__lead">Already offboarded</p>
                      <p className="tm-cc-card__body">
                        This member has already been offboarded. Their access cannot be revoked
                        again.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </section>
      )}

      {offboard.isError ? (
        <InlineAlert tone="danger" title="Offboarding failed" live>
          {describe(offboard.error)}
        </InlineAlert>
      ) : null}
    </ControlCenterShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
