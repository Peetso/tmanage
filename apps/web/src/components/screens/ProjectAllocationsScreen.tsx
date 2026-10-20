'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { createPersonAllocation, listPersonAllocations } from '../../lib/api/person-allocations';
import type { PersonAllocationSummary } from '../../lib/api/person-allocations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

type Translate = ReturnType<typeof useT>;

export interface ProjectAllocationsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose allocations this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

/**
 * **Project allocations (x171).**
 *
 * `38-MODULE-MAP` §People & capacity: who is allocated to this project, and for what share of their
 * time. This screen assigns a member (by membership id) a percentage to the project and lists the
 * project's allocations in creation order. It reads `GET …/projects/:id/allocations` and writes
 * `POST …/allocations`, gated on the server by `project.manage` (assign) and `work.read` (list).
 *
 * As on the sibling project screens, **authorization is the API's**: a caller without the capability
 * gets the ordinary refusal, which `describeError()` turns into a sentence; the screen never guesses a
 * capability of its own and never renders blank on a refusal.
 */
export function ProjectAllocationsScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectAllocationsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [membershipId, setMembershipId] = useState('');
  const [percent, setPercent] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const allocations = useQuery({
    queryKey: ['person-allocations', organizationSlug, projectId],
    queryFn: () => listPersonAllocations(api, organizationSlug, projectId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['person-allocations', organizationSlug, projectId],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createPersonAllocation(api, organizationSlug, projectId, {
        membershipId: membershipId.trim(),
        percent: Number(percent),
        ...(startDate.trim() === '' ? {} : { startDate: startDate.trim() }),
        ...(endDate.trim() === '' ? {} : { endDate: endDate.trim() }),
      }),
    onSuccess: async () => {
      setMembershipId('');
      setPercent('');
      setStartDate('');
      setEndDate('');
      await refetch();
    },
  });

  const rows = useMemo(() => allocations.data ?? [], [allocations.data]);
  const percentValue = Number(percent);
  const percentValid =
    percent.trim() !== '' &&
    Number.isInteger(percentValue) &&
    percentValue >= 1 &&
    percentValue <= 100;
  const canSubmit = membershipId.trim() !== '' && percentValid;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || create.isPending) return;
    create.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('ProjectAllocationsScreen.title')}
      description={t('ProjectAllocationsScreen.description')}
      eyebrow={t('ProjectAllocationsScreen.eyebrow')}
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="team" />
      }
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-allocations-author">
              <h2 id="tm-allocations-author" className="tm-prj-eyebrow">
                {t('ProjectAllocationsScreen.assignMemberHeading')}
              </h2>
              <form className="tm-stack" onSubmit={onSubmit} noValidate>
                <fieldset
                  className="tm-fieldset tm-stack tm-stack--loose"
                  disabled={create.isPending}
                >
                  <Field
                    label={t('ProjectAllocationsScreen.membershipLabel')}
                    name="membershipId"
                    value={membershipId}
                    onChange={(event) => setMembershipId(event.target.value)}
                    hint={t('ProjectAllocationsScreen.membershipHint')}
                    required
                  />

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-allocation-percent">
                      {t('ProjectAllocationsScreen.percentLabel')}
                    </label>
                    <input
                      id="tm-allocation-percent"
                      name="percent"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      inputMode="numeric"
                      className="tm-field__control"
                      value={percent}
                      onChange={(event) => setPercent(event.target.value)}
                      aria-describedby="tm-allocation-percent-hint"
                      required
                    />
                    <span className="tm-field__hint" id="tm-allocation-percent-hint">
                      {t('ProjectAllocationsScreen.percentHint')}
                    </span>
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-allocation-start">
                      {t('ProjectAllocationsScreen.startDateLabel')}
                    </label>
                    <input
                      id="tm-allocation-start"
                      name="startDate"
                      type="date"
                      className="tm-field__control"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                      aria-describedby="tm-allocation-start-hint"
                    />
                    <span className="tm-field__hint" id="tm-allocation-start-hint">
                      {t('ProjectAllocationsScreen.startDateHint')}
                    </span>
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-allocation-end">
                      {t('ProjectAllocationsScreen.endDateLabel')}
                    </label>
                    <input
                      id="tm-allocation-end"
                      name="endDate"
                      type="date"
                      className="tm-field__control"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                      aria-describedby="tm-allocation-end-hint"
                    />
                    <span className="tm-field__hint" id="tm-allocation-end-hint">
                      {t('ProjectAllocationsScreen.endDateHint')}
                    </span>
                  </div>
                </fieldset>

                {create.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('ProjectAllocationsScreen.couldNotAssign')}
                    live
                  >
                    {describeError(create.error, t)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('ProjectAllocationsScreen.saving')}
                    disabled={!canSubmit}
                  >
                    {t('ProjectAllocationsScreen.assignButton')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <div className="tm-prj__col">
            {allocations.isError ? (
              <InlineAlert tone="danger" title={t('ProjectAllocationsScreen.couldNotLoad')} live>
                {describeError(allocations.error, t)}
              </InlineAlert>
            ) : null}

            {allocations.isPending ? (
              <LoadingRegion label={t('ProjectAllocationsScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!allocations.isPending && !allocations.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title={t('ProjectAllocationsScreen.noAllocationsTitle')}>
                {t('ProjectAllocationsScreen.noAllocationsBody')}
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <section className="tm-card tm-prj-card" aria-labelledby="tm-allocations-heading">
                <h2 id="tm-allocations-heading" className="tm-prj-eyebrow">
                  {t('ProjectAllocationsScreen.allocationsHeading')}
                </h2>
                <div
                  className="tm-table-scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
                  // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('ProjectAllocationsScreen.tableAria')}
                >
                  <table className="tm-table">
                    <caption className="tm-visually-hidden">
                      {t('ProjectAllocationsScreen.captionLead')} {rows.length}{' '}
                      {t('ProjectAllocationsScreen.captionTail')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ProjectAllocationsScreen.colMembership')}</th>
                        <th scope="col">{t('ProjectAllocationsScreen.colPercent')}</th>
                        <th scope="col">{t('ProjectAllocationsScreen.colStart')}</th>
                        <th scope="col">{t('ProjectAllocationsScreen.colEnd')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((allocation) => (
                        <AllocationRow key={allocation.id} allocation={allocation} t={t} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function AllocationRow({ allocation, t }: { allocation: PersonAllocationSummary; t: Translate }) {
  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {allocation.membershipId}
      </th>
      <td>{allocation.percent}%</td>
      <td>{allocation.startDate ?? <span className="tm-field__hint">—</span>}</td>
      <td>
        {allocation.endDate ?? (
          <span className="tm-field__hint">{t('ProjectAllocationsScreen.ongoing')}</span>
        )}
      </td>
    </tr>
  );
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectAllocationsScreen.apiError');
  return t('ProjectAllocationsScreen.genericError');
}
