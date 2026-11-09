'use client';

import { useCallback, type ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule } from '@tmanage/ui';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useDisplayFormatters, type DisplayFormatters } from '../../../../lib/i18n/use-formatters';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { ObjectCard } from '../../ProductScenes';
import { cx } from '../../primitives';
import { channelLabel } from '../../../../lib/text/channel-label';

/**
 * Mini product scenes for Features · Chat & calendar (WEB-04). Composed from packages/ui parts
 * (Avatar, Badge, Button, StateCapsule) and the shared Card/Object, on Limeframe tokens only.
 * They are illustrations: the body is `inert` and hidden from assistive tech, and `label` is the
 * one sentence of alternative text.
 *
 * Every visible string is a `FeaturesCommunicationScenes.*` key (slice L6), so the Arabic page
 * mirrors the mock-ups too. Numbers, times, dates and weekdays go through the active-locale
 * formatters. Proper names (people, Atlas, Atlas Hospitality, project titles, channel names such
 * as #atlas-website-relaunch, file names, DEC-42, v2) stay in Latin on purpose.
 */

/** The scene keys arrive in the catalogs through the L6 i18n fragment; widened here once. */
type SceneKey = `FeaturesCommunicationScenes.${string}`;

type Vars = Readonly<Record<string, string | number>>;

/** The week the scenes show: Monday 18 to Friday 22 August 2025. */
const WEEK_OF = '2025-08-18';
const DUE_DAY = '2025-08-20';

interface SceneCopy {
  /** The scene string with `{name}` placeholders filled; numbers in the active locale. */
  s: (key: string, vars?: Vars) => string;
  fmt: DisplayFormatters;
  /** A calendar day at local noon, so the runtime timezone never shifts it. */
  day: (isoDate: string, options: Intl.DateTimeFormatOptions) => string;
  /** A 24-hour wall-clock time such as 10:14. */
  time: (hhmm: string) => string;
  /** A whole number, e.g. a count or a two-digit hour. */
  num: (value: number, minDigits?: number) => string;
}

function useSceneCopy(): SceneCopy {
  const t = useT();
  const fmt = useDisplayFormatters();
  const num = useCallback(
    (value: number, minDigits?: number) =>
      fmt.number(value, minDigits ? { minimumIntegerDigits: minDigits } : undefined),
    [fmt],
  );
  const s = useCallback(
    (key: string, vars?: Vars) => {
      let out = t(`FeaturesCommunicationScenes.${key}` satisfies SceneKey as MessageKey);
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          out = out.replaceAll(`{${name}}`, typeof value === 'number' ? num(value) : value);
        }
      }
      return out;
    },
    [t, num],
  );
  const day = useCallback(
    (isoDate: string, options: Intl.DateTimeFormatOptions) =>
      fmt.day(`${isoDate}T12:00:00`, options),
    [fmt],
  );
  const time = useCallback(
    (hhmm: string) =>
      fmt.dateTime(`${WEEK_OF}T${hhmm}:00`, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    [fmt],
  );
  return { s, fmt, day, time, num };
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const WEEKDAY_DAY_MONTH: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
};

function CommScene({
  label,
  address,
  className,
  children,
}: {
  label: string;
  address?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-wc-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-wc-scene__body" aria-hidden="true" inert>
        {address ? (
          <div className="tm-wc-scene__bar">
            <span className="tm-wc-scene__address">
              <span className="tm-wc-scene__url">{address}</span>
            </span>
          </div>
        ) : null}
        {children}
      </div>
    </figure>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('tm-wc-mono', className)}>{children}</span>;
}

function Glyph({ icon, tone = 'tint' }: { icon: WebIconName; tone?: 'tint' | 'lime' | 'ink' }) {
  return (
    <span className={cx('tm-wc-glyph', `tm-wc-glyph--${tone}`)}>
      <WebIcon name={icon} size={14} />
    </span>
  );
}

function Message({
  name,
  time,
  audience = 'internal',
  org,
  children,
  editedLabel,
}: {
  name: string;
  time: string;
  audience?: 'internal' | 'client';
  org?: string;
  children: ReactNode;
  /** The "(edited)" marker, already translated; omitted when the message was not edited. */
  editedLabel?: string;
}) {
  return (
    <div className="tm-wc-msg">
      <Avatar
        name={name}
        size="compact"
        decorative
        className="tm-wc-avatar"
        {...(audience === 'client' ? { audience: 'client' as const } : {})}
      />
      <div className="tm-wc-msg__main">
        <p className="tm-wc-msg__who">
          <span className="tm-wc-msg__name">{name}</span>
          {org ? <Badge tone="client">{org}</Badge> : null}
          <Mono>{time}</Mono>
          {editedLabel ? <span className="tm-wc-msg__edited">{editedLabel}</span> : null}
        </p>
        <div className="tm-wc-msg__text">{children}</div>
      </div>
    </div>
  );
}

/* ── Hero: the project channel (chat screen, section 07) ───────────────────── */

const HERO_CHANNEL = channelLabel('atlas-website-relaunch');

export function ChannelScene() {
  const t = useT();
  const { s, day, time, num } = useSceneCopy();
  const due = day(DUE_DAY, DAY_MONTH);
  return (
    <CommScene
      address="tmanage.app / northstar / chat / atlas-website-relaunch"
      className="tm-wc-scene--hero"
      label={t('ChannelScene.label')}
    >
      <div className="tm-wc-chat">
        <div className="tm-wc-chat__head">
          <Mono className="tm-wc-chat__eyebrow">{s('channelEyebrow')}</Mono>
          <div className="tm-wc-chat__title-row">
            <p className="tm-wc-chat__title">{HERO_CHANNEL}</p>
            <span className="tm-wc-stack tm-wc-stack--members">
              <Avatar name="Maya Hassan" size="compact" decorative className="tm-wc-avatar" />
              <Avatar name="Lina Samir" size="compact" decorative className="tm-wc-avatar" />
              <Avatar name="Omar Adel" size="compact" decorative className="tm-wc-avatar" />
              <Avatar
                name="Salma Riad"
                size="compact"
                audience="client"
                decorative
                className="tm-wc-avatar"
              />
              <span className="tm-wc-more tm-wc-more--wide">+{num(3)}</span>
              <span className="tm-wc-more tm-wc-more--narrow">+{num(5)}</span>
            </span>
          </div>
          <p className="tm-wc-chat__meta">{s('channelMembers', { n: 7, client: 2 })}</p>
        </div>
        <div className="tm-wc-chat__list">
          <Message name="Maya Hassan" time={time('10:14')}>
            <p>{s('mayaAsk')}</p>
            <p className="tm-wc-reactions">
              <span className="tm-web-chip tm-wc-reaction tm-web-chip--on">✓ {num(3)}</span>
              <span className="tm-wc-thread">
                <WebIcon name="chat" size={14} />
                {s('threadReplies', { n: 3, time: time('10:32') })}
              </span>
            </p>
          </Message>
          <Message name="Lina Samir" time={time('10:20')}>
            <p>{s('linaReply', { day: day(DUE_DAY, { day: 'numeric' }) })}</p>
            <div className="tm-wc-linked">
              <Glyph icon="check" tone="lime" />
              <span className="tm-wc-linked__text">
                <span className="tm-wc-linked__title">{s('taskConcepts')}</span>
                <span className="tm-wc-linked__foot">
                  <StateCapsule state="current">{s('linaDue', { date: due })}</StateCapsule>
                  <Mono>{s('taskFromMessage')}</Mono>
                </span>
              </span>
            </div>
          </Message>
        </div>
        <div className="tm-wc-composer">
          <span className="tm-wc-composer__field">{s('composer', { channel: HERO_CHANNEL })}</span>
          <span className="tm-wc-glyph tm-wc-glyph--lime">
            <WebIcon name="arrow-right" size={14} />
          </span>
        </div>
      </div>
    </CommScene>
  );
}

/* ── Channels & DMs ────────────────────────────────────────────────────────── */

const CHANNELS = [
  { name: 'atlas-website-relaunch', unread: 3, on: true },
  { name: 'northstar-studio', unread: null, on: false },
  { name: 'brand-identity-sprint', unread: 1, on: false },
  { name: 'monthly-retainer', unread: null, on: false },
] as const;

export function ChannelsScene() {
  const t = useT();
  const { s, time, num } = useSceneCopy();
  return (
    <CommScene className="tm-wc-scene--card" label={t('ChannelsScene.label')}>
      <div className="tm-wc-split">
        <div className="tm-wc-side">
          <Mono>{s('channels')}</Mono>
          <ul className="tm-wc-side__list">
            {CHANNELS.map((channel) => (
              <li
                key={channel.name}
                className={cx('tm-wc-side__item', channel.on && 'tm-wc-side__item--on')}
              >
                <span>{channelLabel(channel.name)}</span>
                {channel.unread ? <span className="tm-wc-count">{num(channel.unread)}</span> : null}
              </li>
            ))}
          </ul>
          <Mono>{s('directMessages')}</Mono>
          <ul className="tm-wc-side__list">
            {['Omar Adel', 'Noor Fathy'].map((person) => (
              <li key={person} className="tm-wc-side__item tm-wc-side__item--dm">
                <Avatar name={person} size="compact" decorative className="tm-wc-avatar" />
                <span>{person}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="tm-wc-pane">
          <Message name="Omar Adel" time={time('11:02')} editedLabel={s('edited')}>
            <p>
              {s('omarBefore')} <span className="tm-wc-mention">@Maya Hassan</span> {s('omarAfter')}
            </p>
            <div className="tm-wc-file">
              <Glyph icon="doc" />
              <span className="tm-wc-linked__text">
                <span className="tm-wc-linked__title">Homepage Concept v2.pdf</span>
                <span className="tm-wc-linked__foot">
                  <Badge mono>v2</Badge>
                  <Mono>{s('fileMeta', { size: 4.2 })}</Mono>
                </span>
              </span>
            </div>
            <p className="tm-wc-reactions">
              <span className="tm-web-chip tm-wc-reaction">+1 {num(2)}</span>
              <span className="tm-web-chip tm-wc-reaction tm-web-chip--on">✓ {num(1)}</span>
            </p>
          </Message>
          <Message name="Maya Hassan" time={time('11:09')}>
            <p>{s('mayaChecked')}</p>
          </Message>
        </div>
      </div>
    </CommScene>
  );
}

/* ── Message to work (signature) ───────────────────────────────────────────── */

export function MessageToWorkScene() {
  const t = useT();
  const { s, day, time } = useSceneCopy();
  const due = day(DUE_DAY, DAY_MONTH);
  return (
    <CommScene className="tm-wc-scene--flow" label={t('MessageToWorkScene.label')}>
      <div className="tm-wc-flow">
        <div className="tm-wc-bubble">
          <Message name="Salma Riad" time={time('09:41')} audience="client" org="Atlas">
            <p>{s('salmaAsk')}</p>
          </Message>
          <div className="tm-wc-turn">
            <Mono>{s('turnInto')}</Mono>
            <span className="tm-web-chip tm-web-chip--on">{s('kindTask')}</span>
            <span className="tm-web-chip">{s('kindRequest')}</span>
            <span className="tm-web-chip">{s('kindDecision')}</span>
          </div>
          <div className="tm-wc-confirm">
            <span className="tm-wc-field">
              <Mono>{s('fieldOwner')}</Mono>
              <span>Lina Samir</span>
            </span>
            <span className="tm-wc-field">
              <Mono>{s('fieldDue')}</Mono>
              <span>{due}</span>
            </span>
            <span className="tm-wc-field">
              <Mono>{s('fieldAudience')}</Mono>
              <span>{s('audienceInternal')}</span>
            </span>
          </div>
        </div>
        <span className="tm-wc-flow__arrow">
          <WebIcon name="arrow-down" size={16} />
        </span>
        <ObjectCard
          title={s('taskConcepts')}
          meta={s('taskMeta', { date: due })}
          state={{ tone: 'current', label: s('statePlanned') }}
          owner="Lina Samir"
          secondary={s('viewMessage')}
          primary={s('openTask')}
        />
      </div>
    </CommScene>
  );
}

/* ── Calendar (section 09) ─────────────────────────────────────────────────── */

type CalEvent = {
  /** Scene key of the event title. */
  title: string;
  /** A start time `HH:MM`, a whole-hour range, or the due-today marker. */
  at: string | readonly [number, number] | 'due';
  kind: 'focus' | 'meeting' | 'client' | 'milestone';
};

const WEEK: readonly { date: string; events: readonly CalEvent[] }[] = [
  {
    date: '2025-08-18',
    events: [
      { title: 'eventFocus', at: [9, 11], kind: 'focus' },
      { title: 'eventStandup', at: '11:30', kind: 'meeting' },
      { title: 'eventCopyPass', at: '16:00', kind: 'meeting' },
    ],
  },
  {
    date: '2025-08-19',
    events: [
      { title: 'eventStandup', at: '09:30', kind: 'meeting' },
      { title: 'eventAtlasReview', at: '14:00', kind: 'client' },
      { title: 'eventFocus', at: [15, 17], kind: 'focus' },
    ],
  },
  {
    date: '2025-08-20',
    events: [
      { title: 'eventConcepts', at: 'due', kind: 'milestone' },
      { title: 'eventStandup', at: '09:30', kind: 'meeting' },
      { title: 'eventQaFocus', at: [13, 15], kind: 'focus' },
    ],
  },
  {
    date: '2025-08-21',
    events: [
      { title: 'eventDesignCrit', at: '10:00', kind: 'meeting' },
      { title: 'eventFocus', at: [11, 13], kind: 'focus' },
      { title: 'eventAtlasSignOff', at: '15:00', kind: 'client' },
    ],
  },
  {
    date: '2025-08-22',
    events: [
      { title: 'eventAtlasCall', at: '12:00', kind: 'client' },
      { title: 'eventWeekWrap', at: '16:30', kind: 'meeting' },
    ],
  },
];

export function CalendarScene() {
  const t = useT();
  const { s, day, time, num } = useSceneCopy();
  const when = (at: CalEvent['at']) => {
    if (at === 'due') return s('dueToday');
    if (typeof at === 'string') return time(at);
    return `${num(at[0], 2)}–${num(at[1], 2)}`;
  };
  return (
    <CommScene className="tm-wc-scene--card" label={t('CalendarScene.label')}>
      <div className="tm-wc-cal">
        <div className="tm-wc-cal__head">
          <div>
            <Mono>{s('calendarEyebrow')}</Mono>
            <p className="tm-wc-cal__title">{s('weekOf', { date: day(WEEK_OF, DAY_MONTH) })}</p>
          </div>
          <span className="tm-wc-cal__filters">
            <span className="tm-web-chip tm-web-chip--on">{s('filterPersonal')}</span>
            <span className="tm-web-chip">Atlas Website Relaunch</span>
          </span>
        </div>
        <div className="tm-wc-cal__grid">
          {WEEK.map((col) => (
            <div key={col.date} className="tm-wc-cal__col">
              <p className={cx('tm-wc-cal__day', col.date === DUE_DAY && 'tm-wc-cal__day--today')}>
                <Mono>{day(col.date, { weekday: 'short' })}</Mono>
                <span className="tm-wc-cal__date">{day(col.date, { day: 'numeric' })}</span>
              </p>
              {col.events.map((event) => (
                <div
                  key={`${event.title}-${String(event.at)}`}
                  className={cx('tm-wc-event', `tm-wc-event--${event.kind}`)}
                >
                  <span className="tm-wc-event__title">
                    {event.kind === 'milestone' ? <WebIcon name="flag" size={14} /> : null}
                    {s(event.title)}
                  </span>
                  <span className="tm-wc-event__time">{when(event.at)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </CommScene>
  );
}

/* ── Meetings ──────────────────────────────────────────────────────────────── */

export function MeetingScene() {
  const t = useT();
  const { s, day, time } = useSceneCopy();
  return (
    <CommScene className="tm-wc-scene--card" label={t('MeetingScene.label')}>
      <div className="tm-wc-meet">
        <Mono>
          {s('meetingEyebrow', {
            date: day('2025-08-19', WEEKDAY_DAY_MONTH),
            time: time('14:00'),
            n: 30,
          })}
        </Mono>
        <div className="tm-wc-meet__title-row">
          <p className="tm-wc-meet__title">{s('meetingTitle')}</p>
          <span className="tm-wc-stack">
            <Avatar name="Maya Hassan" size="compact" decorative className="tm-wc-avatar" />
            <Avatar name="Lina Samir" size="compact" decorative className="tm-wc-avatar" />
            <Avatar
              name="Salma Riad"
              size="compact"
              audience="client"
              decorative
              className="tm-wc-avatar"
            />
            <Avatar
              name="Youssef Kamal"
              size="compact"
              audience="client"
              decorative
              className="tm-wc-avatar"
            />
          </span>
        </div>
        <div className="tm-wc-meet__block">
          <Mono>{s('agenda')}</Mono>
          <ul className="tm-wc-meet__agenda">
            <li>
              <WebIcon name="check" size={14} />
              {s('agendaMobile')}
            </li>
            <li>
              <WebIcon name="check" size={14} />
              {s('agendaOffers')}
            </li>
          </ul>
        </div>
        <div className="tm-wc-meet__block">
          <Mono>{s('decision')}</Mono>
          <div className="tm-wc-row">
            <Badge mono>DEC-42</Badge>
            <span className="tm-wc-row__title">{s('decisionTitle')}</span>
            <StateCapsule state="done">{s('decided')}</StateCapsule>
          </div>
        </div>
        <div className="tm-wc-meet__block">
          <Mono>{s('actions', { n: 2 })}</Mono>
          <div className="tm-wc-row">
            <Avatar name="Lina Samir" size="compact" decorative className="tm-wc-avatar" />
            <span className="tm-wc-row__text">
              <span className="tm-wc-row__title">{s('taskConcepts')}</span>
              <Mono>{s('dueOn', { date: day(DUE_DAY, DAY_MONTH) })}</Mono>
            </span>
            <StateCapsule state="current">{s('inWork', { name: 'Lina' })}</StateCapsule>
          </div>
          <div className="tm-wc-row">
            <Avatar name="Omar Adel" size="compact" decorative className="tm-wc-avatar" />
            <span className="tm-wc-row__text">
              <span className="tm-wc-row__title">{s('taskOffersCopy')}</span>
              <Mono>{s('dueOn', { date: day('2025-08-21', DAY_MONTH) })}</Mono>
            </span>
            <StateCapsule state="current">{s('inWork', { name: 'Omar' })}</StateCapsule>
          </div>
        </div>
        <div className="tm-wc-meet__foot">
          <Button tone="outline" size="default">
            {s('shareNotes')}
          </Button>
          <Button tone="ink" size="default">
            {s('closeMeeting')}
          </Button>
        </div>
      </div>
    </CommScene>
  );
}

/* ── CTA visual: the daily digest ──────────────────────────────────────────── */

export function DigestScene() {
  const t = useT();
  const { s, day, num } = useSceneCopy();
  return (
    <CommScene className="tm-wc-scene--card tm-wc-scene--digest" label={t('DigestScene.label')}>
      <div className="tm-wc-digest">
        <Mono>{s('digestEyebrow', { date: day('2025-08-19', WEEKDAY_DAY_MONTH) })}</Mono>
        <p className="tm-wc-digest__title">{s('digestTitle', { n: 3 })}</p>
        <div className="tm-wc-row">
          <span className="tm-wc-rank">{num(1)}</span>
          <span className="tm-wc-row__title">{s('digestConcept')}</span>
          <StateCapsule state="client">{s('digestClient')}</StateCapsule>
        </div>
        <div className="tm-wc-row">
          <span className="tm-wc-rank">{num(2)}</span>
          <span className="tm-wc-row__title">{s('digestMobile')}</span>
          <StateCapsule state="waiting">{s('digestDue')}</StateCapsule>
        </div>
        <div className="tm-wc-row">
          <span className="tm-wc-rank">{num(3)}</span>
          <span className="tm-wc-row__title">
            {s('digestNew', { n: 4, channel: HERO_CHANNEL })}
          </span>
          <StateCapsule state="neutral">{s('digestRead')}</StateCapsule>
        </div>
      </div>
    </CommScene>
  );
}
