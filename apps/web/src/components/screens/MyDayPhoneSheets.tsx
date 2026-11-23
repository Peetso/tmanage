'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, useAnnounce } from '@tmanage/ui';
import { PhoneIcon } from '../icons/phone';
import type { ApiClient } from '../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import { addTimeLogOrQueue, isQueued } from '../../lib/offline/write-or-queue';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  HandTimeOffNotice,
  HandTimeReasonField,
  reasonValid,
  useTimeTrustPolicy,
} from '../time/TimeTrustParts';
import { fill } from '../../lib/privacy-presentation';
import '../../styles/screens/my-day-phone.css';

/**
 * **Phone · My Day quick actions** (Figma 713:38899 / 713:39725 Approve sheet, 713:39060 /
 * 713:39886 Log time sheet, as corrected by DESIGN-REVIEW-FIGMA-A points 1, 2, 3 and 5).
 *
 * Two bottom sheets that let a person on a phone finish the day's two most common acts from My
 * Day without leaving it: decide on a review that is waiting on them (Approve: two taps), and log
 * time on one of their own items (Log time, a minutes chip, Log time: three taps). Both post to
 * routes that already exist — `POST …/approvals/:id/decision` and the work item's time log, through
 * the offline queue — so there is no new API.
 */

/** One day of effort, in minutes; the API bounds the same range and answers 400 beyond it. */
export const MAX_MINUTES = 24 * 60;

/** The one-hand minute chips under the Minutes field (review point 5). */
export const MINUTE_CHIPS = [15, 30, 45, 60] as const;

interface BottomSheetProps {
  readonly titleId: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** The sticky action area: stays in view above the keyboard while the body scrolls. */
  readonly footer?: ReactNode;
}

/**
 * The composed bottom sheet the phone frames draw (no library part): scrim, handle, a body that
 * scrolls, a sticky footer. A modal dialog: Escape and the scrim close it, focus goes in on open
 * and back to the opener on close.
 */
export function BottomSheet({ titleId, onClose, children, footer }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  // The latest onClose, read by the key listener that is attached once.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // `data-autofocus` marks the control the opener meant; else the first focusable one.
    const target =
      panel.current?.querySelector<HTMLElement>('[data-autofocus="true"]') ??
      panel.current?.querySelector<HTMLElement>(
        'input, textarea, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
    target?.focus();
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    // Escape closes; Tab stays inside the sheet while it is open (a modal dialog).
    const element = panel.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !element) return;
      const focusables = Array.from(
        element.querySelectorAll<HTMLElement>(
          'input, textarea, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    element?.addEventListener('keydown', onKey);
    return () => {
      element?.removeEventListener('keydown', onKey);
      root.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  return (
    <div className="tm-sheet-layer">
      <div className="tm-sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        className="tm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <span className="tm-sheet__handle" aria-hidden="true" />
        <div className="tm-sheet__body">{children}</div>
        {footer ? <div className="tm-sheet__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export type ApprovalVerdict = 'approve' | 'request_changes';

/** `POST …/approvals/:approvalId/decision` — the reviewer's own decision (existing route). */
export async function decideApproval(
  api: ApiClient,
  organizationSlug: string,
  approvalId: string,
  input: { decision: ApprovalVerdict; version: number; feedback?: string },
): Promise<void> {
  await api.request({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    body: input,
  });
}

export interface ApproveSheetProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly approvalId: string;
  /** The approval version the reviewer read — the API's optimistic-concurrency check. */
  readonly version: number;
  /** What is being reviewed, as the row names it. */
  readonly subject: string;
  /** Which button opened the sheet: "Send back" puts the cursor in the change field. */
  readonly intent: ApprovalVerdict;
  readonly onClose: () => void;
  readonly onDecided: (verdict: ApprovalVerdict) => void;
}

/**
 * Approve sheet (review point 1): title, body, Approve, divider, "What should change?", Send back
 * (disabled until the field has text), Cancel. Every control is 44 px or more (point 2).
 */
export function ApproveSheet({
  api,
  organizationSlug,
  approvalId,
  version,
  subject,
  intent,
  onClose,
  onDecided,
}: ApproveSheetProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const titleId = useId();
  const [change, setChange] = useState('');

  const decide = useMutation({
    mutationFn: (verdict: ApprovalVerdict) =>
      decideApproval(api, organizationSlug, approvalId, {
        decision: verdict,
        version,
        ...(verdict === 'request_changes' ? { feedback: change.trim() } : {}),
      }),
    onSuccess: async (_data, verdict) => {
      announce(
        verdict === 'approve'
          ? tOr('PhoneHome.approvedNotice', 'Approved.')
          : tOr('PhoneHome.sentBackNotice', 'Sent back with your note.'),
      );
      onDecided(verdict);
      await queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  const canSendBack = change.trim() !== '' && !decide.isPending;

  return (
    <BottomSheet titleId={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-sheet__title">
        {fill(tOr('PhoneHome.approveTitle', 'Approve “{subject}”?'), { subject })}
      </h2>
      <p className="tm-sheet__lead">
        {tOr('PhoneHome.approveBody', 'Your name and the time go on the approval record.')}
      </p>
      {decide.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('PhoneHome.decideError', 'Your answer was not saved')}
          live
        >
          {describeError(decide.error)}
        </InlineAlert>
      ) : null}
      <Button
        data-autofocus={intent === 'approve'}
        type="button"
        tone="ink"
        size="accessible"
        className="tm-sheet__wide"
        loading={decide.isPending && decide.variables === 'approve'}
        disabled={decide.isPending && decide.variables !== 'approve'}
        onClick={() => decide.mutate('approve')}
      >
        {tOr('PhoneHome.approve', 'Approve')}
      </Button>
      <hr className="tm-sheet__divider" />
      <form
        className="tm-sheet__form"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canSendBack) decide.mutate('request_changes');
        }}
      >
        <Field
          data-autofocus={intent === 'request_changes'}
          label={tOr('PhoneHome.whatShouldChange', 'What should change?')}
          name="feedback"
          value={change}
          autoComplete="off"
          onChange={(event) => setChange(event.target.value)}
        />
        <Button
          type="submit"
          tone="outline"
          size="accessible"
          className="tm-sheet__wide"
          disabled={!canSendBack && !(decide.isPending && decide.variables === 'request_changes')}
          loading={decide.isPending && decide.variables === 'request_changes'}
        >
          {tOr('PhoneHome.sendBack', 'Send back')}
        </Button>
      </form>
      <Button
        type="button"
        tone="text"
        size="accessible"
        className="tm-sheet__wide"
        onClick={onClose}
      >
        {tOr('PhoneHome.cancel', 'Cancel')}
      </Button>
    </BottomSheet>
  );
}

export interface LogTimeSheetProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly workItemId: string;
  readonly workTitle: string;
  readonly projectName: string;
  readonly onClose: () => void;
  /** `queued` = kept on this phone until the connection is back (the offline queue). */
  readonly onLogged: (outcome: 'saved' | 'queued') => void;
  /** Injected in tests; the Day field's default. */
  readonly today?: Date;
}

/** `YYYY-MM-DD` of the viewer's own day — the Day field's default. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Log time sheet (review points 5 and 17): Minutes with 15 · 30 · 45 · 60 chips, Day (today by
 * default, calendar sign at the field end), Note, then the sticky Log time and Cancel. Offline the
 * entry joins the offline queue and the card says so (review point 3).
 */
export function LogTimeSheet({
  api,
  organizationSlug,
  workItemId,
  workTitle,
  projectName,
  onClose,
  onLogged,
  today,
}: LogTimeSheetProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const titleId = useId();
  const formId = useId();
  const [minutes, setMinutes] = useState('');
  const [spentOn, setSpentOn] = useState(() => localDay(today ?? new Date()));
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  // 2026-11-23 time trust: hand time only when the owner allows it, with a reason.
  const policy = useTimeTrustPolicy(api, organizationSlug);
  const handAllowed = policy.data?.handTimeAllowed === true;

  const parsed = Number(minutes);
  const minutesValid =
    minutes.trim() !== '' && Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_MINUTES;
  const dayValid = /^\d{4}-\d{2}-\d{2}$/.test(spentOn);

  const add = useMutation({
    mutationFn: () =>
      addTimeLogOrQueue(api, organizationSlug, workItemId, {
        minutes: parsed,
        spentOn,
        note: note.trim() === '' ? null : note.trim(),
        reason: reason.trim(),
      }),
    onSuccess: async (result) => {
      if (isQueued(result)) {
        onLogged('queued');
        return;
      }
      announce(tOr('PhoneHome.timeLoggedNotice', 'Time logged.'));
      onLogged('saved');
      await queryClient.invalidateQueries({
        queryKey: ['work-item-time-logs', organizationSlug, workItemId],
      });
    },
  });

  const canLog = handAllowed && minutesValid && dayValid && reasonValid(reason) && !add.isPending;

  return (
    <BottomSheet
      titleId={titleId}
      onClose={onClose}
      footer={
        <>
          <Button
            type="submit"
            form={formId}
            tone="ink"
            size="accessible"
            className="tm-sheet__wide"
            disabled={!canLog && !add.isPending}
            loading={add.isPending}
          >
            {tOr('PhoneHome.logTime', 'Log time')}
          </Button>
          <Button
            type="button"
            tone="text"
            size="accessible"
            className="tm-sheet__wide"
            onClick={onClose}
          >
            {tOr('PhoneHome.cancel', 'Cancel')}
          </Button>
        </>
      }
    >
      <h2 id={titleId} className="tm-sheet__title">
        {tOr('PhoneHome.logTime', 'Log time')}
      </h2>
      <p className="tm-sheet__lead">
        {workTitle} · {projectName}
      </p>
      {policy.isSuccess && !handAllowed ? <HandTimeOffNotice /> : null}
      <form
        id={formId}
        className="tm-sheet__form"
        hidden={!handAllowed}
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canLog) add.mutate();
        }}
      >
        <Field
          label={tOr('PhoneHome.minutesLabel', 'Minutes')}
          name="minutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_MINUTES}
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          hint={tOr('PhoneHome.minutesHint', 'From 1 minute to 24 hours.')}
          required
        />
        <div
          className="tm-chip-row tm-sheet__chips"
          role="group"
          aria-label={tOr('PhoneHome.minuteChips', 'Quick minutes')}
        >
          {MINUTE_CHIPS.map((value) => (
            <button
              key={value}
              type="button"
              className="tm-chip tm-sheet__chip"
              aria-pressed={minutes === String(value)}
              onClick={() => setMinutes(String(value))}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="tm-sheet__date">
          <Field
            label={tOr('PhoneHome.dayLabel', 'Day')}
            name="spentOn"
            type="date"
            value={spentOn}
            onChange={(event) => setSpentOn(event.target.value)}
            hint={tOr('PhoneHome.dayHint', 'The day you did the work.')}
            required
          />
          <span className="tm-sheet__date-icon" aria-hidden="true">
            <PhoneIcon name="calendar" size={20} />
          </span>
        </div>
        <Field
          label={tOr('PhoneHome.noteLabel', 'Note')}
          name="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint={tOr('PhoneHome.noteHint', 'Optional. What was the time for?')}
        />
        <HandTimeReasonField
          value={reason}
          onChange={setReason}
          afterApproval={policy.data?.handTimeCountMode !== 'at_once_flagged'}
        />
        {add.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('PhoneHome.logError', 'Your time was not saved')}
            live
          >
            {describeError(add.error)}
          </InlineAlert>
        ) : null}
      </form>
    </BottomSheet>
  );
}
