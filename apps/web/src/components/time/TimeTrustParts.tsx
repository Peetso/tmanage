'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import { readTimeTrustPolicy, requestTimeCorrection, timeTrustKey } from '../../lib/api/time-trust';
import { useTOr } from '../../lib/i18n/use-t-or';

/**
 * Time you can trust (owner rule, 2026-11-23) — the pieces every "Log time" surface shares: the
 * owner's policy read, the labels on an entry, the plain explanation when hand time is off, and
 * the correction form for timer time. One place, so the work item page and My Day say the same.
 */

/** The owner's rules, from the cache Admin > Time fills. */
export function useTimeTrustPolicy(api: ApiClient, organizationSlug: string) {
  return useQuery({
    queryKey: timeTrustKey(organizationSlug),
    queryFn: () => readTimeTrustPolicy(api, organizationSlug),
    staleTime: 60_000,
  });
}

/** The fields of an entry the labels read (a work-item time log or a timesheet entry). */
export interface TrustFacts {
  readonly trust: 'measured' | 'hand';
  readonly source: 'manual' | 'timer' | 'automatic' | 'correction';
  readonly approvalState: 'none' | 'pending' | 'approved' | 'rejected';
  readonly counted: boolean;
  readonly edited?: boolean;
}

/** How the minutes came in and whether they count yet, in words a manager and a member share. */
export function TimeTrustBadges({ entry }: { readonly entry: TrustFacts }) {
  const tr = useTOr();
  const labels: string[] = [];
  if (entry.source === 'correction') labels.push(tr('TimeTrust.correction', 'Correction'));
  else if (entry.trust === 'hand') labels.push(tr('TimeTrust.byHand', 'Added by hand'));
  if (entry.approvalState === 'pending')
    labels.push(tr('TimeTrust.waiting', 'Waiting for approval'));
  if (entry.approvalState === 'rejected') labels.push(tr('TimeTrust.refused', 'Refused'));
  if (entry.approvalState !== 'rejected' && entry.approvalState !== 'pending' && !entry.counted) {
    labels.push(tr('TimeTrust.replaced', 'Replaced by a correction'));
  }
  if (entry.edited === true) labels.push(tr('TimeTrust.edited', 'Edited'));
  if (labels.length === 0) return null;
  return (
    <>
      {labels.map((label) => (
        <span key={label}>
          {' '}
          <Badge>{label}</Badge>
        </span>
      ))}
    </>
  );
}

/** Shown instead of the hand-time form when the owner turned it off. */
export function HandTimeOffNotice() {
  const tr = useTOr();
  return (
    <InlineAlert tone="neutral" title={tr('TimeTrust.offTitle', 'Time comes from the timer')}>
      {tr(
        'TimeTrust.offBody',
        'Your company records time with the timer only. If timer time is wrong, open the entry and ask for a correction.',
      )}
    </InlineAlert>
  );
}

/** The reason field every hand-time form carries. */
export function HandTimeReasonField({
  value,
  onChange,
  afterApproval,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** The owner counts hand time only once a manager approves it. */
  readonly afterApproval: boolean;
}) {
  const tr = useTOr();
  return (
    <Field
      label={tr('TimeTrust.reasonLabel', 'Why are you adding this by hand?')}
      name="reason"
      value={value}
      maxLength={500}
      onChange={(event) => onChange(event.target.value)}
      hint={
        afterApproval
          ? tr(
              'TimeTrust.reasonHintApproval',
              'It shows as “Added by hand” and counts once a manager approves it.',
            )
          : tr(
              'TimeTrust.reasonHintFlagged',
              'It shows as “Added by hand” and a manager checks it.',
            )
      }
      required
    />
  );
}

/** A reason the API accepts: 3 to 500 characters once trimmed. */
export const reasonValid = (reason: string): boolean =>
  reason.trim().length >= 3 && reason.trim().length <= 500;

/** Ask for a correction of one's own timer entry: the right minutes and a reason. */
export function CorrectionForm({
  api,
  organizationSlug,
  entryId,
  measuredMinutes,
  onDone,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly entryId: string;
  readonly measuredMinutes: number;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const [minutes, setMinutes] = useState(String(measuredMinutes));
  const [reason, setReason] = useState('');
  const parsed = Number(minutes);
  const minutesOk =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= 1440 && parsed !== measuredMinutes;
  const ask = useMutation({
    mutationFn: () =>
      requestTimeCorrection(api, organizationSlug, entryId, {
        minutes: parsed,
        reason: reason.trim(),
      }),
    onSuccess: onDone,
  });
  const ready = minutesOk && reasonValid(reason) && !ask.isPending;
  return (
    <form
      className="tm-stack"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (ready) ask.mutate();
      }}
    >
      <Field
        label={tr('TimeTrust.correctMinutes', 'The right number of minutes')}
        name="correctMinutes"
        type="number"
        min={1}
        max={1440}
        value={minutes}
        onChange={(event) => setMinutes(event.target.value)}
        required
      />
      <Field
        label={tr('TimeTrust.correctReason', 'What happened?')}
        name="correctReason"
        value={reason}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        hint={tr(
          'TimeTrust.correctHint',
          'A manager approves the correction. Until then the timer time counts.',
        )}
        required
      />
      {ask.isError ? (
        <InlineAlert
          tone="danger"
          title={tr('TimeTrust.correctError', 'The correction was not sent')}
          live
        >
          {describeError(ask.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-row">
        <Button type="button" tone="outline" onClick={onCancel} disabled={ask.isPending}>
          {tr('TimeTrust.cancel', 'Cancel')}
        </Button>
        <Button type="submit" tone="ink" disabled={!ready} loading={ask.isPending}>
          {tr('TimeTrust.correctSend', 'Ask for the correction')}
        </Button>
      </div>
    </form>
  );
}
