'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { MeetingIcsButton } from '../MeetingIcsButton';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMeetingNotes } from '../../lib/api/meetings';
import type { MeetingNoteView } from '../../lib/api/meetings';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { MeetingBackLink, MeetingHeaderActions } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingNotesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose notes and decisions to read — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

/**
 * **CAL-01 / MTG-01 — a meeting's notes and decisions (read).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Calendar: a meeting closes with its captured notes and
 * the decisions taken. This is the read screen for that — the clean read half of x105, which
 * landed the capture + read API and the `meeting_notes` table (migration 0033). It lists one
 * meeting's notes and decisions in the server's deterministic order, drawing a decision distinctly
 * from a plain note.
 *
 * ## What it draws, and what it cannot
 *
 * - **Order is the server's** — the API returns the rows in `(organization_id, meeting_id, id)`
 *   order, and UUIDv7 ids sort in creation order, so the sequence down the list is chronological
 *   without a client-side re-sort to drift from it.
 * - **A decision is visually distinct from a note.** Each row carries a {@link StateCapsule} whose
 *   word, colour *and* shape differ (`◆ Decision` versus `■ Note`), so the distinction survives
 *   the high-contrast theme and a screen reader alike — it is never colour alone.
 * - **Authoring and the decision approval/lock lifecycle are not here.** The write side and a
 *   decision's status are x105-b; this screen only reads.
 *
 * A meeting id is required: notes are per-meeting by definition, and the API resolves the meeting
 * tenant-scoped before the relation check, so an unknown or cross-tenant id comes back 404 and the
 * screen shows a not-found state — never an empty list that would confirm the meeting exists.
 */
export function MeetingNotesScreen({
  organizationSlug,
  organizationName,
  meetingId,
  client,
}: MeetingNotesScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const notes = useQuery({
    queryKey: ['meeting-notes', organizationSlug, meetingId],
    queryFn: () => listMeetingNotes(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });

  const rows = useMemo(() => notes.data?.notes ?? [], [notes.data]);
  const decisions = rows.filter((note) => note.kind === 'decision').length;
  const notFound =
    notes.isError && notes.error instanceof ApiRequestError && notes.error.status === 404;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('MeetingNotesScreen.title')}
      eyebrow={t('MeetingNotesScreen.eyebrow')}
      actions={
        <MeetingHeaderActions
          organizationSlug={organizationSlug}
          meetingId={notFound ? '' : meetingId}
          current="notes"
        >
          {meetingId !== '' && !notFound ? (
            <MeetingIcsButton organizationSlug={organizationSlug} meetingId={meetingId} />
          ) : null}
        </MeetingHeaderActions>
      }
    >
      <div className="tm-cal">
        <MeetingBackLink organizationSlug={organizationSlug} />

        <div className="tm-cal-narrow">
          {meetingId === '' ? (
            <InlineAlert tone="neutral" title={t('MeetingNotesScreen.noMeetingTitle')}>
              {t('MeetingNotesScreen.noMeetingBody')}
            </InlineAlert>
          ) : null}

          {notFound ? (
            <InlineAlert tone="neutral" title={t('MeetingNotesScreen.notFoundTitle')} live>
              {t('MeetingNotesScreen.notFoundBody')}
            </InlineAlert>
          ) : null}

          {notes.isError && !notFound ? (
            <InlineAlert tone="danger" title={t('MeetingNotesScreen.loadErrorTitle')} live>
              {describeError(t, notes.error)}
            </InlineAlert>
          ) : null}

          {meetingId !== '' && notes.isPending ? (
            <LoadingRegion label={t('MeetingNotesScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {meetingId !== '' && !notes.isPending && !notes.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('MeetingNotesScreen.emptyTitle')}>
              {t('MeetingNotesScreen.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <section
              className="tm-cal-card"
              aria-label={t('MeetingNotesScreen.listAria')}
              aria-describedby="tm-meeting-notes-count"
            >
              <p id="tm-meeting-notes-count" className="tm-cal-eyebrow">
                {t('MeetingNotesScreen.capturedLabel')} · {rows.length} · {decisions}{' '}
                {decisions === 1
                  ? t('MeetingNotesScreen.decisionCountSingular')
                  : t('MeetingNotesScreen.decisionCountPlural')}
              </p>
              <ul className="tm-cal-items">
                {rows.map((note) => (
                  <li key={note.id} className="tm-cal-item">
                    <span
                      className={
                        note.kind === 'decision' ? 'tm-cal-orb' : 'tm-cal-orb tm-cal-orb--quiet'
                      }
                      aria-hidden="true"
                    >
                      {note.kind === 'decision' ? '✓' : '■'}
                    </span>
                    <div className="tm-cal-item__body">
                      <p className="tm-cal-item__title tm-prose">{note.body}</p>
                      <time className="tm-cal-item__meta" dateTime={note.createdAt}>
                        {formatInstant(note.createdAt)}
                      </time>
                    </div>
                    <span className="tm-cal-item__end">
                      <StateCapsule state={kindCapsule(note.kind)}>
                        {note.kind === 'decision'
                          ? t('MeetingNotesScreen.kindDecision')
                          : t('MeetingNotesScreen.kindNote')}
                      </StateCapsule>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

/** A decision is drawn as `current` (◆), a note as `neutral` (■): distinct word, colour and shape. */
function kindCapsule(kind: MeetingNoteView['kind']): CapsuleState {
  return kind === 'decision' ? 'current' : 'neutral';
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingNotesScreen.errorNetwork');
  return t('MeetingNotesScreen.errorGeneric');
}
