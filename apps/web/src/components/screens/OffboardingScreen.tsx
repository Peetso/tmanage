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
import { useRoleDescription } from '../../lib/use-role-description';
import { getOffboardingImpact, offboardMember } from '../../lib/api/offboarding';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

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
  const describe = useDescribeApiError();
  const describeRole = useRoleDescription();
  const api = client ?? browserApiClient();
  const t = useT();
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

  const who = chosenName || t('OffboardingScreen.thisMember');

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="offboarding"
      crumbs={
        chosenName
          ? [
              t('OffboardingScreen.crumbMembers'),
              chosenName,
              t('OffboardingScreen.crumbOffboarding'),
            ]
          : [t('OffboardingScreen.crumbMembers'), t('OffboardingScreen.crumbOffboarding')]
      }
      title={
        chosenName
          ? `${t('OffboardingScreen.ifPrefix')} ${chosenName} ${t('OffboardingScreen.leftToday')}`
          : t('OffboardingScreen.whoLeaving')
      }
      description={t('OffboardingScreen.description')}
      actions={
        <Link
          href={`/${organizationSlug}/people`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('OffboardingScreen.backToMembers')}
        </Link>
      }
    >
      <div className="tm-cc-card">
        <MemberSelect
          label={t('OffboardingScreen.memberToOffboard')}
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
          openOnFocus
          hint={t('OffboardingScreen.onlyActive')}
        />
      </div>

      {offboard.isSuccess ? (
        <InlineAlert tone="success" title={t('OffboardingScreen.memberOffboardedTitle')} live>
          {t('OffboardingScreen.memberOffboardedBody')}
        </InlineAlert>
      ) : null}

      {selectedUserId === '' ? null : (
        <section className="tm-cc-column" aria-label={`${t('OffboardingScreen.impactFor')} ${who}`}>
          <h2 className="tm-visually-hidden">
            {t('OffboardingScreen.whatPrefix')} {who} {t('OffboardingScreen.holds')}
          </h2>

          {impact.isPending ? (
            <LoadingRegion
              label={t('OffboardingScreen.loadingAccess')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {impact.isError ? (
            <InlineAlert tone="danger" title={t('OffboardingScreen.impactError')} live>
              {describe(impact.error)}
            </InlineAlert>
          ) : null}

          {impact.isSuccess ? (
            <>
              <ul className="tm-cc-metrics" aria-label={t('OffboardingScreen.ifNothingDone')}>
                <li
                  className={
                    impact.data.ownedWorkItemCount > 0
                      ? 'tm-cc-metric tm-cc-metric--attention'
                      : 'tm-cc-metric'
                  }
                >
                  <p className="tm-cc-metric__value">{impact.data.ownedWorkItemCount}</p>
                  <p className="tm-cc-metric__label">
                    {impact.data.ownedWorkItemCount === 1
                      ? t('OffboardingScreen.workItemLosesOwnerOne')
                      : t('OffboardingScreen.workItemLosesOwnerMany')}
                  </p>
                  <p className="tm-cc-metric__source">{t('OffboardingScreen.reassignBefore')}</p>
                </li>
                <li className="tm-cc-metric">
                  <p className="tm-cc-metric__value">{impact.data.projectMembershipCount}</p>
                  <p className="tm-cc-metric__label">
                    {impact.data.projectMembershipCount === 1
                      ? t('OffboardingScreen.projectLosesMemberOne')
                      : t('OffboardingScreen.projectLosesMemberMany')}
                  </p>
                  <p className="tm-cc-metric__source">{t('OffboardingScreen.membershipsEnd')}</p>
                </li>
                <li className="tm-cc-metric">
                  <p className="tm-cc-metric__value">{describeRole(impact.data.role).label}</p>
                  <p className="tm-cc-metric__label">{t('OffboardingScreen.roleStops')}</p>
                  <p className="tm-cc-metric__source">{t('OffboardingScreen.accessRevoked')}</p>
                </li>
              </ul>

              <div className="tm-cc-split tm-cc-split--even tm-cc-split--stretch">
                <div className="tm-cc-card tm-cc-card--flush">
                  <table
                    className="tm-table tm-cc-table"
                    aria-label={`${t('OffboardingScreen.whatPrefix')} ${who} ${t('OffboardingScreen.holds')}`}
                  >
                    <thead>
                      <tr>
                        <th scope="col">
                          {t('OffboardingScreen.whatPrefix')}{' '}
                          {chosenName
                            ? t('OffboardingScreen.theyOwn')
                            : t('OffboardingScreen.isHeld')}
                        </th>
                        <th scope="col" className="tm-cc-end">
                          {t('OffboardingScreen.count')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <span className="tm-cc-cell-title">
                            {t('OffboardingScreen.projects')}
                          </span>
                          <span className="tm-cc-cell-sub">
                            {t('OffboardingScreen.membershipsThatEnd')}
                          </span>
                        </td>
                        <td className="tm-cc-end">
                          <span className="tm-cc-pill">
                            {plural(
                              impact.data.projectMembershipCount,
                              t('OffboardingScreen.projectMembershipOne'),
                              t('OffboardingScreen.projectMembershipMany'),
                            )}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span className="tm-cc-cell-title">
                            {t('OffboardingScreen.ownedWork')}
                          </span>
                          <span className="tm-cc-cell-sub">
                            {t('OffboardingScreen.itemsNameOwner')}
                          </span>
                        </td>
                        <td className="tm-cc-end">
                          <span
                            className={
                              impact.data.ownedWorkItemCount > 0
                                ? 'tm-cc-pill tm-cc-pill--warning'
                                : 'tm-cc-pill'
                            }
                          >
                            {plural(
                              impact.data.ownedWorkItemCount,
                              t('OffboardingScreen.workItemOne'),
                              t('OffboardingScreen.workItemMany'),
                            )}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span className="tm-cc-cell-title">{t('OffboardingScreen.status')}</span>
                          <span className="tm-cc-cell-sub">
                            {t('OffboardingScreen.membershipToday')}
                          </span>
                        </td>
                        <td className="tm-cc-end">
                          <StatusDot tone={impact.data.offboardable ? 'neutral' : 'danger'}>
                            {statusLabel(impact.data.status, t)}
                          </StatusDot>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="tm-cc-card tm-cc-card--ink">
                  {impact.data.offboardable ? (
                    <>
                      <p className="tm-cc-eyebrow">{t('OffboardingScreen.beforeYouOffboard')}</p>
                      <p className="tm-cc-card__lead">
                        {impact.data.ownedWorkItemCount > 0
                          ? `${t('OffboardingScreen.transferPrefix')} ${plural(impact.data.ownedWorkItemCount, t('OffboardingScreen.workItemOne'), t('OffboardingScreen.workItemMany'))} ${t('OffboardingScreen.firstOr')} ${impact.data.ownedWorkItemCount === 1 ? t('OffboardingScreen.itLands') : t('OffboardingScreen.theyLand')} ${t('OffboardingScreen.unowned')}`
                          : `${who} ${t('OffboardingScreen.ownsNoWork')}`}
                      </p>
                      <p className="tm-cc-card__body">{t('OffboardingScreen.revokesAtOnce')}</p>
                      <hr className="tm-cc-rule" />
                      <Checkbox
                        label={t('OffboardingScreen.understandCannotUndo')}
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      <div className="tm-cc-card__actions tm-cc-card__actions--end">
                        <Button
                          tone="lime"
                          size="accessible"
                          loading={offboard.isPending}
                          loadingLabel={t('OffboardingScreen.crumbOffboarding')}
                          disabled={!canOffboard}
                          onClick={() => offboard.mutate()}
                        >
                          {t('OffboardingScreen.offboardPrefix')} {who}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="tm-cc-eyebrow">{t('OffboardingScreen.nothingLeftToDo')}</p>
                      <p className="tm-cc-card__lead">{t('OffboardingScreen.alreadyOffboarded')}</p>
                      <p className="tm-cc-card__body">
                        {t('OffboardingScreen.alreadyOffboardedBody')}
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
        <InlineAlert tone="danger" title={t('OffboardingScreen.offboardingFailed')} live>
          {describe(offboard.error)}
        </InlineAlert>
      ) : null}
    </ControlCenterShell>
  );
}

/**
 * `count` followed by the noun, singular at one (ADM-16). "1 project memberships" and "1 work
 * items" are the exact wrongness the walkthrough flagged on this screen.
 */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A membership status as a word a person reads, not the stored code (ADM-16). The API's values
 * are lowercase (`active`, `offboarded`, `invited`, `suspended`); an unknown one is title-cased
 * rather than guessed at, so a status added later still reads as a label and never as a bug.
 */
function statusLabel(status: string, t: (key: MessageKey) => string): string {
  const keys: Record<string, MessageKey> = {
    active: 'OffboardingScreen.statusActive',
    offboarded: 'OffboardingScreen.statusOffboarded',
    invited: 'OffboardingScreen.statusInvited',
    suspended: 'OffboardingScreen.statusSuspended',
  };
  const key = keys[status];
  return key ? t(key) : status.charAt(0).toUpperCase() + status.slice(1);
}
