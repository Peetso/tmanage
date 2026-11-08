'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { createPersonAllocation } from '../../../lib/api/person-allocations';
import { listProjects } from '../../../lib/api/projects';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useTOr } from '../../../lib/i18n/use-t-or';
import {
  confirmAllocation,
  getCapacityRoster,
  listOrgAllocations,
  removeAllocation,
} from './PeopleOverviewApi';
import type { OverviewAllocation } from './PeopleOverviewApi';
import { PeopleCapacityTabs } from './PeopleCapacityTabs';
import '../../../styles/screens/people.css';
import '../../../styles/screens/people-capacity.css';

export interface PeopleAllocationsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * **People · Allocations (A13).** Who is allocated to which project, how much, and when — from
 * `GET …/people/allocations` (`work.read`, narrowed to the projects the caller may read). Assigning,
 * confirming a tentative allocation and removing one use the per-project
 * `…/projects/:projectId/allocations` endpoints (`project.manage`).
 */
export function PeopleAllocationsScreen({
  organizationSlug,
  organizationName,
  client,
}: PeopleAllocationsScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const allocations = useQuery({
    queryKey: ['people-allocations', organizationSlug],
    queryFn: () => listOrgAllocations(api, organizationSlug),
  });
  const roster = useQuery({
    queryKey: ['people-capacity-roster', organizationSlug],
    queryFn: () => getCapacityRoster(api, organizationSlug),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const [membershipId, setMembershipId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [percent, setPercent] = useState('50');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const percentValue = Number(percent);
  const percentValid = Number.isInteger(percentValue) && percentValue >= 1 && percentValue <= 100;
  const datesValid =
    (startDate === '' || DATE.test(startDate)) &&
    (endDate === '' || DATE.test(endDate)) &&
    (startDate === '' || endDate === '' || endDate >= startDate);
  const canAdd = membershipId !== '' && projectId !== '' && percentValid && datesValid;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['people-allocations', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['people-capacity-roster', organizationSlug] }),
    ]);

  const add = useMutation({
    mutationFn: () =>
      createPersonAllocation(api, organizationSlug, projectId, {
        membershipId,
        percent: percentValue,
        ...(startDate !== '' ? { startDate } : {}),
        ...(endDate !== '' ? { endDate } : {}),
      }),
    onSuccess: refresh,
  });
  const confirm = useMutation({
    mutationFn: (row: OverviewAllocation) =>
      confirmAllocation(api, organizationSlug, row.projectId, row.id),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (row: OverviewAllocation) =>
      removeAllocation(api, organizationSlug, row.projectId, row.id),
    onSuccess: refresh,
  });

  const list = allocations.data ?? [];
  const openProjects = (projects.data ?? []).filter((project) => project.archivedAt === null);
  const rowError = confirm.error ?? remove.error;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={tOr('PeopleAllocations.eyebrow', 'People · Next 90 days')}
      title={tOr('PeopleAllocations.title', 'Allocations')}
      description={tOr(
        'PeopleAllocations.description',
        'Who works on which project, and how much of their week it takes.',
      )}
    >
      <div className="ppl-cap">
        <PeopleCapacityTabs organizationSlug={organizationSlug} current="allocations" />
        <div className="ppl-cap__body">
          <div className="ppl-cap__main">
            {allocations.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PeopleAllocations.loadError', 'Allocations not loaded')}
                live
              >
                {describeError(allocations.error)}
              </InlineAlert>
            ) : null}
            {allocations.isPending ? (
              <LoadingRegion label={tOr('PeopleAllocations.loading', 'Loading allocations')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {allocations.isSuccess && list.length === 0 ? (
              <section className="ppl-cap__empty" aria-labelledby="ppl-alloc-empty-heading">
                <h2 id="ppl-alloc-empty-heading">
                  {tOr('PeopleAllocations.emptyTitle', 'No one is allocated yet')}
                </h2>
                <p>
                  {tOr(
                    'PeopleAllocations.emptyBody',
                    'Give a person a share of their week on a project. Capacity and the heatmap add it up.',
                  )}
                </p>
              </section>
            ) : null}
            {allocations.isSuccess && list.length > 0 ? (
              <div className="ppl-members-card">
                <table className="ppl-members">
                  <caption className="tm-visually-hidden">
                    {tOr('PeopleAllocations.tableCaption', 'Allocations in the next 90 days')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{tOr('PeopleAllocations.person', 'Person')}</th>
                      <th scope="col">{tOr('PeopleAllocations.project', 'Project')}</th>
                      <th scope="col">{tOr('PeopleAllocations.share', 'Share')}</th>
                      <th scope="col">{tOr('PeopleAllocations.dates', 'Dates')}</th>
                      <th scope="col">{tOr('PeopleAllocations.status', 'Status')}</th>
                      <th scope="col">
                        <span className="tm-visually-hidden">
                          {tOr('PeopleAllocations.actions', 'Actions')}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((row) => {
                      const tentative = row.status === 'tentative';
                      return (
                        <tr key={row.id} className="ppl-member">
                          <td>
                            <span className="ppl-cap__person">
                              <Avatar name={row.displayName} size="compact" decorative />
                              {row.displayName}
                            </span>
                          </td>
                          <td>{row.projectName}</td>
                          <td className="ppl-cap__num">
                            {row.hoursPerWeek !== null
                              ? `${row.hoursPerWeek} ${tOr('PeopleCapacity.hoursShort', 'h')}`
                              : `${row.percent} %`}
                          </td>
                          <td className="ppl-cap__num">
                            <bdi>{row.startDate ?? tOr('PeopleAllocations.open', 'Open')}</bdi> –{' '}
                            <bdi>{row.endDate ?? tOr('PeopleAllocations.open', 'Open')}</bdi>
                          </td>
                          <td>
                            <StateCapsule state={tentative ? 'waiting' : 'done'}>
                              {tentative
                                ? tOr('PeopleAllocations.tentative', 'Tentative')
                                : tOr('PeopleAllocations.confirmed', 'Confirmed')}
                            </StateCapsule>
                          </td>
                          <td>
                            <div className="ppl-cap__row-actions">
                              {tentative ? (
                                <Button
                                  type="button"
                                  tone="outline"
                                  size="compact"
                                  disabled={confirm.isPending}
                                  aria-label={`${tOr('PeopleAllocations.confirm', 'Confirm')} ${row.displayName} ${row.projectName}`}
                                  onClick={() => confirm.mutate(row)}
                                >
                                  {tOr('PeopleAllocations.confirm', 'Confirm')}
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                tone="destructive"
                                size="compact"
                                disabled={remove.isPending}
                                aria-label={`${tOr('PeopleAllocations.remove', 'Remove')} ${row.displayName} ${row.projectName}`}
                                onClick={() => remove.mutate(row)}
                              >
                                {tOr('PeopleAllocations.remove', 'Remove')}
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
            {rowError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PeopleAllocations.changeError', 'Allocation not changed')}
                live
              >
                {describeError(rowError)}
              </InlineAlert>
            ) : null}
          </div>

          <div className="ppl-cap__aside">
            <form
              className="ppl-card ppl-card--tight ppl-form"
              aria-labelledby="ppl-alloc-form-heading"
              onSubmit={(event) => {
                event.preventDefault();
                if (canAdd) add.mutate();
              }}
              noValidate
            >
              <h2 id="ppl-alloc-form-heading" className="ppl-card__title">
                {tOr('PeopleAllocations.formTitle', 'Allocate a person')}
              </h2>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="ppl-alloc-person">
                  {tOr('PeopleAllocations.person', 'Person')}
                </label>
                <select
                  id="ppl-alloc-person"
                  className="tm-field__control"
                  value={membershipId}
                  required
                  onChange={(event) => setMembershipId(event.target.value)}
                >
                  <option value="">{tOr('PeopleCapacity.choosePerson', 'Choose a person')}</option>
                  {(roster.data?.members ?? []).map((member) => (
                    <option key={member.membershipId} value={member.membershipId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="ppl-alloc-project">
                  {tOr('PeopleAllocations.project', 'Project')}
                </label>
                <select
                  id="ppl-alloc-project"
                  className="tm-field__control"
                  value={projectId}
                  required
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">
                    {tOr('PeopleAllocations.chooseProject', 'Choose a project')}
                  </option>
                  {openProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="ppl-alloc-percent">
                  {tOr('PeopleAllocations.percent', 'Share of the week (%)')}
                </label>
                <input
                  id="ppl-alloc-percent"
                  className="tm-field__control"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  step={1}
                  value={percent}
                  required
                  onChange={(event) => setPercent(event.target.value)}
                />
              </div>
              <div className="ppl-form__pair">
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="ppl-alloc-start">
                    {tOr('PeopleAllocations.startOptional', 'From (optional)')}
                  </label>
                  <input
                    id="ppl-alloc-start"
                    className="tm-field__control"
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </div>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="ppl-alloc-end">
                    {tOr('PeopleAllocations.endOptional', 'To (optional)')}
                  </label>
                  <input
                    id="ppl-alloc-end"
                    className="tm-field__control"
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </div>
              </div>
              {add.isError ? (
                <InlineAlert
                  tone="danger"
                  title={tOr('PeopleAllocations.addError', 'Allocation not added')}
                  live
                >
                  {describeError(add.error)}
                </InlineAlert>
              ) : null}
              <div>
                <Button type="submit" tone="ink" disabled={!canAdd || add.isPending}>
                  {tOr('PeopleAllocations.add', 'Allocate')}
                </Button>
              </div>
            </form>
            <section
              className="ppl-card ppl-card--tight ppl-card--ink"
              aria-labelledby="ppl-alloc-who"
            >
              <h2 id="ppl-alloc-who" className="ppl-mono">
                {tOr('PeopleCapacity.whoTitle', 'Who can change this')}
              </h2>
              <p className="ppl-note ppl-note--ink">
                {tOr(
                  'PeopleAllocations.whoBody',
                  'Project managers allocate people on their projects. You see the projects you work on.',
                )}
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
