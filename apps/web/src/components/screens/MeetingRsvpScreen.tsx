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
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { MeetingBackLink, MeetingHeaderActions } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingRsvpScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose RSVP to read and answer — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const RESPONSE_LABEL_KEYS: Readonly<Record<MeetingRsvpResponse, MessageKey>> = {
  accepted: 'MeetingRsvpScreen.responseGoing',
  declined: 'MeetingRsvpScreen.responseNotGoing',
  tentative: 'MeetingRsvpScreen.responseMaybe',
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
  const t = useT();

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
      title={t('MeetingRsvpScreen.title')}
      eyebrow={t('MeetingRsvpScreen.eyebrow')}
      actions={
        <MeetingHeaderActions
          organizationSlug={organizationSlug}
          meetingId={notFound ? '' : meetingId}
          current="rsvp"
        />
      }
    >
      <div className="tm-cal">
        <MeetingBackLink organizationSlug={organizationSlug} />

        <div className="tm-cal-narrow">
          {meetingId === '' ? (
            <InlineAlert tone="neutral" title={t('MeetingRsvpScreen.noMeetingTitle')}>
              {t('MeetingRsvpScreen.noMeetingBody')}
            </InlineAlert>
          ) : null}

          {notFound ? (
            <InlineAlert tone="neutral" title={t('MeetingRsvpScreen.notFoundTitle')} live>
              {t('MeetingRsvpScreen.notFoundBody')}
            </InlineAlert>
          ) : null}

          {summary.isError && !notFound ? (
            <InlineAlert tone="danger" title={t('MeetingRsvpScreen.loadErrorTitle')} live>
              {describeError(t, summary.error)}
            </InlineAlert>
          ) : null}

          {meetingId !== '' && summary.isPending ? (
            <LoadingRegion label={t('MeetingRsvpScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {meetingId !== '' && !notFound && !summary.isError && !summary.isPending ? (
            <section className="tm-cal-card" aria-labelledby="tm-rsvp-heading">
              <h2 id="tm-rsvp-heading" className="tm-cal-eyebrow">
                {t('MeetingRsvpScreen.yourResponseHeading')}
              </h2>

              <div className="tm-cal-item" aria-live="polite">
                <span className="tm-cal-orb" aria-hidden="true">
                  {own === 'accepted' ? '✓' : own === 'declined' ? '×' : '?'}
                </span>
                <span className="tm-cal-item__body">
                  <span className="tm-cal-item__title">{t('MeetingRsvpScreen.youAre')}</span>
                </span>
                <span className="tm-cal-item__end">
                  {own === null ? (
                    <StateCapsule state="waiting">
                      {t('MeetingRsvpScreen.noAnswerYet')}
                    </StateCapsule>
                  ) : (
                    <StateCapsule state={responseCapsule(own)}>
                      {t(RESPONSE_LABEL_KEYS[own])}
                    </StateCapsule>
                  )}
                </span>
              </div>

              {respond.isError ? (
                <InlineAlert tone="danger" title={t('MeetingRsvpScreen.saveErrorTitle')} live>
                  {describeError(t, respond.error)}
                </InlineAlert>
              ) : null}

              <div
                className="tm-cal-btn-row"
                role="group"
                aria-label={t('MeetingRsvpScreen.setResponseAria')}
              >
                {RESPONSE_ORDER.map((value) => (
                  <Button
                    key={value}
                    type="button"
                    tone={value === own ? 'ink' : 'outline'}
                    size="default"
                    loading={respond.isPending && respond.variables === value}
                    loadingLabel={t('MeetingRsvpScreen.savingLabel')}
                    disabled={respond.isPending}
                    onClick={() => respond.mutate(value)}
                  >
                    {t(RESPONSE_LABEL_KEYS[value])}
                  </Button>
                ))}
              </div>

              <p className="tm-cal-eyebrow">{t('MeetingRsvpScreen.whoElse')}</p>
              <dl className="tm-cal-counts" aria-label={t('MeetingRsvpScreen.countsAria')}>
                <div>
                  <dt>{t('MeetingRsvpScreen.responseGoing')}</dt>
                  <dd>{counts.accepted}</dd>
                </div>
                <div>
                  <dt>{t('MeetingRsvpScreen.responseMaybe')}</dt>
                  <dd>{counts.tentative}</dd>
                </div>
                <div>
                  <dt>{t('MeetingRsvpScreen.responseNotGoing')}</dt>
                  <dd>{counts.declined}</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function responseCapsule(response: MeetingRsvpResponse): CapsuleState {
  if (response === 'accepted') return 'done';
  if (response === 'declined') return 'blocked';
  return 'waiting';
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingRsvpScreen.errorNetwork');
  return t('MeetingRsvpScreen.errorGeneric');
}
