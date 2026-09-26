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

  const notes = useQuery({
    queryKey: ['meeting-notes', organizationSlug, meetingId],
    queryFn: () => listMeetingNotes(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });

  const rows = useMemo(() => notes.data?.notes ?? [], [notes.data]);
  const notFound =
    notes.isError && notes.error instanceof ApiRequestError && notes.error.status === 404;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Meeting notes"
      description="The notes captured and decisions taken in this meeting."
    >
      {meetingId === '' ? (
        <InlineAlert tone="neutral" title="No meeting chosen">
          Open a meeting to see the notes and decisions captured in it.
        </InlineAlert>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title="Meeting not found" live>
          This meeting does not exist or you do not have access to it.
        </InlineAlert>
      ) : null}

      {meetingId !== '' && !notFound ? (
        <div className="tm-row" aria-label="Meeting actions">
          <MeetingIcsButton organizationSlug={organizationSlug} meetingId={meetingId} />
        </div>
      ) : null}

      {notes.isError && !notFound ? (
        <InlineAlert tone="danger" title="Could not load the notes" live>
          {describeError(notes.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && notes.isPending ? (
        <LoadingRegion label="Loading the meeting notes.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {meetingId !== '' && !notes.isPending && !notes.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No notes yet">
          Nothing has been captured in this meeting yet.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-stack" aria-label="Meeting notes and decisions">
          <ul className="tm-stack tm-list">
            {rows.map((note) => (
              <li key={note.id} className="tm-panel tm-panel--quiet tm-stack tm-stack--tight">
                <div className="tm-row">
                  <StateCapsule state={kindCapsule(note.kind)}>{kindLabel(note.kind)}</StateCapsule>
                  <time className="tm-eyebrow tm-push-end" dateTime={note.createdAt}>
                    {formatInstant(note.createdAt)}
                  </time>
                </div>
                <p className="tm-prose">{note.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}

/** A decision is drawn as `current` (◆), a note as `neutral` (■): distinct word, colour and shape. */
function kindCapsule(kind: MeetingNoteView['kind']): CapsuleState {
  return kind === 'decision' ? 'current' : 'neutral';
}

function kindLabel(kind: MeetingNoteView['kind']): string {
  return kind === 'decision' ? 'Decision' : 'Note';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
