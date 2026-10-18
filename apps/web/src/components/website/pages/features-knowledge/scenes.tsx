'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import { IconOrb, cx } from '../../primitives';
import { WebIcon } from '../../WebIcon';

/**
 * Product scenes for /features/knowledge (shots/05-features-knowledge.png). Each one is real
 * TManage UI composed from packages/ui parts (StateCapsule, Badge, Avatar, InlineAlert, Button)
 * and the website's chip and orb classes — illustrations, so the body is `inert` and hidden from
 * assistive tech, with one sentence of alternative text in the caption.
 */
function Scene({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-scene', 'tm-fk-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body tm-fk-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('tm-web-scene__mono', 'tm-fk-mono', className)}>{children}</p>;
}

/* ── Hero: the "Homepage direction" decision record ─────────────────────────── */

export function DecisionRecordScene() {
  return (
    <Scene
      label="The Homepage direction decision record, decided by Maya Hassan, linked live to a deliverable in client review and the launch milestone."
      className="tm-fk-scene--hero"
    >
      <div className="tm-fk-window">
        <div className="tm-fk-window__bar">
          <span className="tm-fk-window__url">
            tmanage.app / atlas / docs /<wbr /> homepage-direction
          </span>
        </div>
        <div className="tm-fk-window__body">
          <Mono>Decision record · Atlas Website Relaunch</Mono>
          <p className="tm-fk-hero-doc__title">Homepage direction</p>
          <div className="tm-fk-byline">
            <Avatar name="Maya Hassan" decorative className="tm-fk-avatar" />
            <span className="tm-fk-byline__text">Maya Hassan · updated 26 min ago</span>
            <StateCapsule state="done">Decided</StateCapsule>
          </div>
          <p className="tm-fk-hero-doc__text">
            The booking call to action stays above the fold at every width. Offers move below the
            room grid, where guests look for them.
          </p>
          <Mono>Linked work · live</Mono>
          <div className="tm-fk-links">
            <div className="tm-fk-link-row">
              <IconOrb icon="layers" tone="lime" />
              <span className="tm-fk-link-row__text">
                <span className="tm-fk-link-row__title">Homepage Concept v2</span>
                <span className="tm-fk-link-row__meta">DELIVERABLE · v2 APPROVED</span>
              </span>
              <StateCapsule state="client">In client review</StateCapsule>
            </div>
            <div className="tm-fk-link-row">
              <IconOrb icon="flag" tone="outline" />
              <span className="tm-fk-link-row__text">
                <span className="tm-fk-link-row__title">Launch · 30 Sep</span>
                <span className="tm-fk-link-row__meta">MILESTONE · 6 OPEN ITEMS</span>
              </span>
              <StateCapsule state="current">On track</StateCapsule>
            </div>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Docs: the Atlas project brief with live work embedded ──────────────────── */

const BRIEF_TASKS: readonly {
  title: string;
  state: 'done' | 'current' | 'client';
  label: string;
  owner: string;
  client?: boolean;
  date: string;
}[] = [
  { title: 'Room grid content', state: 'done', label: 'Done', owner: 'Lina Samir', date: '12 Sep' },
  {
    title: 'Booking widget QA',
    state: 'current',
    label: 'In progress',
    owner: 'Omar Adel',
    date: '18 Sep',
  },
  {
    title: 'Homepage copy sign-off',
    state: 'client',
    label: 'With client',
    owner: 'Youssef Kamal',
    client: true,
    date: '22 Sep',
  },
];

export function ProjectBriefScene() {
  return (
    <Scene
      label="The Atlas project brief, with three tasks and the launch milestone embedded live from the work."
      className="tm-fk-scene--card"
    >
      <div className="tm-fk-card">
        <div className="tm-fk-card__head">
          <IconOrb icon="doc" tone="outline" className="tm-fk-card__orb" />
          <span className="tm-fk-link-row__text">
            <span className="tm-fk-card__title">Atlas project brief</span>
            <span className="tm-fk-link-row__meta">BRIEF · EDITED 2 MIN AGO BY LINA SAMIR</span>
          </span>
          <Badge>Internal</Badge>
        </div>
        <p className="tm-fk-card__text">
          Scope, owners and the dates we promised the client. The plan below is not a pasted table:
          it is the work itself, and it changes when the work does.
        </p>
        <div className="tm-fk-embed">
          <div className="tm-fk-embed__head">
            <Mono>Live from work · 3 tasks · 1 milestone</Mono>
            <Badge mono>synced</Badge>
          </div>
          {BRIEF_TASKS.map((task) => (
            <div key={task.title} className="tm-fk-task">
              <span className="tm-fk-task__title">{task.title}</span>
              <span className="tm-fk-task__end">
                <StateCapsule state={task.state}>{task.label}</StateCapsule>
                <Avatar
                  name={task.owner}
                  audience={task.client ? 'client' : 'internal'}
                  decorative
                  className="tm-fk-avatar"
                />
                <span className="tm-fk-task__date">{task.date}</span>
              </span>
            </div>
          ))}
          <div className="tm-fk-task tm-fk-task--milestone">
            <IconOrb icon="flag" tone="lime" />
            <span className="tm-fk-link-row__text">
              <span className="tm-fk-task__title">Launch</span>
              <span className="tm-fk-link-row__meta">MILESTONE · 30 SEP</span>
            </span>
            <StateCapsule state="future">Upcoming</StateCapsule>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Decision register: DEC-41 ─────────────────────────────────────────────── */

export function DecisionScene() {
  return (
    <Scene
      label="Decision DEC-41, Offers strip moves below the room grid: who decided, why, the two options rejected and the three work items it affects."
      className="tm-fk-scene--card"
    >
      <div className="tm-fk-card">
        <div className="tm-fk-card__row">
          <span className="tm-fk-inline">
            <Badge mono>DEC-41</Badge>
            <StateCapsule state="done">Decided</StateCapsule>
          </span>
          <span className="tm-fk-quiet">Effective 14 Aug</span>
        </div>
        <p className="tm-fk-card__title tm-fk-card__title--lg">
          Offers strip moves below the room grid
        </p>
        <div className="tm-fk-byline">
          <Avatar name="Lina Samir" decorative className="tm-fk-avatar" />
          <span className="tm-fk-byline__text">
            Lina Samir decided, with Omar Adel and Maya Hassan
          </span>
        </div>
        <Mono>Why</Mono>
        <p className="tm-fk-card__text tm-fk-card__text--tight">
          Guests compare rooms before they look at offers. With offers on top, the booking widget
          dropped below the fold on most laptops.
        </p>
        <Mono>Options we rejected</Mono>
        <div className="tm-fk-options">
          <div className="tm-fk-option">
            <span className="tm-fk-link-row__text">
              <span className="tm-fk-option__title">Full-width offers hero</span>
              <span className="tm-fk-quiet">Pushed booking below the fold</span>
            </span>
            <StateCapsule state="archived">Rejected</StateCapsule>
          </div>
          <div className="tm-fk-option">
            <span className="tm-fk-link-row__text">
              <span className="tm-fk-option__title">Offers in a pop-up</span>
              <span className="tm-fk-quiet">Interrupts the first visit</span>
            </span>
            <StateCapsule state="archived">Rejected</StateCapsule>
          </div>
        </div>
        <div className="tm-fk-card__row">
          <Badge>Supersedes DEC-29</Badge>
          <span className="tm-fk-quiet">Affects 3 work items</span>
        </div>
      </div>
    </Scene>
  );
}

/* ── Governed versions: the approval invalidated by a new upload ─────────────── */

export function GovernedVersionScene() {
  return (
    <Scene
      label="Homepage Concept: version 3 uploaded after version 2 was approved, so the approval is no longer valid and a new review is needed."
      className="tm-fk-scene--card"
    >
      <div className="tm-fk-card tm-fk-card--governed">
        <div className="tm-fk-card__row">
          <span className="tm-fk-card__title">Homepage Concept</span>
          <StateCapsule state="waiting">Waiting on Youssef</StateCapsule>
        </div>
        <p className="tm-fk-quiet">Atlas Website Relaunch · Deliverable</p>
        <div className="tm-fk-versions">
          <div className="tm-fk-version">
            <Badge mono className="tm-fk-version__tag">
              v3 · uploaded 19 Aug
            </Badge>
            <span className="tm-fk-version__text">Lina Samir replaced the hero image</span>
            <StateCapsule state="current" className="tm-fk-version__state">
              Latest
            </StateCapsule>
          </div>
          <div className="tm-fk-version">
            <Badge mono className="tm-fk-version__tag">
              v2 · approved 18 Aug
            </Badge>
            <span className="tm-fk-version__text">Approved by Youssef Kamal</span>
            <StateCapsule state="archived" className="tm-fk-version__state">
              Superseded
            </StateCapsule>
          </div>
        </div>
        <InlineAlert tone="warning">
          This approval is no longer valid because the reviewed version changed.
        </InlineAlert>
        <div className="tm-fk-actions">
          <Button tone="ink" size="feature" tabIndex={-1}>
            Request review of v3
          </Button>
          <Button tone="outline" size="feature" tabIndex={-1}>
            Compare versions
          </Button>
        </div>
      </div>
    </Scene>
  );
}

/* ── Publication preview ────────────────────────────────────────────────────── */

const PREVIEW_CHECKS = [
  'Internal comments are hidden',
  'Cost and margin fields are hidden',
  'File scanned · link expires in 7 days',
] as const;

export function PublicationPreviewScene() {
  return (
    <Scene
      label="The publication warning: Homepage Concept v2 is about to go to two client reviewers, with internal comments and cost fields hidden."
      className="tm-fk-scene--card"
    >
      <div className="tm-fk-card">
        <span>
          <Badge tone="client">Client preview</Badge>
        </span>
        <p className="tm-fk-card__title tm-fk-card__title--section">
          You&rsquo;re about to publish Homepage Concept v2 to 2 client reviewers.
        </p>
        <div className="tm-fk-byline">
          <span className="tm-fk-inline tm-fk-inline--tight">
            <Avatar name="Youssef Kamal" audience="client" decorative className="tm-fk-avatar" />
            <Avatar name="Salma Riad" audience="client" decorative className="tm-fk-avatar" />
          </span>
          <span className="tm-fk-byline__text">Youssef Kamal, Salma Riad · Atlas</span>
        </div>
        <ul className="tm-fk-checks">
          {PREVIEW_CHECKS.map((line) => (
            <li key={line}>
              <WebIcon name="check" size={16} />
              {line}
            </li>
          ))}
        </ul>
        <div className="tm-fk-actions">
          <Button tone="outline" size="feature" tabIndex={-1}>
            Back
          </Button>
          <Button tone="lime" size="feature" tabIndex={-1}>
            Publish to client
          </Button>
        </div>
      </div>
    </Scene>
  );
}

/* ── Permission-aware search ────────────────────────────────────────────────── */

const RESULTS: readonly {
  kind: string;
  title: string;
  audience: 'client' | 'internal';
  meta: string;
}[] = [
  {
    kind: 'DELIVERABLE',
    title: 'Homepage Concept v2',
    audience: 'client',
    meta: 'Atlas Website Relaunch · Files · awaiting approval',
  },
  {
    kind: 'DECISION',
    title: 'Homepage leads with the booking widget',
    audience: 'internal',
    meta: 'Decision log · recorded 11 Aug by Omar Adel',
  },
  {
    kind: 'DOC',
    title: 'Atlas brief · homepage section',
    audience: 'internal',
    meta: 'Docs · edited 16 Aug by Lina Samir',
  },
];

export function PermissionSearchScene() {
  return (
    <Scene
      label="Search for homepage approval: three results you may see, and a note that six matches in projects you are not on stay hidden."
      className="tm-fk-scene--search"
    >
      <div className="tm-fk-search">
        <div className="tm-fk-search__field">
          <WebIcon name="search" size={16} />
          <span className="tm-fk-search__query">homepage approval</span>
          <Badge mono>⌘K</Badge>
        </div>
        {RESULTS.map((result) => (
          <div key={result.title} className="tm-fk-result">
            <span className="tm-fk-inline tm-fk-inline--wrap tm-fk-result__head">
              <Badge mono>{result.kind}</Badge>
              <span className="tm-fk-result__title">{result.title}</span>
              <Badge
                tone={result.audience === 'client' ? 'client' : 'neutral'}
                className="tm-fk-result__tag"
              >
                {result.audience === 'client' ? 'client visible' : 'internal'}
              </Badge>
            </span>
            <span className="tm-fk-quiet">{result.meta}</span>
          </div>
        ))}
        <InlineAlert tone="neutral" className="tm-fk-search__note">
          6 matches are in projects you are not on — their titles are not shown.
        </InlineAlert>
      </div>
    </Scene>
  );
}

/* ── CTA band crop: the client's approval sheet ─────────────────────────────── */

const CONFIRMING = [
  'The brand feels right',
  'Booking is easy to find',
  'Arabic and English match',
  'The phone layout works',
] as const;

export function ClientApprovalScene() {
  return (
    <Scene
      label="The client approval sheet: the exact version hash being decided on, four things to confirm, and Approve version 2."
      className="tm-fk-scene--approve"
    >
      <div className="tm-fk-approve">
        <div className="tm-fk-approve__inner">
          <Mono>What you are deciding on</Mono>
          <p className="tm-fk-approve__hash">
            <span>v2 · 8f2c·d41a</span>
            <span className="tm-fk-approve__time">13 Aug 09:12</span>
          </p>
          <p className="tm-fk-approve__text">
            Your decision is recorded against this exact version. If the file changes, the approval
            stops being valid and we ask you again.
          </p>
          <hr className="tm-fk-approve__rule" />
          <Mono>What you are confirming</Mono>
          <ul className="tm-fk-confirm">
            {CONFIRMING.map((line) => (
              <li key={line}>
                <span className="tm-fk-confirm__box" />
                {line}
              </li>
            ))}
          </ul>
          <Button tone="lime" size="feature" tabIndex={-1} className="tm-fk-approve__primary">
            Approve version 2
          </Button>
          <Button tone="outline" size="feature" tabIndex={-1} className="tm-fk-approve__secondary">
            Request changes
          </Button>
        </div>
      </div>
    </Scene>
  );
}
