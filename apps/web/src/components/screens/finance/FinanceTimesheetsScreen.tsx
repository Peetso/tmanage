'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Field,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import {
  decideTimesheet,
  readMyTimesheet,
  readTeamWeek,
  type TeamMemberWeek,
} from '../../../lib/api/finance-core';
import {
  isCannotApproveOwn,
  isoWeekFrom,
  mayDecide,
  stateCapsule,
} from '../../../lib/finance-presentation';
import { formatDuration } from '../../../lib/i18n/duration';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { UnassignedTimeList } from '../../time/UnassignedTimeList';
import { FinanceCoreNav, useFinanceMe, usePersonName } from './FinanceCoreNav';

export interface FinanceTimesheetsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Timesheets (A10a).** The member's week (time logged on work items, grouped, with a day
 * total) and its Submit; for a `project.manage` approver, the team's week with Approve and
 * Request changes on everybody else's submitted sheet — never on their own (the API answers
 * `cannot_approve_own`).
 */
export function FinanceTimesheetsScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceTimesheetsScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const format = useDisplayFormatters();
  const locale = useActiveLocale();
  // Item 10: durations in the reader's language ("45 دقيقة", never a Latin "m" in Arabic).
  const formatMinutes = (value: number) => formatDuration(value, locale);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const { me, can } = useFinanceMe(api, organizationSlug);
  const canApprove = can('project.manage');
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [changing, setChanging] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState('');

  const mine = useQuery({
    queryKey: ['finance-timesheet-mine', organizationSlug, week],
    queryFn: () => readMyTimesheet(api, organizationSlug, week),
  });
  const team = useQuery({
    queryKey: ['finance-timesheet-team', organizationSlug, week],
    queryFn: () => readTeamWeek(api, organizationSlug, week),
    enabled: canApprove,
  });
  const nameOf = usePersonName(api, organizationSlug, me?.membershipId, canApprove);

  const decide = useMutation({
    mutationFn: (input: {
      id: string;
      action: 'submit' | 'approve' | 'request-changes';
      note?: string;
    }) => decideTimesheet(api, organizationSlug, input.id, input.action, input.note),
    onSuccess: async () => {
      setChanging(null);
      setChangeNote('');
      await queryClient.invalidateQueries({ queryKey: ['finance-timesheet-mine'] });
      await queryClient.invalidateQueries({ queryKey: ['finance-timesheet-team'] });
    },
  });

  const sheet = mine.data;
  const shift = (delta: number) => {
    if (sheet) setWeek(isoWeekFrom(sheet.periodStart, delta));
  };
  const dayTotal = (day: string): number =>
    (sheet?.groups ?? []).reduce(
      (sum, group) =>
        sum + group.entries.filter((e) => e.spentOn === day).reduce((s, e) => s + e.minutes, 0),
      0,
    );
  const stateLabel = (state: string) => tOr(`FinanceTimesheets.state.${state}`, state);
  const sheetEntries = (sheet?.groups ?? []).flatMap((group) => group.entries);
  const hasAutomatic = sheetEntries.some((entry) => entry.source === 'automatic');
  const toReview = sheetEntries.some((entry) => entry.needsReview);
  const others = (team.data?.members ?? []).filter(
    (member: TeamMemberWeek) => member.state !== 'open' || member.totalMinutes > 0,
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceCore.eyebrow', 'Finance')}
      title={tOr('FinanceTimesheets.title', 'Timesheets')}
      description={tOr(
        'FinanceTimesheets.description',
        'Review the week you logged and send it for approval.',
      )}
    >
      <div className="tm-stack">
        <FinanceCoreNav organizationSlug={organizationSlug} active="timesheets" />

        {decide.isError ? (
          isCannotApproveOwn(decide.error) ? (
            <InlineAlert
              tone="danger"
              title={tOr('FinanceTimesheets.ownTitle', 'You cannot decide on your own timesheet')}
              live
            >
              {tOr(
                'FinanceTimesheets.ownBody',
                'Someone else with approval rights must approve it.',
              )}
            </InlineAlert>
          ) : (
            <InlineAlert
              tone="danger"
              title={tOr('FinanceTimesheets.decideError', 'The timesheet was not updated')}
              live
            >
              {describeError(decide.error)}
            </InlineAlert>
          )
        ) : null}

        <section className="tm-panel tm-stack" aria-labelledby="tm-ts-mine">
          <div className="tm-row tm-row--between tm-row--wrap">
            <h2 id="tm-ts-mine" className="tm-eyebrow">
              {tOr('FinanceTimesheets.myWeek', 'My week')}
            </h2>
            <div className="tm-row">
              <Button size="compact" tone="outline" disabled={!sheet} onClick={() => shift(-1)}>
                {tOr('FinanceTimesheets.previous', 'Previous week')}
              </Button>
              {sheet ? (
                <span>
                  {format.day(sheet.periodStart)} – {format.day(sheet.periodEnd)}
                </span>
              ) : null}
              <Button size="compact" tone="outline" disabled={!sheet} onClick={() => shift(1)}>
                {tOr('FinanceTimesheets.next', 'Next week')}
              </Button>
              {sheet ? (
                <StateCapsule state={stateCapsule(sheet.state)}>
                  {stateLabel(sheet.state)}
                </StateCapsule>
              ) : null}
            </div>
          </div>

          {mine.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('FinanceTimesheets.loadError', 'The timesheet could not be loaded')}
              live
            >
              {describeError(mine.error)}
            </InlineAlert>
          ) : null}
          {mine.isPending ? (
            <LoadingRegion label={tOr('FinanceTimesheets.loading', 'Loading the week')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {sheet && sheet.groups.length === 0 ? (
            <InlineAlert
              tone="neutral"
              title={tOr('FinanceTimesheets.emptyTitle', 'No time logged this week')}
            >
              {tOr(
                'FinanceTimesheets.emptyBody',
                'Time you log on work items appears here, ready to submit.',
              )}
            </InlineAlert>
          ) : null}

          {sheet && sheet.groups.length > 0 ? (
            <div className="tm-table-scroll">
              <table className="tm-table" aria-label={tOr('FinanceTimesheets.myWeek', 'My week')}>
                <thead>
                  <tr>
                    <th scope="col">{tOr('FinanceTimesheets.work', 'Work')}</th>
                    {sheet.days.map((day) => (
                      <th key={day} scope="col">
                        {format.day(day, { weekday: 'short', day: 'numeric' })}
                      </th>
                    ))}
                    <th scope="col">{tOr('FinanceTimesheets.total', 'Total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.groups.map((group) => (
                    <tr key={`${group.projectId ?? ''}:${group.workItemId ?? ''}`}>
                      <th scope="row">
                        {/* Item 8: one name for time with no task, everywhere. */}
                        {group.title ??
                          (group.workItemId === null
                            ? tOr('Time.unassigned', 'Unassigned time')
                            : tOr('FinanceTimesheets.untitled', 'Other work'))}
                        {group.entries.some((entry) => entry.source === 'automatic') ? (
                          <>
                            {' '}
                            <Badge>{tOr('UnassignedTime.automatic', 'Automatic')}</Badge>
                          </>
                        ) : null}
                      </th>
                      {sheet.days.map((day) => {
                        const minutes = group.entries
                          .filter((entry) => entry.spentOn === day)
                          .reduce((sum, entry) => sum + entry.minutes, 0);
                        return <td key={day}>{minutes > 0 ? formatMinutes(minutes) : '—'}</td>;
                      })}
                      <td>{formatMinutes(group.minutes)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">{tOr('FinanceTimesheets.total', 'Total')}</th>
                    {sheet.days.map((day) => (
                      <td key={day}>{formatMinutes(dayTotal(day))}</td>
                    ))}
                    <td>{formatMinutes(sheet.totalMinutes)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}

          {sheet ? (
            <UnassignedTimeList api={api} organizationSlug={organizationSlug} sheet={sheet} />
          ) : null}

          {toReview ? (
            <InlineAlert
              tone="warning"
              title={tOr('FinanceTimesheets.reviewTitle', 'Some time needs review')}
            >
              {tOr(
                'FinanceTimesheets.reviewBody',
                'A day over 12 hours, a session over 6 hours without a break, or time filed late because its week was closed. Check it before you submit.',
              )}
            </InlineAlert>
          ) : null}
          {hasAutomatic ? (
            <p className="tm-field__hint">
              {tOr(
                'FinanceTimesheets.automaticNote',
                'Automatic time is reported by your own computer, not verified. Days follow the company time zone.',
              )}
            </p>
          ) : null}

          {sheet?.state === 'changes_requested' && sheet.decisionNote ? (
            <InlineAlert
              tone="warning"
              title={tOr('FinanceTimesheets.changesRequested', 'Changes requested')}
            >
              {sheet.decisionNote}
            </InlineAlert>
          ) : null}

          {sheet && (sheet.state === 'open' || sheet.state === 'changes_requested') ? (
            <div className="tm-row tm-row--wrap">
              <Button
                tone="ink"
                disabled={sheet.totalMinutes === 0 || sheet.locked || decide.isPending}
                loading={decide.isPending}
                onClick={() => decide.mutate({ id: sheet.id, action: 'submit' })}
              >
                {tOr('FinanceTimesheets.submit', 'Submit week')}
              </Button>
              <span className="tm-field__hint">
                {formatMinutes(sheet.totalMinutes)} {tOr('FinanceTimesheets.logged', 'logged')} ·{' '}
                {formatMinutes(sheet.billableMinutes)}{' '}
                {tOr('FinanceTimesheets.billable', 'billable')}
              </span>
            </div>
          ) : null}
        </section>

        {canApprove ? (
          <section className="tm-panel tm-stack" aria-labelledby="tm-ts-team">
            <h2 id="tm-ts-team" className="tm-eyebrow">
              {tOr('FinanceTimesheets.teamHeading', 'Team approvals')}
            </h2>
            {team.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('FinanceTimesheets.teamError', 'The team week could not be loaded')}
                live
              >
                {describeError(team.error)}
              </InlineAlert>
            ) : null}
            {team.isSuccess && others.length === 0 ? (
              <InlineAlert
                tone="neutral"
                title={tOr('FinanceTimesheets.teamEmpty', 'Nothing to review this week')}
              >
                {tOr(
                  'FinanceTimesheets.teamEmptyBody',
                  'Submitted timesheets from your team appear here.',
                )}
              </InlineAlert>
            ) : null}
            {others.length > 0 ? (
              <div className="tm-table-scroll">
                <table
                  className="tm-table"
                  aria-label={tOr('FinanceTimesheets.teamHeading', 'Team approvals')}
                >
                  <thead>
                    <tr>
                      <th scope="col">{tOr('FinanceTimesheets.person', 'Person')}</th>
                      <th scope="col">{tOr('FinanceTimesheets.total', 'Total')}</th>
                      <th scope="col">{tOr('FinanceTimesheets.billableHeading', 'Billable')}</th>
                      <th scope="col">{tOr('FinanceTimesheets.stateHeading', 'State')}</th>
                      <th scope="col">
                        <span className="tm-visually-hidden">
                          {tOr('FinanceExpenses.actions', 'Actions')}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {others.map((member) => {
                      const id = member.timesheetId;
                      const decidable =
                        id !== null &&
                        mayDecide(member.membershipId, me?.membershipId, true, member.state);
                      const own = member.membershipId === me?.membershipId;
                      return (
                        <tr key={member.membershipId}>
                          <th scope="row">{nameOf(member.membershipId)}</th>
                          <td>{formatMinutes(member.totalMinutes)}</td>
                          <td>{formatMinutes(member.billableMinutes)}</td>
                          <td>
                            <StateCapsule state={stateCapsule(member.state)}>
                              {stateLabel(member.state)}
                            </StateCapsule>
                          </td>
                          <td>
                            {own && member.state === 'submitted' ? (
                              <span className="tm-field__hint">
                                {tOr(
                                  'FinanceExpenses.awaitingOther',
                                  'Waiting for another approver',
                                )}
                              </span>
                            ) : null}
                            {decidable && id !== null && changing !== id ? (
                              <div className="tm-row tm-row--wrap">
                                <Button
                                  size="compact"
                                  tone="ink"
                                  disabled={decide.isPending}
                                  onClick={() => decide.mutate({ id, action: 'approve' })}
                                >
                                  {tOr('FinanceExpenses.approve', 'Approve')}
                                </Button>
                                <Button
                                  size="compact"
                                  tone="outline"
                                  disabled={decide.isPending}
                                  onClick={() => setChanging(id)}
                                >
                                  {tOr('FinanceTimesheets.requestChanges', 'Request changes')}
                                </Button>
                              </div>
                            ) : null}
                            {decidable && id !== null && changing === id ? (
                              <form
                                className="tm-row tm-row--wrap"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  if (changeNote.trim().length >= 3)
                                    decide.mutate({
                                      id,
                                      action: 'request-changes',
                                      note: changeNote.trim(),
                                    });
                                }}
                              >
                                <Field
                                  label={tOr('FinanceTimesheets.whatToChange', 'What to change')}
                                  name="changeNote"
                                  value={changeNote}
                                  minLength={3}
                                  onChange={(event) => setChangeNote(event.target.value)}
                                />
                                <Button
                                  type="submit"
                                  size="compact"
                                  tone="ink"
                                  disabled={changeNote.trim().length < 3 || decide.isPending}
                                >
                                  {tOr('FinanceTimesheets.sendBack', 'Send back')}
                                </Button>
                                <Button
                                  size="compact"
                                  tone="text"
                                  onClick={() => setChanging(null)}
                                >
                                  {tOr('FinanceCore.cancel', 'Cancel')}
                                </Button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
