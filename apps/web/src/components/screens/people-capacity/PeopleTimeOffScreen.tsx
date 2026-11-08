'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { createPersonTimeOff, deletePersonTimeOff } from '../../../lib/api/person-time-off';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { getCapacityRoster, listOrgTimeOff } from './PeopleOverviewApi';
import type { OverviewTimeOff } from './PeopleOverviewApi';
import { todayIso } from './PeopleCapacityRules';
import { PeopleCapacityTabs } from './PeopleCapacityTabs';
import '../../../styles/screens/people.css';
import '../../../styles/screens/people-capacity.css';

export interface PeopleTimeOffScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Mirrors the API's `TIME_OFF_KINDS`. */
const KINDS: readonly { value: string; key: string; english: string; capsule: CapsuleState }[] = [
  { value: 'vacation', key: 'PeopleTimeOff.kindVacation', english: 'Vacation', capsule: 'done' },
  { value: 'sick', key: 'PeopleTimeOff.kindSick', english: 'Sick', capsule: 'waiting' },
  { value: 'other', key: 'PeopleTimeOff.kindOther', english: 'Other', capsule: 'neutral' },
];

/**
 * **People · Time off (A13).** Everyone's dated absences from today for the next 90 days, from
 * `GET …/people/time-off` (`work.read`). Filing and removing an absence use the per-person
 * `POST/DELETE …/people/:userId/time-off` (`org.manage`); a caller without it gets the API's
 * refusal as a sentence.
 */
export function PeopleTimeOffScreen({
  organizationSlug,
  organizationName,
  client,
}: PeopleTimeOffScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const entries = useQuery({
    queryKey: ['people-time-off', organizationSlug],
    queryFn: () => listOrgTimeOff(api, organizationSlug),
  });
  const roster = useQuery({
    queryKey: ['people-capacity-roster', organizationSlug],
    queryFn: () => getCapacityRoster(api, organizationSlug),
  });

  const [userId, setUserId] = useState('');
  const [startsOn, setStartsOn] = useState(todayIso());
  const [endsOn, setEndsOn] = useState(todayIso());
  const [kind, setKind] = useState('vacation');
  const [note, setNote] = useState('');
  const datesValid =
    /^\d{4}-\d{2}-\d{2}$/.test(startsOn) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endsOn) &&
    endsOn >= startsOn;
  const canAdd = userId !== '' && datesValid;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['people-time-off', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['people-capacity-roster', organizationSlug] }),
    ]);

  const add = useMutation({
    mutationFn: () =>
      createPersonTimeOff(api, organizationSlug, userId, {
        startsOn,
        endsOn,
        kind,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: async () => {
      setNote('');
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (entry: OverviewTimeOff) =>
      deletePersonTimeOff(api, organizationSlug, entry.personUserId, entry.id),
    onSuccess: refresh,
  });

  const kindOf = (value: string) => KINDS.find((item) => item.value === value) ?? KINDS[2]!;
  const list = entries.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={tOr('PeopleTimeOff.eyebrow', 'People · Next 90 days')}
      title={tOr('PeopleTimeOff.title', 'Time off')}
      description={tOr(
        'PeopleTimeOff.description',
        'Who is away and when, so plans and allocations can work around it.',
      )}
    >
      <div className="ppl-cap">
        <PeopleCapacityTabs organizationSlug={organizationSlug} current="time-off" />
        <div className="ppl-cap__body">
          <div className="ppl-cap__main">
            {entries.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PeopleTimeOff.loadError', 'Time off not loaded')}
                live
              >
                {describeError(entries.error)}
              </InlineAlert>
            ) : null}
            {entries.isPending ? (
              <LoadingRegion label={tOr('PeopleTimeOff.loading', 'Loading time off')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {entries.isSuccess && list.length === 0 ? (
              <section className="ppl-cap__empty" aria-labelledby="ppl-off-empty-heading">
                <h2 id="ppl-off-empty-heading">
                  {tOr('PeopleTimeOff.emptyTitle', 'No time off coming up')}
                </h2>
                <p>
                  {tOr(
                    'PeopleTimeOff.emptyBody',
                    'Nobody is away in the next 90 days. Add an absence when someone books time off.',
                  )}
                </p>
              </section>
            ) : null}
            {entries.isSuccess && list.length > 0 ? (
              <div className="ppl-members-card">
                <table className="ppl-members">
                  <caption className="tm-visually-hidden">
                    {tOr('PeopleTimeOff.tableCaption', 'Time off in the next 90 days')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{tOr('PeopleTimeOff.person', 'Person')}</th>
                      <th scope="col">{tOr('PeopleTimeOff.dates', 'Dates')}</th>
                      <th scope="col">{tOr('PeopleTimeOff.kind', 'Kind')}</th>
                      <th scope="col">{tOr('PeopleTimeOff.note', 'Note')}</th>
                      <th scope="col">
                        <span className="tm-visually-hidden">
                          {tOr('PeopleTimeOff.actions', 'Actions')}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((entry) => {
                      const k = kindOf(entry.kind);
                      return (
                        <tr key={entry.id} className="ppl-member">
                          <td>
                            <span className="ppl-cap__person">
                              <Avatar name={entry.displayName} size="compact" decorative />
                              {entry.displayName}
                            </span>
                          </td>
                          <td className="ppl-cap__num">
                            <bdi>{entry.startsOn}</bdi> – <bdi>{entry.endsOn}</bdi>
                          </td>
                          <td>
                            <StateCapsule state={k.capsule}>{tOr(k.key, k.english)}</StateCapsule>
                          </td>
                          <td>{entry.note ?? '—'}</td>
                          <td>
                            <div className="ppl-cap__row-actions">
                              <Button
                                type="button"
                                tone="destructive"
                                size="compact"
                                disabled={remove.isPending}
                                aria-label={`${tOr('PeopleTimeOff.remove', 'Remove')} ${entry.displayName} ${entry.startsOn}`}
                                onClick={() => remove.mutate(entry)}
                              >
                                {tOr('PeopleTimeOff.remove', 'Remove')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            {remove.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PeopleTimeOff.removeError', 'Not removed')}
                live
              >
                {describeError(remove.error)}
              </InlineAlert>
            ) : null}
          </div>

          <div className="ppl-cap__aside">
            <form
              className="ppl-card ppl-card--tight ppl-form"
              aria-labelledby="ppl-off-form-heading"
              onSubmit={(event) => {
                event.preventDefault();
                if (canAdd) add.mutate();
              }}
              noValidate
            >
              <h2 id="ppl-off-form-heading" className="ppl-card__title">
                {tOr('PeopleTimeOff.formTitle', 'Add time off')}
              </h2>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="ppl-off-person">
                  {tOr('PeopleTimeOff.person', 'Person')}
                </label>
                <select
                  id="ppl-off-person"
                  className="tm-field__control"
                  value={userId}
                  required
                  onChange={(event) => setUserId(event.target.value)}
                >
                  <option value="">{tOr('PeopleCapacity.choosePerson', 'Choose a person')}</option>
                  {(roster.data?.members ?? []).map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ppl-form__pair">
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="ppl-off-start">
                    {tOr('PeopleTimeOff.from', 'From')}
                  </label>
                  <input
                    id="ppl-off-start"
                    className="tm-field__control"
                    type="date"
                    value={startsOn}
                    required
                    onChange={(event) => setStartsOn(event.target.value)}
                  />
                </div>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="ppl-off-end">
                    {tOr('PeopleTimeOff.to', 'To')}
                  </label>
                  <input
                    id="ppl-off-end"
                    className="tm-field__control"
                    type="date"
                    value={endsOn}
                    min={startsOn}
                    required
                    onChange={(event) => setEndsOn(event.target.value)}
                  />
                </div>
              </div>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="ppl-off-kind">
                  {tOr('PeopleTimeOff.kind', 'Kind')}
                </label>
                <select
                  id="ppl-off-kind"
                  className="tm-field__control"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {KINDS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {tOr(item.key, item.english)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="ppl-off-note">
                  {tOr('PeopleTimeOff.noteOptional', 'Note (optional)')}
                </label>
                <input
                  id="ppl-off-note"
                  className="tm-field__control"
                  type="text"
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              {!datesValid ? (
                <p className="tm-field__hint">
                  {tOr('PeopleTimeOff.datesHint', 'The last day cannot be before the first day.')}
                </p>
              ) : null}
              {add.isError ? (
                <InlineAlert
                  tone="danger"
                  title={tOr('PeopleTimeOff.addError', 'Time off not added')}
                  live
                >
                  {describeError(add.error)}
                </InlineAlert>
              ) : null}
              <div>
                <Button type="submit" tone="ink" disabled={!canAdd || add.isPending}>
                  {tOr('PeopleTimeOff.add', 'Add time off')}
                </Button>
              </div>
            </form>
            <section
              className="ppl-card ppl-card--tight ppl-card--ink"
              aria-labelledby="ppl-off-who"
            >
              <h2 id="ppl-off-who" className="ppl-mono">
                {tOr('PeopleCapacity.whoTitle', 'Who can change this')}
              </h2>
              <p className="ppl-note ppl-note--ink">
                {tOr(
                  'PeopleTimeOff.whoBody',
                  'Admins add and remove time off. Everyone in the team can see it.',
                )}
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
