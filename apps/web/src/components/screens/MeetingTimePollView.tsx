'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getMeetingTimePoll, voteMeetingTimePollOption } from '../../lib/api/meeting-time-poll';
import type { MeetingTimePollVoteChoice } from '../../lib/api/meeting-time-poll';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MeetingTimePollViewProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose time-option poll to read and vote on — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const CHOICE_LABELS: Readonly<Record<MeetingTimePollVoteChoice, string>> = {
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
};

const CHOICE_ORDER: readonly MeetingTimePollVoteChoice[] = ['yes', 'maybe', 'no'];

/**
 * **CAL meeting time-option poll — vote on when to hold a meeting (x298).**
 *
 * `22-SCREEN-INVENTORY` §MTG scheduling: an organiser proposes several candidate time slots and
 * invitees vote on each so the tally can pick a time. This screen is the invitee side — it reads the
 * candidate slots and lets the caller record their own `yes` / `maybe` / `no` on each, idempotently
 * (re-voting replaces the one row). Each slot shows a live tally.
 *
 * A meeting id is required, and the API resolves it (and the option a vote names) tenant-scoped
 * before the relation check, so an unknown or cross-tenant id comes back 404 and the screen shows a
 * not-found state — never an empty poll that would confirm the meeting exists.
 */
export function MeetingTimePollView({
  organizationSlug,
  organizationName,
  meetingId,
  client,
}: MeetingTimePollViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const poll = useQuery({
    queryKey: ['meeting-time-poll', organizationSlug, meetingId],
    queryFn: () => getMeetingTimePoll(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });

  const vote = useMutation({
    mutationFn: (input: { optionId: string; choice: MeetingTimePollVoteChoice }) =>
      voteMeetingTimePollOption(api, organizationSlug, meetingId, input.optionId, input.choice),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['meeting-time-poll', organizationSlug, meetingId],
      });
    },
  });

  const notFound =
    poll.isError && poll.error instanceof ApiRequestError && poll.error.status === 404;

  const options = poll.data?.options ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Meeting time poll"
      description="Vote on the proposed times so the organiser can pick one that works."
    >
      {meetingId === '' ? (
        <InlineAlert tone="neutral" title="No meeting chosen">
          Open a meeting to vote on its proposed times.
        </InlineAlert>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title="Meeting not found" live>
          This meeting does not exist or you do not have access to it.
        </InlineAlert>
      ) : null}

      {poll.isError && !notFound ? (
        <InlineAlert tone="danger" title="Could not load the poll" live>
          {describeError(poll.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && poll.isPending ? (
        <LoadingRegion label="Loading the time poll.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {meetingId !== '' && !notFound && !poll.isError && !poll.isPending ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-time-poll-heading">
          <h2 id="tm-time-poll-heading" className="tm-eyebrow">
            Proposed times
          </h2>

          {vote.isError ? (
            <InlineAlert tone="danger" title="Could not save your vote" live>
              {describeError(vote.error)}
            </InlineAlert>
          ) : null}

          {options.length === 0 ? (
            <InlineAlert tone="neutral" title="No times proposed yet">
              The organiser has not proposed any candidate times for this meeting.
            </InlineAlert>
          ) : (
            <ul className="tm-stack" aria-label="Candidate times">
              {options.map((option) => (
                <li key={option.id} className="tm-panel tm-stack" aria-live="polite">
                  <div className="tm-row">
                    <span className="tm-table__title">
                      {formatSlot(option.startsAt, option.endsAt)}
                    </span>
                    {option.ownVote === null ? (
                      <StateCapsule state="waiting">Not voted</StateCapsule>
                    ) : (
                      <StateCapsule state={choiceCapsule(option.ownVote)}>
                        You: {CHOICE_LABELS[option.ownVote]}
                      </StateCapsule>
                    )}
                  </div>

                  <div
                    className="tm-row"
                    role="group"
                    aria-label={`Vote on ${formatSlot(option.startsAt, option.endsAt)}`}
                  >
                    {CHOICE_ORDER.map((choice) => (
                      <Button
                        key={choice}
                        type="button"
                        tone={choice === option.ownVote ? 'ink' : 'outline'}
                        size="accessible"
                        loading={
                          vote.isPending &&
                          vote.variables?.optionId === option.id &&
                          vote.variables?.choice === choice
                        }
                        loadingLabel="Saving"
                        disabled={vote.isPending}
                        onClick={() => vote.mutate({ optionId: option.id, choice })}
                      >
                        {CHOICE_LABELS[choice]}
                      </Button>
                    ))}
                  </div>

                  <dl className="tm-row" aria-label="Vote tally">
                    <div>
                      <dt className="tm-eyebrow">Yes</dt>
                      <dd className="tm-table__title">{option.tally.yes}</dd>
                    </div>
                    <div>
                      <dt className="tm-eyebrow">Maybe</dt>
                      <dd className="tm-table__title">{option.tally.maybe}</dd>
                    </div>
                    <div>
                      <dt className="tm-eyebrow">No</dt>
                      <dd className="tm-table__title">{option.tally.no}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </AppShell>
  );
}

/**
 * A distinct word, colour and shape per vote so the state never rests on colour alone: yes is `done`
 * (✓), no is `blocked` (✕), and a tentative maybe is `waiting` (◷).
 */
function choiceCapsule(choice: MeetingTimePollVoteChoice): CapsuleState {
  if (choice === 'yes') return 'done';
  if (choice === 'no') return 'blocked';
  return 'waiting';
}

/** A candidate slot's window, `start – end`, in the viewer's locale. */
function formatSlot(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startsAt} – ${endsAt}`;
  }
  return `${start.toLocaleString()} – ${end.toLocaleString()}`;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
