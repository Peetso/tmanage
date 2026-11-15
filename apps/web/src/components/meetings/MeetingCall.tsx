'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  getMeetingCall,
  joinMeeting,
  setMeetingCall,
  startQuickRoom,
  type MeetingCallView,
} from '../../lib/api/meeting-join';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { canJoin, clock, joinCapsule, providerName } from './meeting-join-model';
import { useMeetingJoin, type JoinOutcome } from './use-meeting-join';

type TOr = ReturnType<typeof useTOr>;

export const meetingCallKey = (orgSlug: string, meetingId: string) => [
  'meeting-call',
  orgSlug,
  meetingId,
];

export function useMeetingCall(api: ApiClient, orgSlug: string, meetingId: string) {
  return useQuery({
    queryKey: meetingCallKey(orgSlug, meetingId),
    queryFn: () => getMeetingCall(api, orgSlug, meetingId),
    retry: false,
  });
}

/** The state capsule under the header: "Starts in 8 min" / "Join opens at 10:50" / … */
export function JoinCapsuleLine({
  call,
  startsAt,
  now,
}: {
  call: MeetingCallView;
  startsAt: string;
  now: Date;
}) {
  const tOr = useTOr();
  return (
    <p className="tm-mtg-joinline">
      <span className="tm-mtg-capsule" data-state={call.joinState}>
        {capsuleText(tOr, joinCapsule(call, startsAt, now))}
      </span>
      <span className="tm-mtg-quiet">
        {tOr(
          'MeetingJoin.hint',
          'Join opens 10 minutes before the start. TManage marks you present when you join.',
        )}
      </span>
    </p>
  );
}

function capsuleText(tOr: TOr, capsule: ReturnType<typeof joinCapsule>): string {
  const locale = appDateLocale();
  switch (capsule.key) {
    case 'startsIn':
      return fillTemplate(tOr('MeetingJoin.startsIn', 'Starts in {n} min'), {
        n: String(capsule.minutes),
      });
    case 'opensAt':
      return fillTemplate(tOr('MeetingJoin.opensAt', 'Join opens at {time}'), {
        time: clock(capsule.at, locale),
      });
    case 'inProgress':
      return fillTemplate(tOr('MeetingJoin.inProgress', 'In progress · started {time}'), {
        time: clock(capsule.since, locale),
      });
    case 'ended':
      return tOr('MeetingJoin.ended', 'Ended');
    default:
      return tOr('MeetingJoin.upcoming', 'Upcoming');
  }
}

/** The header's primary button: "Join Google Meet" (records attendance, then opens the call). */
export function JoinButton({
  api,
  organizationSlug,
  meetingId,
  call,
}: {
  api: ApiClient;
  organizationSlug: string;
  meetingId: string;
  call: MeetingCallView;
}) {
  const tOr = useTOr();
  const join = useMeetingJoin(
    () => joinMeeting(api, organizationSlug, meetingId),
    ['meeting-attendance', organizationSlug, meetingId],
  );
  if (!call.invited || call.kind === null || call.joinState === 'ended') return null;
  const name = providerName(call.provider);
  return (
    <div className="tm-mtg-hero-lime__join">
      {call.joinState === 'not_open' ? (
        <button type="button" className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--tall" disabled>
          {fillTemplate(tOr('MeetingJoin.opensAt', 'Join opens at {time}'), {
            time: clock(call.opensAt, appDateLocale()),
          })}
        </button>
      ) : (
        <button
          type="button"
          className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--tall"
          onClick={join.start}
          disabled={!canJoin(call) || join.pending}
        >
          {call.kind === 'quick_room'
            ? tOr('MeetingJoin.joinQuickRoom', 'Join quick room')
            : fillTemplate(tOr('MeetingJoin.joinNamed', 'Join {name}'), { name })}
        </button>
      )}
      <JoinOutcomeNote outcome={join.outcome} onRetry={join.start} />
    </div>
  );
}

/** "Call didn't open" with Try again / Open in new tab, or a refusal in words. */
export function JoinOutcomeNote({
  outcome,
  onRetry,
}: {
  outcome: JoinOutcome;
  onRetry: () => void;
}) {
  const tOr = useTOr();
  if (outcome.kind === 'refused') {
    const words: Record<typeof outcome.reason, string> = {
      not_open: tOr('MeetingJoin.notOpenYet', 'Join opens 10 minutes before the start.'),
      ended: tOr('MeetingJoin.endedBody', 'This meeting has ended.'),
      cancelled: tOr('MeetingJoin.cancelledBody', 'This meeting was cancelled.'),
      no_call_link: tOr('MeetingJoin.noLinkBody', 'This meeting has no call link yet.'),
    };
    return (
      <p className="tm-mtg-quiet" role="status">
        {words[outcome.reason]}
      </p>
    );
  }
  if (outcome.kind !== 'failed') return null;
  return (
    <div className="tm-mtg-joinfail" role="alert">
      <p className="tm-mtg-joinfail__box">
        <span className="tm-mtg-mono">{tOr('MeetingJoin.didntOpen', "Call didn't open")}</span>
        <span>
          {tOr(
            'MeetingJoin.didntOpenBody',
            "The link didn't respond. Try again, or open it in a new tab.",
          )}
        </span>
      </p>
      <button type="button" className="tm-mtg-btn tm-mtg-btn--outline" onClick={onRetry}>
        {tOr('MeetingJoin.tryAgain', 'Try again')}
      </button>
      {outcome.url ? (
        <a className="tm-mtg-textlink" href={outcome.url} target="_blank" rel="noopener noreferrer">
          {tOr('MeetingJoin.openNewTab', 'Open in new tab')}
        </a>
      ) : null}
    </div>
  );
}

/** The side card: the call (or "No call link yet"), and the quick room. */
export function CallCard({
  api,
  organizationSlug,
  meetingId,
  title,
  call,
}: {
  api: ApiClient;
  organizationSlug: string;
  meetingId: string;
  title: string;
  call: MeetingCallView;
}) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const key = meetingCallKey(organizationSlug, meetingId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const onSaved = (data: MeetingCallView) => {
    queries.setQueryData(key, data);
    setAdding(false);
    setDraft('');
  };
  const save = useMutation({
    mutationFn: (url: string | null) => setMeetingCall(api, organizationSlug, meetingId, url),
    onSuccess: onSaved,
  });
  const quick = useMutation({
    mutationFn: () => startQuickRoom(api, organizationSlug, meetingId),
    onSuccess: onSaved,
  });
  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => setCopied(true));
  };
  const error = save.error ?? quick.error;
  const startQuick = (
    <button
      type="button"
      className="tm-mtg-btn tm-mtg-btn--outline tm-mtg-btn--wide"
      onClick={() => quick.mutate()}
      disabled={quick.isPending}
    >
      {tOr('MeetingJoin.startQuickRoom', 'Start quick room')}
    </button>
  );

  return (
    <section className="tm-mtg-card tm-mtg-call" aria-labelledby="tm-mtg-call-title">
      {call.kind === 'quick_room' ? (
        <>
          <div className="tm-mtg-card__head">
            <h2 id="tm-mtg-call-title" className="tm-mtg-card__title">
              {fillTemplate(tOr('MeetingJoin.quickRoomTitle', 'Quick room · {title}'), { title })}
            </h2>
            {call.joinState === 'open' ? (
              <span className="tm-mtg-capsule" data-state="open">
                {tOr('MeetingJoin.live', 'Live')}
              </span>
            ) : null}
          </div>
          <div className="tm-mtg-call__actions">
            {call.url ? (
              <>
                <button
                  type="button"
                  className="tm-mtg-btn tm-mtg-btn--outline"
                  onClick={() => copy(call.url!)}
                >
                  {copied
                    ? tOr('MeetingJoin.copied', 'Copied')
                    : tOr('MeetingJoin.copyInvite', 'Copy invite')}
                </button>
                <a
                  className="tm-mtg-btn tm-mtg-btn--outline"
                  href={call.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tOr('MeetingJoin.openNewTab', 'Open in new tab')}
                </a>
              </>
            ) : null}
            <button
              type="button"
              className="tm-mtg-btn tm-mtg-btn--danger"
              onClick={() => save.mutate(null)}
              disabled={save.isPending}
            >
              {tOr('MeetingJoin.endRoom', 'End room')}
            </button>
          </div>
          <p className="tm-mtg-hint">
            {tOr(
              'MeetingJoin.quickRoomFoot',
              "Guests need the link. The room runs on Jitsi's free public servers; to host, you sign in to Jitsi once with your own account.",
            )}
          </p>
        </>
      ) : call.kind !== null ? (
        <>
          <h2 id="tm-mtg-call-title" className="tm-mtg-card__title">
            {tOr('MeetingJoin.call', 'Call')}
          </h2>
          <p className="tm-mtg-call__provider">
            <strong>{providerName(call.provider)}</strong>
            {call.url ? (
              <span className="tm-mtg-quiet">{call.url.replace(/^https:\/\//, '')}</span>
            ) : (
              <span className="tm-mtg-quiet">{call.host}</span>
            )}
          </p>
          {call.url ? (
            <button
              type="button"
              className="tm-mtg-btn tm-mtg-btn--outline tm-mtg-btn--wide"
              onClick={() => copy(call.url!)}
            >
              {copied
                ? tOr('MeetingJoin.copied', 'Copied')
                : tOr('MeetingJoin.copyLink', 'Copy link')}
            </button>
          ) : null}
          <hr className="tm-mtg-rule" />
          <h3 className="tm-mtg-card__title">{tOr('MeetingJoin.quickRoom', 'Quick room')}</h3>
          <p>
            {tOr(
              'MeetingJoin.quickRoomBody',
              'Need to talk right now? Open a private video room for this meeting. Only people with the link can join.',
            )}
          </p>
          <p className="tm-mtg-hint">
            {tOr(
              'MeetingJoin.quickRoomNote',
              "The room runs on Jitsi's free public servers. To host, you sign in to Jitsi once with your own account.",
            )}
          </p>
          {startQuick}
        </>
      ) : (
        <>
          <h2 id="tm-mtg-call-title" className="tm-mtg-card__title">
            {tOr('MeetingJoin.noLink', 'No call link yet')}
          </h2>
          <p>
            {tOr(
              'MeetingJoin.noLinkHelp',
              "Add a Google Meet, Teams or any other link. Or start a quick room when it's time.",
            )}
          </p>
          {adding ? (
            <form
              className="tm-mtg-call__form"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate(draft);
              }}
            >
              <label className="tm-mtg-label" htmlFor="tm-mtg-call-url">
                {tOr('MeetingJoin.linkLabel', 'Call link')}
              </label>
              <input
                id="tm-mtg-call-url"
                className="tm-mtg-input"
                type="url"
                inputMode="url"
                placeholder="https://meet.google.com/…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                required
              />
              <button
                type="submit"
                className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--wide"
                disabled={save.isPending}
              >
                {tOr('MeetingJoin.saveLink', 'Save link')}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--wide"
              onClick={() => setAdding(true)}
            >
              {tOr('MeetingJoin.addLink', 'Add call link')}
            </button>
          )}
          {startQuick}
        </>
      )}
      {error ? (
        <InlineAlert tone="danger" title={tOr('MeetingJoin.notSaved', 'Not saved')} live>
          {error instanceof ApiRequestError && error.status === 400
            ? tOr(
                'MeetingJoin.badLink',
                'Use an https link from Google Meet, Teams, Zoom, Webex, Whereby or Jitsi.',
              )
            : error instanceof ApiRequestError
              ? error.message
              : tOr('MeetingJoin.noAnswer', 'No answer from the server. Try again.')}
        </InlineAlert>
      ) : null}
    </section>
  );
}
