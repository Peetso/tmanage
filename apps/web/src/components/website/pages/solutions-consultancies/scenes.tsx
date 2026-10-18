'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Product scenes for Solutions · Consultancies — small, real TManage screens composed from
 * packages/ui parts (StateCapsule, Badge, Avatar, Button) inside a browser-window frame. They are
 * illustrations: the body is `inert` and hidden from assistive tech, and `label` gives one
 * sentence of alternative text instead.
 */
function AppWindow({
  url,
  label,
  tone = 'surface',
  className,
  children,
}: {
  url: string;
  label: string;
  tone?: 'surface' | 'sunken';
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-consult-window', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-consult-window__frame" aria-hidden="true" inert>
        <div className="tm-consult-window__bar">
          <span className="tm-consult-window__dots">
            <span />
            <span />
            <span />
          </span>
          <span className="tm-consult-window__url">{url}</span>
        </div>
        <div className={cx('tm-consult-window__body', `tm-consult-window__body--${tone}`)}>
          {children}
        </div>
      </div>
    </figure>
  );
}

/* ── Hero: the decision register ──────────────────────────────────────────────── */

const DECISIONS = [
  {
    id: 'DEC-41',
    text: 'Offers strip moves below the rooms grid',
    owner: 'Lina Samir',
    date: '24 Aug',
    affects: '2 items',
  },
  {
    id: 'DEC-40',
    text: 'Booking CTA stays above the fold on mobile',
    owner: 'Omar Adel',
    date: '21 Aug',
    affects: '4 items',
  },
  {
    id: 'DEC-37',
    text: 'Launch commits to 30 September',
    owner: 'Omar Adel',
    date: '12 Jul',
    affects: '1 milestone',
  },
  {
    id: 'DEC-33',
    text: 'Arabic is in scope for phase one',
    owner: 'Maya Hassan',
    date: '18 Jul',
    affects: '3 items',
  },
] as const;

export function DecisionRegisterScene() {
  return (
    <AppWindow
      url="app.tmanage.com/decisions"
      label="The decision register: five decisions with an owner, an effective date and the work each one affects; one is superseded by a newer decision."
      className="tm-consult-window--hero"
    >
      <div className="tm-consult-register">
        <div className="tm-consult-register__row tm-consult-register__row--head">
          <span>ID</span>
          <span>Statement</span>
          <span>Owner</span>
          <span>Effective</span>
          <span>Affects</span>
        </div>
        {DECISIONS.map((decision, index) => (
          <div
            key={decision.id}
            className={cx(
              'tm-consult-register__row',
              index === 0 && 'tm-consult-register__row--selected',
            )}
          >
            <span className="tm-consult-mono">{decision.id}</span>
            <span className="tm-consult-register__text">
              <span className="tm-consult-clip">{decision.text}</span>
            </span>
            <span className="tm-consult-register__owner">{decision.owner}</span>
            <span className="tm-consult-mono">{decision.date}</span>
            <span className="tm-consult-register__affects">{decision.affects}</span>
          </div>
        ))}
        <div className="tm-consult-register__row tm-consult-register__row--superseded">
          <span className="tm-consult-mono">DEC-29</span>
          <span className="tm-consult-register__text">
            <span className="tm-consult-clip">Offers hero above the rooms grid</span>
            <Badge mono>Superseded by DEC-41</Badge>
          </span>
          <span className="tm-consult-register__owner">Lina Samir</span>
          <span className="tm-consult-mono">6 Jul</span>
          <span className="tm-consult-register__affects">—</span>
        </div>
        <div className="tm-consult-register__foot">
          <span className="tm-consult-mono">5 decisions · 1 superseded</span>
          <StateCapsule state="client">2 visible to Atlas Hospitality</StateCapsule>
        </div>
      </div>
    </AppWindow>
  );
}

/* ── Row 1: the engagement story (Work Story timeline) ────────────────────────── */

type StoryTone = 'done' | 'collapsed' | 'now' | 'next';

const STORY: readonly { tone: StoryTone; meta: string; title: string; sub?: string }[] = [
  {
    tone: 'done',
    meta: 'Scoped · 22 Jul · Omar Adel',
    title: 'Project created with a 30 September launch commitment',
  },
  {
    tone: 'done',
    meta: 'Decided · 28 Jul · Maya Hassan',
    title: 'Discovery closed with three findings',
    sub: 'Evidence: discovery summary v3, approved by Salma Riad',
  },
  { tone: 'collapsed', meta: '12 earlier chapters collapsed', title: 'Show them' },
  {
    tone: 'done',
    meta: 'Published · 13 Aug · Omar Adel',
    title: 'Homepage Concept v2 sent to Atlas Hospitality',
    sub: 'v2 · 8f3c-d41a · 2 recipients · 4 internal comments excluded',
  },
  {
    tone: 'now',
    meta: 'Now · awaiting a client decision',
    title: 'Youssef Kamal has not opened the approval · 26h',
  },
  { tone: 'next', meta: 'Next', title: 'Content migration begins on approval' },
];

export function EngagementStoryScene() {
  return (
    <AppWindow
      url="app.tmanage.com/engagements/story"
      label="An engagement's Work Story: scoping, discovery findings, a published concept, and the client decision it is waiting on now."
    >
      <ol className="tm-consult-story">
        {STORY.map((step) => (
          <li key={step.meta} className={cx('tm-consult-story__step', `is-${step.tone}`)}>
            <span className="tm-consult-story__dot" />
            <span className="tm-consult-mono">{step.meta}</span>
            <span className="tm-consult-story__title">{step.title}</span>
            {step.sub ? <span className="tm-consult-story__sub">{step.sub}</span> : null}
          </li>
        ))}
      </ol>
    </AppWindow>
  );
}

/* ── Row 2: one decision with its evidence and audit trail ────────────────────── */

export function DecisionDetailScene() {
  return (
    <AppWindow
      url="app.tmanage.com/decisions/detail"
      tone="sunken"
      label="A decision record with its owner, rationale, supporting evidence, related items and an audit trail of who recorded and approved it."
    >
      <div className="tm-consult-detail">
        <div className="tm-consult-detail__main">
          <p className="tm-consult-detail__crumbs">
            <span className="tm-consult-mono">DEC-40 · Atlas Website Relaunch</span>
            <StateCapsule state="done">Active</StateCapsule>
            <Badge tone="client">Client visible</Badge>
          </p>
          <p className="tm-consult-detail__title">
            The booking call to action stays above the fold on mobile
          </p>
          <div className="tm-consult-detail__card">
            <dl className="tm-consult-detail__facts">
              <div>
                <dt>Owner</dt>
                <dd>Omar Adel</dd>
              </div>
              <div>
                <dt>Effective</dt>
                <dd>21 Aug 2026</dd>
              </div>
              <div>
                <dt>Affects</dt>
                <dd>4 work items</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>Client approval</dd>
              </div>
            </dl>
            <p className="tm-consult-mono">Rationale</p>
            <p className="tm-consult-detail__text">
              Mobile guests book from the first screen; every test session lost a step when the
              button moved below the offers strip.
            </p>
            <p className="tm-consult-mono">Supporting evidence · 2</p>
            <div className="tm-consult-detail__evidence">
              <span>Mobile usability test</span>
              <span>Linked to finding F-07</span>
            </div>
            <div className="tm-consult-detail__evidence">
              <span>Booking funnel review</span>
              <span>Approved by Salma Riad</span>
            </div>
          </div>
        </div>
        <div className="tm-consult-detail__side">
          <div className="tm-consult-detail__related">
            <p className="tm-consult-mono">Related · 4</p>
            <span>
              <WebIcon name="doc" size={14} />
              Homepage Concept v2
            </span>
            <span>
              <WebIcon name="work" size={14} />
              Mobile booking flow
            </span>
            <span>
              <WebIcon name="flag" size={14} />
              Discovery findings
            </span>
          </div>
          <div className="tm-consult-detail__audit">
            <p className="tm-consult-mono">Audit trail</p>
            <span className="is-lime">
              <b>21 Aug · 10:14</b>
              Recorded by Omar Adel
            </span>
            <span>
              <b>21 Aug · 11:02</b>
              Approved by Salma Riad, client
            </span>
            <span>
              <b>22 Aug · 09:30</b>
              Linked to 4 work items
            </span>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

/* ── Row 3: the steering-committee health view ─────────────────────────────────── */

const HEALTH = [
  {
    name: 'Atlas Website Relaunch',
    client: 'Atlas Hospitality',
    done: 2,
    current: 1,
    left: 2,
    state: { tone: 'waiting', label: 'At risk' },
  },
  {
    name: 'Pricing review',
    client: 'Northstar Studio',
    done: 1,
    current: 1,
    left: 3,
    state: { tone: 'current', label: 'On track' },
  },
  {
    name: 'Operating model study',
    client: 'Atlas Hospitality',
    done: 3,
    current: 1,
    left: 1,
    state: { tone: 'done', label: 'Ahead' },
  },
] as const;

export function SteeringHealthScene() {
  return (
    <AppWindow
      url="app.tmanage.com/insights/health"
      tone="sunken"
      label="The portfolio health view: two projects at risk, six decisions waiting on the client, and a drafted steering update ready to send to the client portal."
    >
      <div className="tm-consult-health">
        <div className="tm-consult-health__head">
          <p className="tm-consult-health__title">Which promises are still true</p>
          <span className="tm-web-chip">Clients</span>
          <span className="tm-web-chip tm-web-chip--on">This week</span>
        </div>
        <div className="tm-consult-health__metrics">
          <div>
            <b>2</b>
            <span>projects at risk</span>
          </div>
          <div>
            <b>6</b>
            <span>decisions waiting on the client</span>
          </div>
          <div>
            <b>9</b>
            <span>committed dates this week</span>
          </div>
        </div>
        <div className="tm-consult-health__grid">
          <div className="tm-consult-health__table">
            {HEALTH.map((row) => (
              <div key={row.name} className="tm-consult-health__row">
                <span className="tm-consult-health__name">
                  <span className="tm-consult-clip">{row.name}</span>
                  <small className="tm-consult-clip">{row.client}</small>
                </span>
                <span className="tm-consult-health__bar">
                  {Array.from({ length: row.done }, (_, i) => (
                    <i key={`d${i}`} className="is-done" />
                  ))}
                  {Array.from({ length: row.current }, (_, i) => (
                    <i key={`c${i}`} className="is-current" />
                  ))}
                  {Array.from({ length: row.left }, (_, i) => (
                    <i key={`l${i}`} />
                  ))}
                </span>
                <StateCapsule state={row.state.tone}>{row.state.label}</StateCapsule>
              </div>
            ))}
          </div>
          <div className="tm-consult-health__draft">
            <p className="tm-consult-mono">Update · draft</p>
            <p className="tm-consult-health__draft-title">
              One decision from Youssef Kamal returns 2 days to the plan.
            </p>
            <div className="tm-consult-health__draft-by">
              <Avatar name="Omar Adel" size="compact" decorative />
              <span>Omar Adel</span>
            </div>
            <Button tone="ink" size="feature">
              Send to portal
            </Button>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
