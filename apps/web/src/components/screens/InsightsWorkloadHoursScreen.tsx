'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import {
  InsightsCard,
  InsightsCardHead,
  InsightsMetric,
  InsightsMetrics,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchWorkloadHours, setWorkloadCapacity } from '../../lib/api/insights-workload-hours';
import type { WorkloadHoursPerson, WorkloadHoursView } from '../../lib/api/insights-workload-hours';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appLocale } from '../../lib/i18n/app-locale';
import '../../styles/screens/insights.css';
import '../../styles/screens/insights-workload-hours.css';

export interface InsightsWorkloadHoursScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const MAX_WEEKLY_HOURS = 168;
const K = 'InsightsWorkloadHours';

/**
 * **Workload in hours** (A14) — planned hours this week against each person's weekly capacity.
 * Owners and admins edit capacity in place (`canEditCapacity` from the API, which re-checks
 * `org.manage` on the write); everyone else sees the figures read-only.
 */
export function InsightsWorkloadHoursScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightsWorkloadHoursScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const queryKey = ['insights-workload-hours', organizationSlug];

  const workload = useQuery({
    queryKey,
    queryFn: () => fetchWorkloadHours(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={tOr(`${K}.eyebrow`, 'Insights · This week')}
      title={tOr(`${K}.title`, 'Workload')}
    >
      <div className="tm-ins">
        <InsightsTabs organizationSlug={organizationSlug} current="workload" />
        <p className="tm-ins-card__body">
          {tOr(`${K}.subtitle`, "Planned hours against each person's weekly capacity.")}
        </p>

        {workload.isPending ? (
          <LoadingRegion label={tOr(`${K}.loading`, 'Loading workload')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {workload.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr(`${K}.loadErrorTitle`, 'Workload could not load')}
            live
          >
            {describe(workload.error)}
          </InlineAlert>
        ) : null}

        {workload.isSuccess ? (
          <WorkloadPanel
            view={workload.data}
            organizationSlug={organizationSlug}
            api={api}
            queryKey={queryKey}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function WorkloadPanel({
  view,
  organizationSlug,
  api,
  queryKey,
}: {
  view: WorkloadHoursView;
  organizationSlug: string;
  api: ApiClient;
  queryKey: readonly unknown[];
}) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const hoursUnit = tOr(`${K}.hoursUnit`, 'h');

  const changed = view.people.filter((person) => {
    const draft = drafts[person.membershipId];
    return draft !== undefined && draft !== String(person.capacityHours ?? '');
  });
  const allValid = changed.every((person) => isValidHours(drafts[person.membershipId] ?? ''));

  const save = useMutation({
    mutationFn: async () => {
      for (const person of changed) {
        await setWorkloadCapacity(
          api,
          organizationSlug,
          person.membershipId,
          Number(drafts[person.membershipId]),
        );
      }
    },
    onSuccess: async () => {
      setDrafts({});
      await queryClient.invalidateQueries({ queryKey: [...queryKey] });
    },
  });

  const totals = view.totals;
  const hasPlanned = view.people.some((p) => p.plannedHours > 0 || p.unscheduledHours > 0);
  const firstOver = view.people.find((p) => p.overCapacity);

  return (
    <>
      <InsightsMetrics label={tOr(`${K}.metricsLabel`, 'This week in hours')}>
        <InsightsMetric
          value={`${formatNumber(totals.plannedHours)} ${hoursUnit}`}
          label={tOr(`${K}.metricPlanned`, 'Planned hours')}
        />
        <InsightsMetric
          value={`${formatNumber(totals.capacityHours)} ${hoursUnit}`}
          label={tOr(`${K}.metricCapacity`, 'Team capacity')}
        />
        <InsightsMetric
          value={
            totals.overCapacityCount === 0
              ? tOr(`${K}.nobody`, 'Nobody')
              : totals.overCapacityCount === 1
                ? tOr(`${K}.onePerson`, '1 person')
                : `${formatNumber(totals.overCapacityCount)} ${tOr(`${K}.people`, 'people')}`
          }
          {...(totals.overCapacityCount > 0 ? { badgeTone: 'danger' as const } : {})}
          label={tOr(`${K}.metricOver`, 'Over capacity')}
        />
      </InsightsMetrics>

      <InsightsSplit
        main={
          hasPlanned ? (
            <InsightsCard variant="table" labelledBy="tm-ins-hours-heading">
              <div className="tm-ins-card__lead">
                <InsightsCardHead
                  id="tm-ins-hours-heading"
                  title={tOr(`${K}.tableTitle`, 'People')}
                  units={tOr(`${K}.tableUnits`, 'hours per week')}
                />
              </div>
              {save.isError ? (
                <InlineAlert
                  tone="danger"
                  title={tOr(`${K}.saveErrorTitle`, 'Capacity was not saved')}
                  live
                >
                  {describe(save.error)}
                </InlineAlert>
              ) : null}
              {save.isSuccess ? (
                <InlineAlert tone="success" title={tOr(`${K}.savedTitle`, 'Capacity saved')} live>
                  {tOr(`${K}.savedBody`, 'The new weekly hours apply from today.')}
                </InlineAlert>
              ) : null}
              <form
                noValidate
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  if (changed.length > 0 && allValid) save.mutate();
                }}
              >
                <table className="tm-ins-table" aria-labelledby="tm-ins-hours-heading">
                  <caption className="tm-visually-hidden">
                    {tOr(`${K}.tableCaption`, 'Planned hours and weekly capacity per person')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{tOr(`${K}.colPerson`, 'Person')}</th>
                      <th scope="col" className="tm-ins-table__num">
                        {tOr(`${K}.colPlanned`, 'Planned')}
                      </th>
                      <th scope="col">{tOr(`${K}.colCapacity`, 'Capacity (h/week)')}</th>
                      <th scope="col">{tOr(`${K}.colLoad`, 'Load')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.people.map((person) => (
                      <PersonRow
                        key={person.membershipId}
                        person={person}
                        editable={view.canEditCapacity}
                        draft={drafts[person.membershipId]}
                        onDraft={(value) =>
                          setDrafts((current) => ({ ...current, [person.membershipId]: value }))
                        }
                        hoursUnit={hoursUnit}
                      />
                    ))}
                  </tbody>
                </table>
                {view.canEditCapacity ? (
                  <div className="tm-ins-hours__actions">
                    <Button
                      type="submit"
                      disabled={changed.length === 0 || !allValid}
                      loading={save.isPending}
                    >
                      {save.isPending
                        ? tOr(`${K}.saving`, 'Saving…')
                        : tOr(`${K}.save`, 'Save capacity')}
                    </Button>
                  </div>
                ) : null}
              </form>
            </InsightsCard>
          ) : (
            <InsightsCard labelledBy="tm-ins-hours-empty">
              <div className="tm-ins-hours__empty">
                <h2 id="tm-ins-hours-empty" className="tm-ins-card__title">
                  {tOr(`${K}.emptyTitle`, 'No planned hours yet')}
                </h2>
                <p className="tm-ins-card__body">
                  {tOr(
                    `${K}.emptyBody`,
                    "Add estimates to open work to see each person's load against their capacity.",
                  )}
                </p>
                <Link
                  className="tm-button tm-button--outline tm-button--default"
                  href={`/${encodeURIComponent(organizationSlug)}/work`}
                >
                  {tOr(`${K}.emptyAction`, 'Open work')}
                </Link>
              </div>
            </InsightsCard>
          )
        }
        side={
          <>
            {firstOver && firstOver.capacityHours !== null ? (
              <InlineAlert
                tone="warning"
                title={`${firstOver.displayName} · ${formatNumber(
                  Math.round((firstOver.plannedHours - firstOver.capacityHours) * 10) / 10,
                )} ${hoursUnit} ${tOr(`${K}.overBy`, 'over capacity')}`}
              >
                {tOr(`${K}.overBody`, 'Move some work or raise their capacity for this week.')}
              </InlineAlert>
            ) : null}
            <InsightsCard>
              <InsightsCardHead
                level="h3"
                title={tOr(`${K}.noteTitle`, 'Who can change capacity')}
              />
              <p className="tm-ins-card__body">
                {tOr(`${K}.noteBody`, 'Only the workspace owner and admins can edit weekly hours.')}
              </p>
            </InsightsCard>
          </>
        }
      />
    </>
  );
}

function PersonRow({
  person,
  editable,
  draft,
  onDraft,
  hoursUnit,
}: {
  person: WorkloadHoursPerson;
  editable: boolean;
  draft: string | undefined;
  onDraft: (value: string) => void;
  hoursUnit: string;
}) {
  const tOr = useTOr();
  const value = draft ?? (person.capacityHours === null ? '' : String(person.capacityHours));
  const invalid = draft !== undefined && draft !== '' && !isValidHours(draft);
  const percent = person.utilisation === null ? null : Math.round(person.utilisation * 100);
  return (
    <tr data-tone={person.overCapacity ? 'danger' : 'quiet'}>
      <th scope="row">
        <span className="tm-ins-hours__person">
          <Avatar name={person.displayName} size="compact" decorative />
          {person.displayName}
        </span>
      </th>
      <td
        className={['tm-ins-table__num', person.overCapacity ? 'tm-ins-hours__over' : ''].join(' ')}
      >
        {formatNumber(person.plannedHours)} {hoursUnit}
      </td>
      <td>
        {editable ? (
          <Field
            className="tm-ins-hours__input"
            label={
              <span className="tm-visually-hidden">
                {tOr(`${K}.capacityFor`, 'Weekly hours for')} {person.displayName}
              </span>
            }
            name={`capacity-${person.membershipId}`}
            type="number"
            min={0}
            max={MAX_WEEKLY_HOURS}
            step={1}
            inputMode="numeric"
            value={value}
            onChange={(event) => onDraft(event.target.value)}
            error={invalid ? tOr(`${K}.hoursError`, 'Enter whole hours from 0 to 168.') : undefined}
          />
        ) : person.capacityHours === null ? (
          tOr(`${K}.notSet`, 'Not set')
        ) : (
          `${formatNumber(person.capacityHours)} ${hoursUnit}`
        )}
      </td>
      <td>
        {percent === null ? (
          <span className="tm-ins-hours__pct">{tOr(`${K}.noCapacity`, 'No capacity set')}</span>
        ) : (
          <span className="tm-ins-hours__load" data-over={person.overCapacity || undefined}>
            <span className="tm-ins-hours__track" aria-hidden="true">
              <span
                className="tm-ins-hours__fill"
                style={{ inlineSize: `${Math.min(100, percent)}%` }}
              />
            </span>
            <span className="tm-ins-hours__pct">{formatNumber(percent)}%</span>
            {person.overCapacity ? (
              <span className="tm-ins-badge" data-tone="danger">
                {tOr(`${K}.over`, 'Over')}
              </span>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  );
}

function isValidHours(raw: string): boolean {
  if (raw.trim() === '') return false;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_WEEKLY_HOURS;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat(appLocale(), { maximumFractionDigits: 1 }).format(n);
}
