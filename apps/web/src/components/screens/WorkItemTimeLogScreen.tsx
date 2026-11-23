'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { deleteTimeLog, listTimeLogs, type TimeLog } from '../../lib/api/work-items';
import { addTimeLogOrQueue } from '../../lib/offline/write-or-queue';
import { usePendingWrites } from '../../lib/offline/use-offline';
import { PendingBadge } from '../pwa/PendingBadge';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useTOr } from '../../lib/i18n/use-t-or';
import { formatDuration } from '../../lib/i18n/duration';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import {
  CorrectionForm,
  HandTimeOffNotice,
  HandTimeReasonField,
  TimeTrustBadges,
  reasonValid,
  useTimeTrustPolicy,
} from '../time/TimeTrustParts';

export interface WorkItemTimeLogScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/** One day of effort, in minutes; the API bounds the same range and answers 400 beyond it. */
const MAX_MINUTES = 24 * 60;

/**
 * **Work item time tracking (module 7, x231).**
 *
 * `38-MODULE-MAP` §Work — the audit's "Work built; no time/effort logging". Logged effort for one
 * work item: a person records minutes spent on a calendar day with an optional note, the screen
 * lists the entries newest day first and shows a summed total, and the author may remove an entry
 * they logged. There is no per-entry edit — the API grants log/list/delete-own only this slice.
 */
export function WorkItemTimeLogScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemTimeLogScreenProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const tr = useTOr();
  const locale = useActiveLocale();
  // UX test 2026-11-15: durations in the reader's language, not "45m".
  const formatMinutes = (total: number): string => formatDuration(total, locale);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const logs = useQuery({
    queryKey: ['work-item-time-logs', organizationSlug, workItemId],
    queryFn: () => listTimeLogs(api, organizationSlug, workItemId),
  });

  const [minutes, setMinutes] = useState('');
  const [spentOn, setSpentOn] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [correcting, setCorrecting] = useState<string | null>(null);
  // 2026-11-23 time trust: hand time only when the owner allows it, with a reason.
  const policy = useTimeTrustPolicy(api, organizationSlug);
  const handAllowed = policy.data?.handTimeAllowed === true;
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
  });

  const parsedMinutes = Number(minutes);
  const minutesValid =
    minutes.trim() !== '' &&
    Number.isInteger(parsedMinutes) &&
    parsedMinutes > 0 &&
    parsedMinutes <= MAX_MINUTES;
  const spentOnValid = /^\d{4}-\d{2}-\d{2}$/.test(spentOn);

  const add = useMutation({
    // 53-16: offline the entry is queued (Pending badge) and sent when the connection is back.
    mutationFn: () =>
      addTimeLogOrQueue(api, organizationSlug, workItemId, {
        minutes: parsedMinutes,
        spentOn,
        note: note.trim() === '' ? null : note.trim(),
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      setMinutes('');
      setSpentOn('');
      setNote('');
      setReason('');
      await queryClient.invalidateQueries({
        queryKey: ['work-item-time-logs', organizationSlug, workItemId],
      });
    },
  });

  const remove = useMutation({
    mutationFn: (entryId: string) => deleteTimeLog(api, organizationSlug, workItemId, entryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['work-item-time-logs', organizationSlug, workItemId],
      });
    },
  });

  const entries = logs.data?.entries ?? [];
  const pendingEntries = usePendingWrites(organizationSlug, workItemId, 'time-log');
  const totalMinutes = logs.data?.totalMinutes ?? 0;
  const canAdd = minutesValid && spentOnValid && reasonValid(reason) && !add.isPending;
  const pendingMinutes = logs.data?.pendingMinutes ?? 0;
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ['work-item-time-logs', organizationSlug, workItemId],
    });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('WorkItemTimeLogScreen.eyebrow')}
      title={t('WorkItemTimeLogScreen.title')}
      description={t('WorkItemTimeLogScreen.description')}
    >
      <div className="tm-wk-page tm-stack">
        <nav className="tm-segmented tm-wk-subnav" aria-label={t('WorkItemTimeLogScreen.subnav')}>
          <Link href={`/${organizationSlug}/work/${workItemId}`}>
            {t('WorkItemTimeLogScreen.overview')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/activity`}>
            {t('WorkItemTimeLogScreen.activity')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/links`}>
            {tr('WorkItemLinks.tab', 'Links')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/time-logs`} aria-current="page">
            {t('WorkItemTimeLogScreen.time')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/estimate`}>
            {t('WorkItemTimeLogScreen.estimate')}
          </Link>
        </nav>
        <section className="tm-panel tm-stack" aria-labelledby="tm-time-new-heading">
          <h2 id="tm-time-new-heading" className="tm-eyebrow">
            {t('WorkItemTimeLogScreen.logTimeHeading')}
          </h2>
          {policy.isSuccess && !handAllowed ? <HandTimeOffNotice /> : null}
          <form
            ref={firstStep}
            className="tm-stack"
            hidden={!handAllowed}
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canAdd) add.mutate();
            }}
          >
            <Field
              label={t('WorkItemTimeLogScreen.minutesLabel')}
              name="minutes"
              type="number"
              min={1}
              max={MAX_MINUTES}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              hint={`${t('WorkItemTimeLogScreen.minutesHint')} ${MAX_MINUTES}.`}
              required
            />
            <Field
              label={t('WorkItemTimeLogScreen.dayLabel')}
              name="spentOn"
              type="date"
              value={spentOn}
              onChange={(event) => setSpentOn(event.target.value)}
              hint={t('WorkItemTimeLogScreen.dayHint')}
              required
            />
            <Field
              label={t('WorkItemTimeLogScreen.noteLabel')}
              name="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              hint={t('WorkItemTimeLogScreen.noteHint')}
            />
            <HandTimeReasonField
              value={reason}
              onChange={setReason}
              afterApproval={policy.data?.handTimeCountMode !== 'at_once_flagged'}
            />
            {add.isError ? (
              <InlineAlert tone="danger" title={t('WorkItemTimeLogScreen.logError')} live>
                {describeError(add.error)}
              </InlineAlert>
            ) : null}
            <div className="tm-row">
              <Button type="submit" tone="ink" disabled={!canAdd} loading={add.isPending}>
                {t('WorkItemTimeLogScreen.logTime')}
              </Button>
            </div>
          </form>
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-time-list-heading">
          <div className="tm-row tm-row--between">
            <h2 id="tm-time-list-heading" className="tm-eyebrow">
              {t('WorkItemTimeLogScreen.loggedEffort')}
            </h2>
            <span className="tm-badge" aria-label={t('WorkItemTimeLogScreen.totalAria')}>
              {formatMinutes(totalMinutes)} {t('WorkItemTimeLogScreen.total')}
            </span>
            {pendingMinutes > 0 ? (
              <span className="tm-badge">
                {formatMinutes(pendingMinutes)} {tr('TimeTrust.waitingShort', 'waiting')}
              </span>
            ) : null}
          </div>

          {logs.isError ? (
            <InlineAlert tone="danger" title={t('WorkItemTimeLogScreen.loadError')} live>
              {describeError(logs.error)}
            </InlineAlert>
          ) : null}

          {logs.isPending ? (
            <LoadingRegion label={t('WorkItemTimeLogScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!logs.isPending && !logs.isError && entries.length === 0 ? (
            <TeachingEmptyState
              title={t('WorkItemTimeLogScreen.emptyTitle')}
              explanation={t('teachEmpty.workItemTimeLogBody')}
              action={
                // The button focuses the hand-time form; with hand time off that form is hidden
                // and the notice above says why, so the empty state only teaches.
                canUse('work.update') && handAllowed ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.workItemTimeLogAction')}
                  </Button>
                ) : undefined
              }
              helpSlug="log-time-timesheets"
              helpLabel={t('teachEmpty.howTimeWorks')}
            />
          ) : null}

          {!logs.isPending && !logs.isError && entries.length > 0 ? (
            <ul className="tm-stack tm-list">
              {entries.map((entry: TimeLog) => (
                <li key={entry.id} className="tm-stack tm-list__item">
                  <div className="tm-row tm-row--between tm-row--wrap">
                    <span>
                      <strong>{formatMinutes(entry.minutes)}</strong>{' '}
                      {t('WorkItemTimeLogScreen.on')} {entry.spentOn}
                      {entry.note ? ` — ${entry.note}` : ''}
                      <TimeTrustBadges entry={entry} />
                      {entry.reason ? (
                        <span className="tm-field__hint"> {entry.reason}</span>
                      ) : null}
                    </span>
                    <span className="tm-row">
                      {entry.trust === 'measured' &&
                      entry.counted &&
                      entry.loggedBy === me.data?.membershipId &&
                      correcting !== entry.id ? (
                        <Button tone="outline" onClick={() => setCorrecting(entry.id)}>
                          {tr('TimeTrust.correctOpen', 'Ask for a correction')}
                        </Button>
                      ) : null}
                      {entry.approvalState === 'approved' ? null : (
                        <Button
                          tone="destructive"
                          onClick={() => remove.mutate(entry.id)}
                          disabled={remove.isPending}
                          aria-label={`${t('WorkItemTimeLogScreen.deletePrefix')} ${formatMinutes(entry.minutes)} ${t('WorkItemTimeLogScreen.entryOn')} ${entry.spentOn}`}
                        >
                          {t('WorkItemTimeLogScreen.delete')}
                        </Button>
                      )}
                    </span>
                  </div>
                  {correcting === entry.id ? (
                    <CorrectionForm
                      api={api}
                      organizationSlug={organizationSlug}
                      entryId={entry.id}
                      measuredMinutes={entry.minutes}
                      onCancel={() => setCorrecting(null)}
                      onDone={() => {
                        setCorrecting(null);
                        void refresh();
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {pendingEntries.length > 0 ? (
            <ul className="tm-stack tm-list">
              {pendingEntries.map((write) => (
                <li key={write.id} className="tm-pending-row tm-list__item">
                  <span>
                    <strong>{formatMinutes(write.payload.minutes)}</strong>{' '}
                    {t('WorkItemTimeLogScreen.on')} {write.payload.spentOn}
                    {write.payload.note ? ` — ${write.payload.note}` : ''}
                  </span>
                  <PendingBadge conflict={write.status === 'conflict'} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
