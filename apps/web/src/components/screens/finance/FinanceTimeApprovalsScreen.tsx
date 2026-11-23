'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import {
  decideTimeEntry,
  listTimeApprovals,
  type TimeTrustEntry,
} from '../../../lib/api/time-trust';
import { formatDuration } from '../../../lib/i18n/duration';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { TimeTrustBadges, reasonValid } from '../../time/TimeTrustParts';
import { FinanceCoreNav, useFinanceMe, usePersonName } from './FinanceCoreNav';

export interface FinanceTimeApprovalsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const queueKey = (slug: string) => ['time-approvals', slug] as const;

/**
 * Time you can trust (owner rule, 2026-11-23) — the managers' queue. Time added by hand,
 * corrections of timer time and timers stopped at the idle cap, each with who, when, how much and
 * why. Approve counts it; Refuse (with a note the person reads) never does. Never one's own entry:
 * the API lists only what the caller may decide.
 */
export function FinanceTimeApprovalsScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceTimeApprovalsScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const format = useDisplayFormatters();
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const { me, can } = useFinanceMe(api, organizationSlug);
  const mayApprove = can('project.manage');
  const nameOf = usePersonName(api, organizationSlug, me?.membershipId, mayApprove);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const queue = useQuery({
    queryKey: queueKey(organizationSlug),
    queryFn: () => listTimeApprovals(api, organizationSlug),
    enabled: mayApprove,
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; approve: boolean; note?: string }) =>
      decideTimeEntry(api, organizationSlug, input.id, input.approve, input.note),
    onSuccess: async () => {
      setRefusing(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: queueKey(organizationSlug) });
    },
  });

  const kindOf = (entry: TimeTrustEntry): string =>
    entry.source === 'correction'
      ? tOr('TimeApprovals.kindCorrection', 'Correction of timer time')
      : entry.trust === 'measured'
        ? tOr('TimeApprovals.kindCapped', 'Timer stopped at the limit')
        : tOr('TimeApprovals.kindHand', 'Added by hand');

  const entries = queue.data?.entries ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceCore.eyebrow', 'Finance')}
      title={tOr('TimeApprovals.title', 'Time to approve')}
      description={tOr(
        'TimeApprovals.description',
        'Time typed in by hand, corrections and forgotten timers count only once you approve them.',
      )}
    >
      <div className="tm-stack">
        <FinanceCoreNav organizationSlug={organizationSlug} active="time-approvals" />

        {decide.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('TimeApprovals.decideError', 'The decision was not saved')}
            live
          >
            {describeError(decide.error)}
          </InlineAlert>
        ) : null}

        <section className="tm-panel tm-stack" aria-labelledby="tm-time-approvals">
          <div className="tm-row tm-row--between tm-row--wrap">
            <h2 id="tm-time-approvals" className="tm-eyebrow">
              {tOr('TimeApprovals.heading', 'Waiting for you')}
            </h2>
            {queue.data && queue.data.pendingMinutes > 0 ? (
              <span className="tm-badge">
                {formatDuration(queue.data.pendingMinutes, locale)}{' '}
                {tOr('TimeTrust.waitingShort', 'waiting')}
              </span>
            ) : null}
          </div>

          {!mayApprove && me !== undefined ? (
            <InlineAlert tone="neutral">
              {tOr('TimeApprovals.notManager', 'Project leads and admins approve time here.')}
            </InlineAlert>
          ) : null}
          {queue.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('TimeApprovals.loadError', 'The list could not be loaded')}
              live
            >
              {describeError(queue.error)}
            </InlineAlert>
          ) : null}
          {mayApprove && queue.isPending ? (
            <LoadingRegion label={tOr('TimeApprovals.loading', 'Loading time to approve')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}
          {queue.isSuccess && entries.length === 0 ? (
            <InlineAlert
              tone="neutral"
              title={tOr('TimeApprovals.emptyTitle', 'Nothing to approve')}
            >
              {tOr(
                'TimeApprovals.emptyBody',
                'When someone adds time by hand or asks to correct timer time, it appears here.',
              )}
            </InlineAlert>
          ) : null}

          {entries.length > 0 ? (
            <ul className="tm-stack tm-list">
              {entries.map((entry) => (
                <li key={entry.id} className="tm-stack tm-list__item">
                  <div className="tm-row tm-row--between tm-row--wrap">
                    <span>
                      <strong>{nameOf(entry.membershipId)}</strong> ·{' '}
                      <strong>{formatDuration(entry.minutes, locale)}</strong> ·{' '}
                      <bdi>{format.day(entry.spentOn)}</bdi>
                      {entry.workItemTitle ? <> · {entry.workItemTitle}</> : null}
                      <TimeTrustBadges entry={entry} />
                      <span className="tm-field__hint">
                        {' '}
                        {kindOf(entry)}
                        {entry.reason ? ` — ${entry.reason}` : ''}
                      </span>
                    </span>
                    {entry.mayDecide && refusing !== entry.id ? (
                      <span className="tm-row">
                        <Button
                          tone="outline"
                          disabled={decide.isPending}
                          onClick={() => {
                            setNote('');
                            setRefusing(entry.id);
                          }}
                        >
                          {tOr('TimeApprovals.refuse', 'Refuse')}
                        </Button>
                        <Button
                          tone="ink"
                          disabled={decide.isPending}
                          loading={decide.isPending && decide.variables?.id === entry.id}
                          onClick={() => decide.mutate({ id: entry.id, approve: true })}
                        >
                          {tOr('TimeApprovals.approve', 'Approve')}
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  {refusing === entry.id ? (
                    <div className="tm-stack">
                      <Field
                        label={tOr('TimeApprovals.noteLabel', 'Why are you refusing it?')}
                        name="refuseNote"
                        value={note}
                        maxLength={500}
                        onChange={(event) => setNote(event.target.value)}
                        hint={tOr('TimeApprovals.noteHint', 'The person reads this.')}
                        required
                      />
                      <div className="tm-row">
                        <Button tone="outline" onClick={() => setRefusing(null)}>
                          {tOr('TimeTrust.cancel', 'Cancel')}
                        </Button>
                        <Button
                          tone="destructive"
                          disabled={!reasonValid(note) || decide.isPending}
                          loading={decide.isPending}
                          onClick={() =>
                            decide.mutate({ id: entry.id, approve: false, note: note.trim() })
                          }
                        >
                          {tOr('TimeApprovals.refuseConfirm', 'Refuse this time')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
