'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PhoneIcon } from '../icons/phone';
import { getHomePulse } from '../../lib/api/home';
import { listConversationUnread } from '../../lib/api/conversation-read-state';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { useHydrated } from '../../lib/use-hydrated';
import '../../styles/phone/home.css';

/** The next (or current) slot of today's day capsule, as My Day already derives it. */
export interface PhoneUpNext {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly href: string;
  readonly kind: 'meeting' | 'focus';
}

export interface PhoneHomeHeroProps {
  /** "Four things need you today." — the same lead sentence the desktop header opens with. */
  headline: string;
  /** Injected in tests; the eyebrow's date. */
  today?: Date;
}

/**
 * **Phone · Home / My Day** (Figma 406:6374 EN, 406:6505 AR): the black "today" hero with the
 * day's lead sentence. Drawn only below 768px (`styles/phone/home.css`). My Day v4 (spec §4.4)
 * places it second, under the day bar; its three numbers are `PhoneHomeMetrics`, placed sixth.
 */
export function PhoneHomeHero({ headline, today }: PhoneHomeHeroProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const arabic = locale.toLowerCase().startsWith('ar');

  // "Today" is the viewer's day, not the server's: the server render (another time zone) would
  // name a different day near midnight and fail hydration, so the date waits for the client.
  const hydrated = useHydrated();
  const dateLabel =
    today !== undefined || hydrated
      ? (today ?? new Date()).toLocaleDateString(appDateLocale(locale), {
          weekday: 'long',
          day: 'numeric',
          month: arabic ? 'long' : 'short',
        })
      : null;

  return (
    <div className="tm-phone-home tm-home-part" data-rank="20">
      <section className="tm-phone-home__hero" aria-labelledby="tm-phone-home-headline">
        <p className="tm-phone-home__eyebrow">
          {dateLabel === null ? null : `${dateLabel} · `}
          {tOr('PhoneHome.myDay', 'My Day')}
        </p>
        <h2 id="tm-phone-home-headline" className="tm-phone-home__headline">
          {headline}
        </h2>
      </section>
    </div>
  );
}

export interface PhoneHomeMetricsProps {
  api: ApiClient;
  organizationSlug: string;
  /** Approvals waiting on the reader, from `/home/summary` (undefined while it loads). */
  approvalsWaiting: number | undefined;
  upNext: PhoneUpNext | undefined;
}

/**
 * **Phone · the three numbers and "Up next"** (Figma 406:6374): one row of three — due today,
 * approvals waiting, new messages — on the black hero ground, then the lime "Up next" card. Every
 * number is the API's: due today from the Pulse read, approvals from the summary, new messages
 * from the channel read-state. A number that has not loaded shows a dash rather than a guess.
 */
export function PhoneHomeMetrics({
  api,
  organizationSlug,
  approvalsWaiting,
  upNext,
}: PhoneHomeMetricsProps) {
  const tOr = useTOr();

  // Same keys as HomeHeroSection and ChatScreen, so the phone adds no request of its own.
  const pulse = useQuery({
    queryKey: ['home', 'pulse', organizationSlug],
    queryFn: () => getHomePulse(api, organizationSlug),
  });
  const unread = useQuery({
    queryKey: ['conversations', organizationSlug, 'unread'],
    queryFn: () => listConversationUnread(api, organizationSlug),
  });
  const newMessages = Array.isArray(unread.data)
    ? unread.data.reduce((total, entry) => total + entry.unreadCount, 0)
    : undefined;

  const metrics = [
    {
      id: 'due',
      value: pulse.data?.dueToday,
      label: tOr('PhoneHome.dueToday', 'due today'),
    },
    {
      id: 'approvals',
      value: approvalsWaiting,
      label: tOr('PhoneHome.approvalWaiting', 'approval waiting'),
    },
    {
      id: 'messages',
      value: newMessages,
      label: tOr('PhoneHome.newMessages', 'new messages'),
    },
  ];

  return (
    <div className="tm-phone-home tm-phone-home--metrics tm-home-part" data-rank="60">
      <section className="tm-phone-home__hero" aria-label={tOr('PhoneHome.myDay', 'My Day')}>
        <dl className="tm-phone-home__metrics">
          {metrics.map((metric) => (
            <div key={metric.id} className="tm-phone-home__metric">
              <span className="tm-phone-home__dash" aria-hidden="true" />
              <dt className="tm-phone-home__metric-label">{metric.label}</dt>
              <dd className="tm-phone-home__metric-value">
                {metric.value === undefined ? '–' : String(metric.value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {upNext ? (
        <section className="tm-phone-home__next" aria-labelledby="tm-phone-home-next">
          <p className="tm-phone-home__next-eyebrow">
            <span className="tm-phone-home__next-orb" aria-hidden="true">
              <PhoneIcon name="clock" size={16} />
            </span>
            <span>
              {tOr('PhoneHome.upNext', 'Up next')} ·{' '}
              <bdi dir="ltr">
                {clock(upNext.start)} – {clock(upNext.end)}
              </bdi>
            </span>
          </p>
          <h2 id="tm-phone-home-next" className="tm-phone-home__next-title">
            {upNext.label}
          </h2>
          <div className="tm-phone-home__next-row">
            <Link href={upNext.href} className="tm-phone-home__join">
              {upNext.kind === 'meeting'
                ? tOr('PhoneHome.joinNow', 'Join now')
                : tOr('PhoneHome.open', 'Open')}
              <span className="tm-visually-hidden">: {upNext.label}</span>
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function clock(instant: number): string {
  return new Date(instant).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
