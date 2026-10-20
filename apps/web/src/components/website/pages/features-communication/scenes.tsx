'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { ObjectCard } from '../../ProductScenes';
import { cx } from '../../primitives';

/**
 * Mini product scenes for Features · Chat & calendar (WEB-04). Composed from packages/ui parts
 * (Avatar, Badge, Button, StateCapsule) and the shared Card/Object, on Limeframe tokens only.
 * They are illustrations: the body is `inert` and hidden from assistive tech, and `label` is the
 * one sentence of alternative text.
 */
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
  edited = false,
}: {
  name: string;
  time: string;
  audience?: 'internal' | 'client';
  org?: string;
  children: ReactNode;
  edited?: boolean;
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
          {edited ? <span className="tm-wc-msg__edited">(edited)</span> : null}
        </p>
        <div className="tm-wc-msg__text">{children}</div>
      </div>
    </div>
  );
}

/* ── Hero: the project channel (chat screen, section 07) ───────────────────── */

export function ChannelScene() {
  const t = useT();
  return (
    <CommScene
      address="tmanage.app / northstar / chat / atlas-website-relaunch"
      className="tm-wc-scene--hero"
      label={t('ChannelScene.label')}
    >
      <div className="tm-wc-chat">
        <div className="tm-wc-chat__head">
          <Mono className="tm-wc-chat__eyebrow">Project channel · Atlas Website Relaunch</Mono>
          <div className="tm-wc-chat__title-row">
            <p className="tm-wc-chat__title"># atlas-website-relaunch</p>
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
              <span className="tm-wc-more tm-wc-more--wide">+3</span>
              <span className="tm-wc-more tm-wc-more--narrow">+5</span>
            </span>
          </div>
          <p className="tm-wc-chat__meta">7 members · 2 from Atlas Hospitality</p>
        </div>
        <div className="tm-wc-chat__list">
          <Message name="Maya Hassan" time="10:14">
            <p>
              Salma wants to see the booking flow on mobile before Thursday&apos;s review. Who can
              take it?
            </p>
            <p className="tm-wc-reactions">
              <span className="tm-web-chip tm-wc-reaction tm-web-chip--on">✓ 3</span>
              <span className="tm-wc-thread">
                <WebIcon name="chat" size={14} />3 replies · last 10:32
              </span>
            </p>
          </Message>
          <Message name="Lina Samir" time="10:20">
            <p>I can have two concepts ready by the 20th.</p>
            <div className="tm-wc-linked">
              <Glyph icon="check" tone="lime" />
              <span className="tm-wc-linked__text">
                <span className="tm-wc-linked__title">Prepare mobile booking flow concepts</span>
                <span className="tm-wc-linked__foot">
                  <StateCapsule state="current">Lina · due 20 Aug</StateCapsule>
                  <Mono>Task · from this message</Mono>
                </span>
              </span>
            </div>
          </Message>
        </div>
        <div className="tm-wc-composer">
          <span className="tm-wc-composer__field">Message #atlas-website-relaunch</span>
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
  { name: 'atlas-website-relaunch', unread: '3', on: true },
  { name: 'northstar-studio', unread: null, on: false },
  { name: 'brand-identity-sprint', unread: '1', on: false },
  { name: 'monthly-retainer', unread: null, on: false },
] as const;

export function ChannelsScene() {
  const t = useT();
  return (
    <CommScene className="tm-wc-scene--card" label={t('ChannelsScene.label')}>
      <div className="tm-wc-split">
        <div className="tm-wc-side">
          <Mono>Channels</Mono>
          <ul className="tm-wc-side__list">
            {CHANNELS.map((channel) => (
              <li
                key={channel.name}
                className={cx('tm-wc-side__item', channel.on && 'tm-wc-side__item--on')}
              >
                <span># {channel.name}</span>
                {channel.unread ? <span className="tm-wc-count">{channel.unread}</span> : null}
              </li>
            ))}
          </ul>
          <Mono>Direct messages</Mono>
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
          <Message name="Omar Adel" time="11:02" edited>
            <p>
              New hero options are in the file. <span className="tm-wc-mention">@Maya Hassan</span>{' '}
              can you check the Arabic headline before it goes to Atlas?
            </p>
            <div className="tm-wc-file">
              <Glyph icon="doc" />
              <span className="tm-wc-linked__text">
                <span className="tm-wc-linked__title">Homepage Concept v2.pdf</span>
                <span className="tm-wc-linked__foot">
                  <Badge mono>v2</Badge>
                  <Mono>4.2 MB · scanned</Mono>
                </span>
              </span>
            </div>
            <p className="tm-wc-reactions">
              <span className="tm-web-chip tm-wc-reaction">+1 2</span>
              <span className="tm-web-chip tm-wc-reaction tm-web-chip--on">✓ 1</span>
            </p>
          </Message>
          <Message name="Maya Hassan" time="11:09">
            <p>Checked. The headline reads right in both languages.</p>
          </Message>
        </div>
      </div>
    </CommScene>
  );
}

/* ── Message to work (signature) ───────────────────────────────────────────── */

export function MessageToWorkScene() {
  const t = useT();
  return (
    <CommScene className="tm-wc-scene--flow" label={t('MessageToWorkScene.label')}>
      <div className="tm-wc-flow">
        <div className="tm-wc-bubble">
          <Message name="Salma Riad" time="09:41" audience="client" org="Atlas">
            <p>Could we see the booking flow on mobile before the review?</p>
          </Message>
          <div className="tm-wc-turn">
            <Mono>Turn into</Mono>
            <span className="tm-web-chip tm-web-chip--on">Task</span>
            <span className="tm-web-chip">Request</span>
            <span className="tm-web-chip">Decision</span>
          </div>
          <div className="tm-wc-confirm">
            <span className="tm-wc-field">
              <Mono>Owner</Mono>
              <span>Lina Samir</span>
            </span>
            <span className="tm-wc-field">
              <Mono>Due</Mono>
              <span>20 Aug</span>
            </span>
            <span className="tm-wc-field">
              <Mono>Audience</Mono>
              <span>Internal</span>
            </span>
          </div>
        </div>
        <span className="tm-wc-flow__arrow">
          <WebIcon name="arrow-down" size={16} />
        </span>
        <ObjectCard
          title="Prepare mobile booking flow concepts"
          meta="Atlas Website Relaunch · Lina · due 20 Aug · linked to Salma's message"
          state={{ tone: 'current', label: 'Planned' }}
          owner="Lina Samir"
          secondary="View message"
          primary="Open task"
        />
      </div>
    </CommScene>
  );
}

/* ── Calendar (section 09) ─────────────────────────────────────────────────── */

type CalEvent = {
  title: string;
  time: string;
  kind: 'focus' | 'meeting' | 'client' | 'milestone';
};

const WEEK: readonly { day: string; date: string; events: readonly CalEvent[] }[] = [
  {
    day: 'Mon',
    date: '18',
    events: [
      { title: 'Focus block', time: '09–11', kind: 'focus' },
      { title: 'Stand-up', time: '11:30', kind: 'meeting' },
      { title: 'Copy pass', time: '16:00', kind: 'meeting' },
    ],
  },
  {
    day: 'Tue',
    date: '19',
    events: [
      { title: 'Stand-up', time: '09:30', kind: 'meeting' },
      { title: 'Atlas review', time: '14:00', kind: 'client' },
      { title: 'Focus block', time: '15–17', kind: 'focus' },
    ],
  },
  {
    day: 'Wed',
    date: '20',
    events: [
      { title: 'Concepts', time: 'Due today', kind: 'milestone' },
      { title: 'Stand-up', time: '09:30', kind: 'meeting' },
      { title: 'QA focus', time: '13–15', kind: 'focus' },
    ],
  },
  {
    day: 'Thu',
    date: '21',
    events: [
      { title: 'Design crit', time: '10:00', kind: 'meeting' },
      { title: 'Focus block', time: '11–13', kind: 'focus' },
      { title: 'Atlas sign-off', time: '15:00', kind: 'client' },
    ],
  },
  {
    day: 'Fri',
    date: '22',
    events: [
      { title: 'Atlas call', time: '12:00', kind: 'client' },
      { title: 'Week wrap', time: '16:30', kind: 'meeting' },
    ],
  },
];

export function CalendarScene() {
  const t = useT();
  return (
    <CommScene className="tm-wc-scene--card" label={t('CalendarScene.label')}>
      <div className="tm-wc-cal">
        <div className="tm-wc-cal__head">
          <div>
            <Mono>Calendar · Lina Samir</Mono>
            <p className="tm-wc-cal__title">Week of 18 Aug</p>
          </div>
          <span className="tm-wc-cal__filters">
            <span className="tm-web-chip tm-web-chip--on">Personal</span>
            <span className="tm-web-chip">Atlas Website Relaunch</span>
          </span>
        </div>
        <div className="tm-wc-cal__grid">
          {WEEK.map((col) => (
            <div key={col.day} className="tm-wc-cal__col">
              <p className={cx('tm-wc-cal__day', col.date === '20' && 'tm-wc-cal__day--today')}>
                <Mono>{col.day}</Mono>
                <span className="tm-wc-cal__date">{col.date}</span>
              </p>
              {col.events.map((event) => (
                <div
                  key={`${event.title}-${event.time}`}
                  className={cx('tm-wc-event', `tm-wc-event--${event.kind}`)}
                >
                  <span className="tm-wc-event__title">
                    {event.kind === 'milestone' ? <WebIcon name="flag" size={14} /> : null}
                    {event.title}
                  </span>
                  <span className="tm-wc-event__time">{event.time}</span>
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
  return (
    <CommScene className="tm-wc-scene--card" label={t('MeetingScene.label')}>
      <div className="tm-wc-meet">
        <Mono>Meeting · Tue 19 Aug · 14:00 · 30 min</Mono>
        <div className="tm-wc-meet__title-row">
          <p className="tm-wc-meet__title">Homepage review with Atlas</p>
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
          <Mono>Agenda</Mono>
          <ul className="tm-wc-meet__agenda">
            <li>
              <WebIcon name="check" size={14} />
              Booking flow on mobile
            </li>
            <li>
              <WebIcon name="check" size={14} />
              Where the offers strip sits
            </li>
          </ul>
        </div>
        <div className="tm-wc-meet__block">
          <Mono>Decision</Mono>
          <div className="tm-wc-row">
            <Badge mono>DEC-42</Badge>
            <span className="tm-wc-row__title">Booking widget stays above the fold</span>
            <StateCapsule state="done">Decided</StateCapsule>
          </div>
        </div>
        <div className="tm-wc-meet__block">
          <Mono>Actions · 2</Mono>
          <div className="tm-wc-row">
            <Avatar name="Lina Samir" size="compact" decorative className="tm-wc-avatar" />
            <span className="tm-wc-row__text">
              <span className="tm-wc-row__title">Prepare mobile booking flow concepts</span>
              <Mono>due 20 Aug</Mono>
            </span>
            <StateCapsule state="current">In Lina&apos;s work</StateCapsule>
          </div>
          <div className="tm-wc-row">
            <Avatar name="Omar Adel" size="compact" decorative className="tm-wc-avatar" />
            <span className="tm-wc-row__text">
              <span className="tm-wc-row__title">Send revised offers copy</span>
              <Mono>due 21 Aug</Mono>
            </span>
            <StateCapsule state="current">In Omar&apos;s work</StateCapsule>
          </div>
        </div>
        <div className="tm-wc-meet__foot">
          <Button tone="outline" size="default">
            Share notes
          </Button>
          <Button tone="ink" size="default">
            Close meeting
          </Button>
        </div>
      </div>
    </CommScene>
  );
}

/* ── CTA visual: the daily digest ──────────────────────────────────────────── */

export function DigestScene() {
  const t = useT();
  return (
    <CommScene className="tm-wc-scene--card tm-wc-scene--digest" label={t('DigestScene.label')}>
      <div className="tm-wc-digest">
        <Mono>Daily digest · Tue 19 Aug</Mono>
        <p className="tm-wc-digest__title">3 things, ranked by consequence</p>
        <div className="tm-wc-row">
          <span className="tm-wc-rank">1</span>
          <span className="tm-wc-row__title">Concept v2 waits on Youssef</span>
          <StateCapsule state="client">Client</StateCapsule>
        </div>
        <div className="tm-wc-row">
          <span className="tm-wc-rank">2</span>
          <span className="tm-wc-row__title">Mobile concepts due tomorrow</span>
          <StateCapsule state="waiting">Due</StateCapsule>
        </div>
        <div className="tm-wc-row">
          <span className="tm-wc-rank">3</span>
          <span className="tm-wc-row__title">4 new in #atlas-website-relaunch</span>
          <StateCapsule state="neutral">Read</StateCapsule>
        </div>
      </div>
    </CommScene>
  );
}
