'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, StatusDot } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Home-page product scenes (WEB-01). Each one is a small piece of real TManage UI composed from
 * packages/ui parts (StateCapsule, Badge, Avatar, Button, StatusDot) and the website chips — an
 * illustration, so the body is `inert` and hidden from assistive tech and `label` stands in.
 * Seed data only: Northstar Studio, Atlas Hospitality, "Atlas Website Relaunch".
 */
function HomeScene({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-scene', 'tm-home-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body tm-home-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

/* ── Hero: the work story of one deliverable, with three floating cards ─────── */

type StepTone = 'done' | 'current' | 'future';

const HERO_STEPS: readonly {
  n: string;
  step: string;
  detail: string;
  who: string;
  tone: StepTone;
}[] = [
  { n: '01', step: 'Request', detail: 'Arabic FAQ asked in chat', who: 'Salma Riad', tone: 'done' },
  { n: '02', step: 'Clarify', detail: 'Scope agreed in thread', who: 'Maya Hassan', tone: 'done' },
  { n: '03', step: 'Commit', detail: 'Committed for 24 Aug', who: 'Omar Adel', tone: 'done' },
  {
    n: '04',
    step: 'Plan',
    detail: 'Milestone · Homepage direction',
    who: 'Lina Samir',
    tone: 'done',
  },
  { n: '05', step: 'Review', detail: 'Homepage Concept v2', who: 'Karim Nabil', tone: 'current' },
];

export function HeroStoryScene() {
  return (
    <HomeScene
      label="One work story in TManage: a request from chat moves through clarify, commit and plan to review, with the client waiting on Homepage Concept v2 and an approval stamped for version 2."
      className="tm-home-hero-scene"
    >
      <div className="tm-home-float-row tm-home-float-row--top">
        <div className="tm-home-float tm-home-float--client">
          <StateCapsule state="client">Client</StateCapsule>
          <p className="tm-home-float__text">Homepage Concept v2 · waiting for Youssef</p>
        </div>
      </div>

      <div className="tm-home-story">
        <div className="tm-home-story__head">
          <p className="tm-web-scene__mono tm-home-story__eyebrow">
            Atlas Website Relaunch · Work story
          </p>
          <p className="tm-home-story__title">Homepage Concept v2</p>
          <p className="tm-home-scene__meta">Northstar Studio → Atlas Hospitality</p>
        </div>
        <ol className="tm-home-story__steps">
          {HERO_STEPS.map((s) => (
            <li key={s.n} className={cx('tm-home-story__step', `tm-home-story__step--${s.tone}`)}>
              <span className="tm-home-story__n">{s.n}</span>
              <StateCapsule state={s.tone}>{s.step}</StateCapsule>
              <span className="tm-home-story__detail">{s.detail}</span>
              <Avatar name={s.who} size="compact" decorative className="tm-home-scene__avatar" />
            </li>
          ))}
        </ol>
      </div>

      <div className="tm-home-float-row tm-home-float-row--bottom">
        <div className="tm-home-float tm-home-float--chat">
          <div className="tm-home-bubble">
            <Avatar name="Salma Riad" audience="client" size="compact" decorative />
            <div className="tm-home-bubble__text">
              <p className="tm-home-bubble__who">Salma Riad · Atlas Hospitality</p>
              <p>Can we add an Arabic FAQ before launch?</p>
            </div>
          </div>
          <span className="tm-web-chip tm-web-chip--on tm-home-float__chip">
            <WebIcon name="arrow-right" size={14} />
            Request created
          </span>
        </div>

        <div className="tm-home-float tm-home-float--badge">
          <Badge>
            <WebIcon name="check" size={14} />
            Approved · v2 · 18 Aug
          </Badge>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Team row A: a chat thread where a message becomes work ─────────────────── */

export function ChatThreadScene() {
  return (
    <HomeScene
      label="A chat thread in Atlas Website Relaunch where a client question is turned into a request, with the source message linked and the audience kept internal."
      className="tm-home-panel-scene"
    >
      <div className="tm-home-panel">
        <div className="tm-home-panel__bar">
          <span className="tm-home-panel__title">
            <WebIcon name="chat" size={16} />
            atlas-website-relaunch
          </span>
          <Badge mono>Internal</Badge>
        </div>
        <div className="tm-home-thread">
          <div className="tm-home-msg">
            <Avatar
              name="Maya Hassan"
              size="compact"
              decorative
              className="tm-home-scene__avatar"
            />
            <div className="tm-home-msg__body">
              <p className="tm-home-msg__who">
                Maya Hassan <span>10:42</span>
              </p>
              <p>Salma asked for an Arabic FAQ on the new homepage. Who can take it?</p>
            </div>
          </div>
          <div className="tm-home-msg tm-home-msg--picked">
            <Avatar name="Omar Adel" size="compact" decorative className="tm-home-scene__avatar" />
            <div className="tm-home-msg__body">
              <p className="tm-home-msg__who">
                Omar Adel <span>10:44</span>
              </p>
              <p>I can draft it this week if it lands before the 24th.</p>
              <div className="tm-home-convert">
                <span className="tm-web-chip">Task</span>
                <span className="tm-web-chip tm-web-chip--on">Request</span>
                <span className="tm-web-chip">Decision</span>
              </div>
            </div>
          </div>
          <div className="tm-home-created">
            <StateCapsule state="current">REQ-38</StateCapsule>
            <span className="tm-home-created__text">Arabic FAQ before launch</span>
            <span className="tm-home-scene__meta">Linked to this thread</span>
          </div>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Team row B: My Day, ranked by consequence ──────────────────────────────── */

const MY_DAY: readonly {
  title: string;
  why: string;
  state: 'client' | 'blocked' | 'current' | 'waiting';
  label: string;
}[] = [
  {
    title: 'Approve Homepage Concept v2 copy',
    why: 'Youssef is waiting · launch in 6 days',
    state: 'client',
    label: 'Client waiting',
  },
  {
    title: 'Unblock mobile booking flow',
    why: 'Blocks 3 tasks on the current milestone',
    state: 'blocked',
    label: 'Blocked',
  },
  {
    title: 'Draft the Arabic FAQ',
    why: 'Committed for 24 Aug',
    state: 'current',
    label: 'In progress',
  },
  {
    title: 'Review photography shortlist',
    why: 'Lina asked for your view',
    state: 'waiting',
    label: 'Waiting',
  },
];

export function MyDayScene() {
  return (
    <HomeScene
      label="My Day for Omar Adel: four items ranked by consequence, each with the reason it is there — a client waiting, a blocker, a commitment and a review."
      className="tm-home-panel-scene"
    >
      <div className="tm-home-panel">
        <div className="tm-home-panel__bar">
          <span className="tm-home-panel__title">
            <WebIcon name="flag" size={16} />
            My Day · Tuesday
          </span>
          <span className="tm-home-scene__meta">4 items · ranked by consequence</span>
        </div>
        <ol className="tm-home-list">
          {MY_DAY.map((item, i) => (
            <li key={item.title} className="tm-home-list__row">
              <span className="tm-home-story__n">{String(i + 1).padStart(2, '0')}</span>
              <span className="tm-home-list__text">
                <span className="tm-home-list__title">{item.title}</span>
                <span className="tm-home-scene__meta">{item.why}</span>
              </span>
              <StateCapsule state={item.state}>{item.label}</StateCapsule>
            </li>
          ))}
        </ol>
      </div>
    </HomeScene>
  );
}

/* ── Clients: the portal overview your client sees ──────────────────────────── */

export function PortalScene({ label }: { label?: string }) {
  return (
    <HomeScene
      label={
        label ??
        'The Atlas Hospitality client portal: the website relaunch is on track, the homepage direction milestone is current, and one action waits for the client — approve Homepage Concept v2.'
      }
      className="tm-home-panel-scene"
    >
      <div className="tm-home-panel tm-home-portal">
        <div className="tm-home-panel__bar">
          <span className="tm-home-portal__org">
            <Avatar name="Atlas Hospitality" audience="client" size="compact" decorative />
            <span className="tm-home-list__text">
              <span className="tm-home-list__title">Atlas Hospitality</span>
              <span className="tm-home-scene__meta">Delivered by Northstar Studio</span>
            </span>
          </span>
          <Badge tone="client">Client portal</Badge>
        </div>
        <div className="tm-home-portal__main">
          <p className="tm-web-scene__mono">Your project · On track</p>
          <p className="tm-home-story__title">Website relaunch</p>
          <p className="tm-home-scene__meta">
            Everything is moving toward the 30 Sep launch. One decision from you keeps it there.
          </p>
          <div className="tm-home-portal__track">
            <StateCapsule state="done">Discovery</StateCapsule>
            <StateCapsule state="current">Homepage direction</StateCapsule>
            <StateCapsule state="future">Launch</StateCapsule>
          </div>
          <div className="tm-home-action">
            <div className="tm-home-action__head">
              <span className="tm-home-list__title">Approve the homepage direction</span>
              <StateCapsule state="client">Your turn</StateCapsule>
            </div>
            <p className="tm-home-scene__meta">Homepage Concept v2 · waiting for you since Tue</p>
            <div className="tm-home-action__foot">
              <Avatar
                name="Maya Hassan"
                size="compact"
                decorative
                className="tm-home-scene__avatar"
              />
              <span className="tm-web-object__actions">
                <Button tone="outline" size="compact">
                  Open
                </Button>
                <Button tone="ink" size="compact">
                  Approve
                </Button>
              </span>
            </div>
          </div>
          <p className="tm-home-portal__live">
            <StatusDot tone="live">Live now</StatusDot>
            <span className="tm-home-scene__meta">
              Omar shared Homepage Concept v2 this morning
            </span>
          </p>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Knowledge: the decision register beside the work ───────────────────────── */

export function DecisionScene() {
  return (
    <HomeScene
      label="The decision register for Atlas Website Relaunch: a photography-led homepage decision with its owner, date, linked brief and the work it explains."
      className="tm-home-panel-scene"
    >
      <div className="tm-home-panel">
        <div className="tm-home-panel__bar">
          <span className="tm-home-panel__title">
            <WebIcon name="doc" size={16} />
            Decision register
          </span>
          <span className="tm-home-scene__meta">Atlas Website Relaunch · 12 decisions</span>
        </div>
        <div className="tm-home-decision">
          <p className="tm-web-scene__mono">DEC-14 · Decided 12 Aug</p>
          <p className="tm-home-list__title tm-home-decision__title">
            The homepage leads with photography, not illustration.
          </p>
          <p className="tm-home-scene__meta">
            Chosen because guests book on the room, not the brand. Decided by Maya Hassan with Salma
            Riad.
          </p>
          <ul className="tm-home-links">
            <li>
              <WebIcon name="doc" size={14} />
              Brief · Homepage direction
              <StateCapsule state="done">Latest</StateCapsule>
            </li>
            <li>
              <WebIcon name="work" size={14} />
              DEL · Homepage Concept v2
              <StateCapsule state="client">Client review</StateCapsule>
            </li>
            <li>
              <WebIcon name="calendar" size={14} />
              Meeting · Direction review, 12 Aug
              <StateCapsule state="archived">Notes</StateCapsule>
            </li>
          </ul>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Control: access with an impact preview and an append-only log ──────────── */

export function AccessScene() {
  return (
    <HomeScene
      label="Access settings for Atlas Hospitality: a client user whose access expires on 30 September, an impact preview before a role change, and the latest audit events."
      className="tm-home-panel-scene"
    >
      <div className="tm-home-panel">
        <div className="tm-home-panel__bar">
          <span className="tm-home-panel__title">
            <WebIcon name="shield" size={16} />
            Access · Atlas Hospitality
          </span>
          <Badge mono>Audit on</Badge>
        </div>
        <ul className="tm-home-list">
          <li className="tm-home-list__row">
            <Avatar name="Youssef Kamal" audience="client" size="compact" decorative />
            <span className="tm-home-list__text">
              <span className="tm-home-list__title">Youssef Kamal</span>
              <span className="tm-home-scene__meta">Client approver · expires 30 Sep</span>
            </span>
            <StateCapsule state="client">Client</StateCapsule>
          </li>
          <li className="tm-home-list__row">
            <Avatar
              name="Karim Nabil"
              size="compact"
              decorative
              className="tm-home-scene__avatar"
            />
            <span className="tm-home-list__text">
              <span className="tm-home-list__title">Karim Nabil</span>
              <span className="tm-home-scene__meta">Specialist → Project manager</span>
            </span>
            <StateCapsule state="waiting">Pending</StateCapsule>
          </li>
        </ul>
        <div className="tm-home-impact">
          <p className="tm-web-scene__mono">Impact preview</p>
          <p className="tm-home-list__title">This change affects 3 projects and 12 work items.</p>
          <span className="tm-web-object__actions">
            <Button tone="outline" size="compact">
              Cancel
            </Button>
            <Button tone="ink" size="compact">
              Apply change
            </Button>
          </span>
        </div>
        <ul className="tm-home-audit">
          <li>
            <span className="tm-web-scene__mono">09:12</span> Maya Hassan shared Homepage Concept v2
            with the client
          </li>
          <li>
            <span className="tm-web-scene__mono">08:40</span> Client access for Salma Riad renewed
            to 31 Oct
          </li>
        </ul>
      </div>
    </HomeScene>
  );
}
