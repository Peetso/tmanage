'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getMeetingRsvp, setMeetingRsvp } from '../../lib/api/meeting-rsvp';
import type { MeetingRsvpResponse } from '../../lib/api/meeting-rsvp';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MeetingRsvpScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose RSVP to read and answer — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const RESPONSE_LABELS: Readonly<Record<MeetingRsvpResponse, string>> = {
  accepted: 'Going',
  declined: 'Not going',
  tentative: 'Maybe',
};

const RESPONSE_ORDER: readonly MeetingRsvpResponse[] = ['accepted', 'tentative', 'declined'];

/**
 * **CAL meeting RSVP — a member's own response to a meeting (x240).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Calendar asks whether an invited member is coming. The
 * attendee roster (x126) is an organiser inviting members; this is the member answering for
 * themselves — `accepted`, `declined` or `tentative` — reached from a meeting.
 *
 * ## What it draws
 *
 * - **The response counts.** How many have said going / maybe / not going, from the API summary.
 * - **The caller's own response.** A control that PUTs the chosen answer (behind `meeting.write`),
 *   idempotently — re-answering replaces the one row. The current answer is shown as a
 *   {@link StateCapsule} whose word and colour differ, so it never rests on colour alone.
 *
 * A meeting id is required, and the API resolves it tenant-scoped before the relation check, so an
 * unknown or cross-tenant id comes back 404 and the screen shows a not-found state — never an empty
 * summary that would confirm the meeting exists.
 */
export function MeetingRsvpScreen({
  organizationSlug,
  organizationName,
  meetingId,
  client,
}: MeetingRsvpScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const summary = useQuery({
    queryKey: ['meeting-rsvp', organizationSlug, meetingId],
    queryFn: () => getMeetingRsvp(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });

  const respond = useMutation({
    mutationFn: (response: MeetingRsvpResponse) =>
      setMeetingRsvp(api, organizationSlug, meetingId, response),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['meeting-rsvp', organizationSlug, meetingId] });
    },
  });

  const notFound =
    summary.isError && summary.error instanceof ApiRequestError && summary.error.status === 404;

  const own = summary.data?.response ?? null;
  const counts = summary.data?.counts ?? { accepted: 0, declined: 0, tentative: 0 };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Meeting RSVP"
      description="Whether you are coming to this meeting, and who else is."
    >
      {meetingId === '' ? (
        <InlineAlert tone="neutral" title="No meeting chosen">
          Open a meeting to respond to it.
        </InlineAlert>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title="Meeting not found" live>
          This meeting does not exist or you do not have access to it.
        </InlineAlert>
      ) : null}

      {summary.isError && !notFound ? (
        <InlineAlert tone="danger" title="Could not load the RSVP" live>
          {describeError(summary.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && summary.isPending ? (
        <LoadingRegion label="Loading the RSVP.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {meetingId !== '' && !notFound && !summary.isError && !summary.isPending ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-rsvp-heading">
          <h2 id="tm-rsvp-heading" className="tm-eyebrow">
            Your response
          </h2>

          <div className="tm-row" aria-live="polite">
            <span className="tm-table__title">You are:</span>
            {own === null ? (
              <StateCapsule state="waiting">No answer yet</StateCapsule>
            ) : (
              <StateCapsule state={responseCapsule(own)}>{RESPONSE_LABELS[own]}</StateCapsule>
            )}
          </div>

          {respond.isError ? (
            <InlineAlert tone="danger" title="Could not save your response" live>
              {describeError(respond.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row" role="group" aria-label="Set your response">
            {RESPONSE_ORDER.map((value) => (
              <Button
                key={value}
                type="button"
                tone={value === own ? 'ink' : 'outline'}
                size="accessible"
                loading={respond.isPending && respond.variables === value}
                loadingLabel="Saving"
                disabled={respond.isPending}
                onClick={() => respond.mutate(value)}
              >
                {RESPONSE_LABELS[value]}
              </Button>
            ))}
          </div>

          <dl className="tm-row" aria-label="Response counts">
            <div>
              <dt className="tm-eyebrow">Going</dt>
              <dd className="tm-table__title">{counts.accepted}</dd>
            </div>
            <div>
              <dt className="tm-eyebrow">Maybe</dt>
              <dd className="tm-table__title">{counts.tentative}</dd>
            </div>
            <div>
              <dt className="tm-eyebrow">Not going</dt>
              <dd className="tm-table__title">{counts.declined}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </AppShell>
  );
}

/**
 * A distinct word, colour and shape per response so the state never rests on colour alone: going is
 * `done` (✓), not-going is `blocked` (✕), and a tentative answer is `waiting` (◷).
 */
function responseCapsule(response: MeetingRsvpResponse): CapsuleState {
  if (response === 'accepted') return 'done';
  if (response === 'declined') return 'blocked';
  return 'waiting';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
