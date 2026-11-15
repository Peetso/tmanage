'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import {
  getPortalMeeting,
  getPortalMeetingCall,
  joinPortalMeeting,
} from '../../lib/api/meeting-join';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { usePortalNames } from '../../lib/use-organization-names';
import { JoinCapsuleLine, JoinOutcomeNote } from '../meetings/MeetingCall';
import { clock, providerName } from '../meetings/meeting-join-model';
import { useMeetingJoin } from '../meetings/use-meeting-join';
import '../meetings/meetings.css';

export interface PortalMeetingScreenProps {
  organizationSlug: string;
  meetingId: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
  now?: Date;
}

/**
 * 53-12 — a client person's meeting with its one-tap Join (approved Figma 612:34741 EN /
 * 612:35149 AR). Only the client's own meetings resolve (the API answers 404 otherwise); Join marks
 * them present and opens the call. The studio's agenda note is not client-safe, so it is not shown.
 */
export function PortalMeetingScreen({
  organizationSlug,
  meetingId,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
  now,
}: PortalMeetingScreenProps) {
  const { clientName, providerName: studio } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const meeting = useQuery({
    queryKey: ['portal-meeting', organizationSlug, meetingId],
    queryFn: () => getPortalMeeting(api, organizationSlug, meetingId),
    retry: false,
  });
  const call = useQuery({
    queryKey: ['portal-meeting-call', organizationSlug, meetingId],
    queryFn: () => getPortalMeetingCall(api, organizationSlug, meetingId),
    retry: false,
  });
  const join = useMeetingJoin(
    () => joinPortalMeeting(api, organizationSlug, meetingId),
    ['portal-meeting', organizationSlug, meetingId],
  );
  const m = meeting.data;
  const c = call.data;
  const locale = appDateLocale();
  const team = (m?.attendees ?? []).filter((a) => a.kind === 'team').map((a) => a.displayName);
  const name = providerName(c?.provider ?? null);

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={studio}
      title={m?.title ?? tOr('MeetingJoin.meeting', 'Meeting')}
      eyebrow={
        <Link href={`/${organizationSlug}/portal`}>‹ {tOr('MeetingJoin.home', 'Home')}</Link>
      }
    >
      <div className="tm-mtg tm-mtg-portal">
        {meeting.isPending ? (
          <LoadingRegion label={tOr('MeetingJoin.loading', 'Loading the meeting')}>
            <Skeleton height="200px" />
          </LoadingRegion>
        ) : null}
        {meeting.isError ? (
          <InlineAlert tone="danger" title={tOr('MeetingJoin.notFound', 'Meeting not found')} live>
            {tOr('MeetingJoin.notFoundBody', 'This meeting is not shared with you.')}
          </InlineAlert>
        ) : null}
        {m && c ? (
          <>
            <JoinCapsuleLine call={c} startsAt={m.startsAt} now={now ?? new Date()} />
            <section className="tm-mtg-card tm-mtg-call" aria-labelledby="tm-mtg-portal-call">
              <h2 id="tm-mtg-portal-call" className="tm-mtg-card__title">
                {c.kind === 'quick_room'
                  ? tOr('MeetingJoin.quickRoom', 'Quick room')
                  : name || tOr('MeetingJoin.call', 'Call')}
              </h2>
              <p className="tm-mtg-quiet">
                {new Intl.DateTimeFormat(locale, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'short',
                })
                  .format(new Date(m.startsAt))
                  .replace(',', '')}{' '}
                · {clock(m.startsAt, locale)}
                {m.endsAt ? `–${clock(m.endsAt, locale)}` : ''}
              </p>
              {team.length > 0 ? (
                <p>
                  {fillTemplate(tOr('MeetingJoin.withTeam', 'With {names} from {studio}.'), {
                    names: team.join(', '),
                    studio,
                  })}
                </p>
              ) : null}
              {c.kind === null ? (
                <p className="tm-mtg-quiet">
                  {tOr('MeetingJoin.noLinkClient', 'The call link is not ready yet.')}
                </p>
              ) : c.joinState === 'not_open' ? (
                <button
                  type="button"
                  className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--wide"
                  disabled
                >
                  {fillTemplate(tOr('MeetingJoin.opensAt', 'Join opens at {time}'), {
                    time: clock(c.opensAt, locale),
                  })}
                </button>
              ) : c.joinState === 'open' ? (
                <button
                  type="button"
                  className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--tall tm-mtg-btn--wide"
                  onClick={join.start}
                  disabled={join.pending}
                >
                  {tOr('MeetingJoin.joinNow', 'Join now')}
                </button>
              ) : null}
              {c.kind !== null && c.joinState !== 'ended' ? (
                <p className="tm-mtg-hint">
                  {fillTemplate(
                    tOr('MeetingJoin.clientFoot', 'Opens {name}. {studio} sees that you joined.'),
                    {
                      name: name || tOr('MeetingJoin.call', 'Call'),
                      studio,
                    },
                  )}
                </p>
              ) : null}
              <JoinOutcomeNote outcome={join.outcome} onRetry={join.start} />
            </section>
          </>
        ) : null}
      </div>
    </ClientPortalShell>
  );
}
