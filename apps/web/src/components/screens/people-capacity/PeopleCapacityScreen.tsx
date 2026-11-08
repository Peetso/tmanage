'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { setPersonCapacity } from '../../../lib/api/person-capacity';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { getCapacityRoster } from './PeopleOverviewApi';
import type { CapacityRosterEntry } from './PeopleOverviewApi';
import { LOAD_CAPSULE, teamTotals, todayIso, weekLoad } from './PeopleCapacityRules';
import type { WeekLoad } from './PeopleCapacityRules';
import { PeopleCapacityTabs } from './PeopleCapacityTabs';
import '../../../styles/screens/people.css';
import '../../../styles/screens/people-capacity.css';

export interface PeopleCapacityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const LOAD_WORDS: Record<WeekLoad, [string, string]> = {
  unset: ['PeopleCapacity.loadUnset', 'Not set'],
  away: ['PeopleCapacity.loadAway', 'Away'],
  over: ['PeopleCapacity.loadOver', 'Over'],
  busy: ['PeopleCapacity.loadBusy', 'Busy'],
  room: ['PeopleCapacity.loadRoom', 'Has room'],
};

/**
 * **People · Capacity (A13).** Every active member with their weekly hours, how much of this week is
 * already allocated, and whether they are away — from `GET …/people/capacity` (`work.read`). Setting
 * hours uses the per-person `PUT …/people/:membershipId/capacity` (`project.manage`); a caller
 * without it gets the API's refusal as a sentence. Matches Figma section 513:30129.
 */
export function PeopleCapacityScreen({
  organizationSlug,
  organizationName,
  client,
}: PeopleCapacityScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const roster = useQuery({
    queryKey: ['people-capacity-roster', organizationSlug],
    queryFn: () => getCapacityRoster(api, organizationSlug),
  });

  const [membershipId, setMembershipId] = useState('');
  const [hours, setHours] = useState('40');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());

  const hoursValue = Number(hours);
  const hoursValid =
    hours !== '' && Number.isInteger(hoursValue) && hoursValue >= 0 && hoursValue <= 168;
  const canSave = membershipId !== '' && hoursValid && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);

  const save = useMutation({
    mutationFn: () =>
      setPersonCapacity(api, organizationSlug, membershipId, {
        weeklyHours: hoursValue,
        effectiveFrom,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['people-capacity-roster', organizationSlug] }),
  });

  const members = roster.data?.members ?? [];
  const anySet = members.some((member) => member.weeklyHours !== null);
  const totals = teamTotals(members);

  function pick(member: CapacityRosterEntry) {
    setMembershipId(member.membershipId);
    setHours(String(member.weeklyHours ?? 40));
    setEffectiveFrom(todayIso());
    save.reset();
    document.getElementById('ppl-cap-person')?.focus();
  }

  const form = (
    <form
      className="ppl-card ppl-card--tight ppl-form"
      aria-labelledby="ppl-cap-form-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save.mutate();
      }}
      noValidate
    >
      <h2 id="ppl-cap-form-heading" className="ppl-card__title">
        {tOr('PeopleCapacity.formTitle', 'Set weekly hours')}
      </h2>
      <div className="tm-field">
        <label className="tm-field__label" htmlFor="ppl-cap-person">
          {tOr('PeopleCapacity.person', 'Person')}
        </label>
        <select
          id="ppl-cap-person"
          className="tm-field__control"
          value={membershipId}
          required
          onChange={(event) => setMembershipId(event.target.value)}
        >
          <option value="">{tOr('PeopleCapacity.choosePerson', 'Choose a person')}</option>
          {members.map((member) => (
            <option key={member.membershipId} value={member.membershipId}>
              {member.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="tm-field">
        <label className="tm-field__label" htmlFor="ppl-cap-hours">
          {tOr('PeopleCapacity.weeklyHours', 'Weekly hours')}
        </label>
        <input
          id="ppl-cap-hours"
          className="tm-field__control"
          type="number"
          inputMode="numeric"
          min={0}
          max={168}
          step={1}
          value={hours}
          required
          aria-describedby="ppl-cap-hours-hint"
          onChange={(event) => setHours(event.target.value)}
        />
        <span className="tm-field__hint" id="ppl-cap-hours-hint">
          {tOr('PeopleCapacity.hoursHint', 'Whole hours, 0 to 168.')}
        </span>
      </div>
      <div className="tm-field">
        <label className="tm-field__label" htmlFor="ppl-cap-from">
          {tOr('PeopleCapacity.startsOn', 'Starts on')}
        </label>
        <input
          id="ppl-cap-from"
          className="tm-field__control"
          type="date"
          value={effectiveFrom}
          required
          onChange={(event) => setEffectiveFrom(event.target.value)}
        />
      </div>
      {save.isError ? (
        <InlineAlert tone="danger" title={tOr('PeopleCapacity.saveError', 'Hours not saved')} live>
          {describeError(save.error)}
        </InlineAlert>
      ) : null}
      {save.isSuccess ? (
        <InlineAlert tone="success" title={tOr('PeopleCapacity.saved', 'Hours saved')} live>
          {tOr('PeopleCapacity.savedBody', 'The team view now uses the new hours.')}
        </InlineAlert>
      ) : null}
      <div>
        <Button type="submit" tone="ink" disabled={!canSave || save.isPending}>
          {tOr('PeopleCapacity.save', 'Save hours')}
        </Button>
      </div>
    </form>
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={tOr('PeopleCapacity.eyebrow', 'People · This week')}
      title={tOr('PeopleCapacity.title', 'Capacity')}
      description={tOr(
        'PeopleCapacity.description',
        'Weekly hours per person and how much of it is already allocated to projects.',
      )}
    >
      <div className="ppl-cap">
        <PeopleCapacityTabs organizationSlug={organizationSlug} current="capacity" />

        {roster.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('PeopleCapacity.loadError', 'Capacity not loaded')}
            live
          >
            {describeError(roster.error)}
          </InlineAlert>
        ) : null}

        {roster.isPending ? (
          <LoadingRegion label={tOr('PeopleCapacity.loading', 'Loading capacity')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {roster.isSuccess ? (
          <div className="ppl-cap__body">
            <div className="ppl-cap__main">
              {!anySet ? (
                <section className="ppl-cap__empty" aria-labelledby="ppl-cap-empty-heading">
                  <h2 id="ppl-cap-empty-heading">
                    {tOr('PeopleCapacity.emptyTitle', 'No weekly hours yet')}
                  </h2>
                  <p>
                    {tOr(
                      'PeopleCapacity.emptyBody',
                      'Set how many hours each person works in a week. Allocations and the heatmap use these numbers.',
                    )}
                  </p>
                  <Button
                    type="button"
                    tone="ink"
                    onClick={() => document.getElementById('ppl-cap-person')?.focus()}
                  >
                    {tOr('PeopleCapacity.formTitle', 'Set weekly hours')}
                  </Button>
                </section>
              ) : (
                <>
                  <div className="ppl-cap__metrics">
                    <Metric
                      label={tOr('PeopleCapacity.teamHours', 'Team hours')}
                      value={`${totals.hours} ${tOr('PeopleCapacity.hoursShort', 'h')}`}
                    />
                    <Metric
                      label={tOr('PeopleCapacity.allocated', 'Allocated')}
                      value={
                        totals.allocatedPercent === null ? '—' : `${totals.allocatedPercent} %`
                      }
                    />
                    <Metric
                      label={tOr('PeopleCapacity.awayThisWeek', 'Away this week')}
                      value={String(totals.away)}
                    />
                  </div>
                  <div className="ppl-members-card">
                    <table className="ppl-members">
                      <caption className="tm-visually-hidden">
                        {tOr(
                          'PeopleCapacity.tableCaption',
                          'Weekly hours and allocation per person',
                        )}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">{tOr('PeopleCapacity.person', 'Person')}</th>
                          <th scope="col">{tOr('PeopleCapacity.weeklyHours', 'Weekly hours')}</th>
                          <th scope="col">{tOr('PeopleCapacity.allocated', 'Allocated')}</th>
                          <th scope="col">{tOr('PeopleCapacity.thisWeek', 'This week')}</th>
                          <th scope="col">
                            <span className="tm-visually-hidden">
                              {tOr('PeopleCapacity.actions', 'Actions')}
                            </span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((member) => {
                          const load = weekLoad(member);
                          const [key, english] = LOAD_WORDS[load];
                          return (
                            <tr key={member.membershipId} className="ppl-member">
                              <td>
                                <span className="ppl-cap__person">
                                  <Avatar name={member.displayName} size="compact" decorative />
                                  {member.displayName}
                                </span>
                              </td>
                              <td className="ppl-cap__num">
                                {member.weeklyHours === null
                                  ? '—'
                                  : `${member.weeklyHours} ${tOr('PeopleCapacity.hoursShort', 'h')}`}
                              </td>
                              <td className="ppl-cap__num">
                                {member.weeklyHours === null ? '—' : `${member.allocatedPercent} %`}
                                {member.tentativePercent > 0
                                  ? ` (+${member.tentativePercent} % ${tOr('PeopleCapacity.tentative', 'tentative')})`
                                  : ''}
                              </td>
                              <td>
                                <StateCapsule state={LOAD_CAPSULE[load]}>
                                  {tOr(key, english)}
                                </StateCapsule>
                              </td>
                              <td>
                                <div className="ppl-cap__row-actions">
                                  <Button
                                    type="button"
                                    tone="text"
                                    size="compact"
                                    aria-label={`${tOr('PeopleCapacity.edit', 'Edit')} ${member.displayName}`}
                                    onClick={() => pick(member)}
                                  >
                                    {tOr('PeopleCapacity.edit', 'Edit')}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
            <div className="ppl-cap__aside">
              {form}
              <section
                className="ppl-card ppl-card--tight ppl-card--ink"
                aria-labelledby="ppl-cap-who"
              >
                <h2 id="ppl-cap-who" className="ppl-mono">
                  {tOr('PeopleCapacity.whoTitle', 'Who can change this')}
                </h2>
                <p className="ppl-note ppl-note--ink">
                  {tOr(
                    'PeopleCapacity.whoBody',
                    'Project managers set hours. Everyone in the team can see them.',
                  )}
                </p>
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ppl-card ppl-card--tight">
      <p className="ppl-cap__label">{label}</p>
      <p className="ppl-cap__metric-value">{value}</p>
    </div>
  );
}
