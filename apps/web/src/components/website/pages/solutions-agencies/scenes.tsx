'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * Product scenes for Solutions · Agencies & studios (WEB-08), cloned from the round-2 Figma frame
 * 308:33: the portfolio, the client portal home, the client approval and the request inbox, each
 * in a browser frame. Illustrations: the body is `inert` and hidden from assistive tech, and
 * `label` is the one-sentence alt text. Built from packages/ui parts on TManage tokens.
 */
function AgScene({
  label,
  address,
  className,
  children,
}: {
  label: string;
  address: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-ag-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-ag-scene__body" aria-hidden="true" inert>
        <div className="tm-web-ag-scene__bar">
          <span className="tm-web-ag-scene__dots">
            <span />
            <span />
            <span />
          </span>
          <span className="tm-web-ag-scene__address">{address}</span>
        </div>
        {children}
      </div>
    </figure>
  );
}

/* ── Hero: the portfolio, ranked by what needs a decision ─────────────────── */

interface DecisionRow {
  project: string;
  owner: string;
  why: string;
  tone?: 'danger' | 'warning' | 'muted';
  committed: string;
  forecast: string;
  wait: string;
}

const DECISION_ROWS: readonly DecisionRow[] = [
  {
    project: 'Meridian App',
    owner: 'Meridian Group · Karim Nabil',
    why: 'Approval invalidated by a file change',
    tone: 'danger',
    committed: '26 Aug',
    forecast: '4 Sep',
    wait: '5d',
  },
  {
    project: 'Atlas Website Relaunch',
    owner: 'Atlas Hospitality · Omar Adel',
    why: 'No float left before the launch',
    tone: 'warning',
    committed: '30 Sep',
    forecast: '30 Sep',
    wait: '26h',
  },
  {
    project: 'Harbour Rebrand',
    owner: 'Harbour Co · Maya Hassan',
    why: 'Holding · milestone evidence current',
    committed: '12 Oct',
    forecast: '10 Oct',
    wait: '—',
  },
  {
    project: 'Northwind Campaign',
    owner: 'Northwind · Lina Samir',
    why: 'Holding · next milestone on track',
    committed: '3 Nov',
    forecast: '3 Nov',
    wait: '—',
  },
  {
    project: 'Internal — Ops',
    owner: 'Internal · Maya Hassan',
    why: 'No active milestone — not ranked',
    committed: '—',
    forecast: '—',
    wait: '—',
  },
  {
    project: 'Harbour Rebrand 2025',
    owner: 'Archived · approvals preserved',
    why: 'Archived 4 months ago',
    tone: 'muted',
    committed: '—',
    forecast: '—',
    wait: '—',
  },
];

export function PortfolioScene() {
  const t = useT();
  return (
    <AgScene
      label={t('SolutionsAgenciesScenes.decisionPortfolioAlt')}
      address="app.tmanage.com/portfolio"
      className="tm-web-ag-scene--portfolio"
    >
      <div className="tm-web-ag-portfolio">
        <div className="tm-web-ag-portfolio__head">
          <div>
            <p className="tm-web-scene__mono">Portfolio · Client delivery</p>
            <p className="tm-web-ag-portfolio__title">Two projects need a decision</p>
          </div>
          <div className="tm-web-ag-counters">
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">
                2<span className="tm-web-ag-counter__flag">act now</span>
              </span>
              <span className="tm-web-ag-counter__label">client dates at risk</span>
            </span>
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">4</span>
              <span className="tm-web-ag-counter__label">holding their commitment</span>
            </span>
          </div>
        </div>
        <div className="tm-web-ag-table">
          <div className="tm-web-ag-table__row tm-web-ag-table__row--head">
            <span>Project</span>
            <span>Why it is here</span>
            <span>Committed</span>
            <span>Forecast</span>
            <span>Client wait</span>
          </div>
          {DECISION_ROWS.map((row) => (
            <div
              key={row.project}
              className={cx(
                'tm-web-ag-table__row',
                row.tone && `tm-web-ag-table__row--${row.tone}`,
              )}
            >
              <span className="tm-web-ag-table__project">
                <span className="tm-web-ag-table__name">{row.project}</span>
                <span className="tm-web-ag-table__client">{row.owner}</span>
              </span>
              <span className="tm-web-ag-table__why">{row.why}</span>
              <span className="tm-web-ag-table__date">{row.committed}</span>
              <span className="tm-web-ag-table__date">{row.forecast}</span>
              <span className="tm-web-ag-table__date">{row.wait}</span>
            </div>
          ))}
        </div>
      </div>
    </AgScene>
  );
}

/* ── Row 1: the client's own portal home ──────────────────────────────────── */

export function ClientBoundariesScene() {
  const t = useT();
  return (
    <AgScene label={t('SolutionsAgenciesScenes.clientHomeAlt')} address="app.tmanage.com/clients">
      <div className="tm-web-ag-portal">
        <div className="tm-web-ag-portal__top">
          <span className="tm-web-ag-portal__brand">
            <span className="tm-web-ag-portal__mark">
              <WebIcon name="building" size={12} />
            </span>
            <span>
              <span className="tm-web-ag-portal__org">Atlas Hospitality</span>
              <span className="tm-web-ag-portal__by">delivered by Northstar Studio</span>
            </span>
          </span>
          <span className="tm-web-chip">All your work with Northstar</span>
          <span className="tm-web-ag-portal__user">
            <Avatar name="Salma Riad" audience="client" size="compact" decorative />
            Salma Riad
          </span>
        </div>
        <div className="tm-web-ag-portal__head">
          <div>
            <p className="tm-web-scene__mono">Atlas Hospitality · 3 engagements</p>
            <p className="tm-web-ag-portal__title">Two live, one finished</p>
          </div>
          <div className="tm-web-ag-counters">
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">2</span>
              <span className="tm-web-ag-counter__label">things need you</span>
            </span>
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">1</span>
              <span className="tm-web-ag-counter__label">date moved this month</span>
            </span>
          </div>
        </div>
        <div className="tm-web-ag-engagement tm-web-ag-engagement--focus">
          <p className="tm-web-ag-engagement__meta">
            <StateCapsule state="current">Needs you</StateCapsule>
            <span className="tm-web-scene__mono">Launch committed 30 Sep</span>
          </p>
          <p className="tm-web-ag-engagement__title">Atlas Website Relaunch</p>
          <p className="tm-web-ag-engagement__body">
            Homepage direction is waiting for your approval.
          </p>
          <ol className="tm-web-ag-track">
            <li className="is-done">Brief</li>
            <li className="is-now">Homepage direction — now</li>
            <li>Launch</li>
          </ol>
          <p className="tm-web-ag-engagement__foot">
            <Button tone="lime" size="compact">
              Open portal
            </Button>
            <span className="tm-web-scene__mono">Omar Adel · 2 open requests</span>
          </p>
        </div>
        <div className="tm-web-ag-engagements">
          <div className="tm-web-ag-engagement">
            <p className="tm-web-ag-engagement__meta">
              <StateCapsule state="done">On track</StateCapsule>
              <span className="tm-web-scene__mono">Next share 22 Aug</span>
            </p>
            <p className="tm-web-ag-engagement__title">Seasonal campaign 2026</p>
            <p className="tm-web-ag-engagement__body">Nothing needs you this week.</p>
            <p className="tm-web-ag-engagement__foot">
              <Button tone="outline" size="compact">
                Open portal
              </Button>
              <span className="tm-web-scene__mono">Maya Hassan</span>
            </p>
          </div>
          <div className="tm-web-ag-engagement tm-web-ag-engagement--closed">
            <p className="tm-web-ag-engagement__meta">
              <StateCapsule state="archived">Closed</StateCapsule>
              <span className="tm-web-scene__mono">Finished 12 Mar</span>
            </p>
            <p className="tm-web-ag-engagement__title">Brand refresh</p>
            <p className="tm-web-ag-engagement__body">Delivered and archived.</p>
            <p className="tm-web-ag-engagement__foot">
              <Button tone="outline" size="compact">
                Open archive
              </Button>
            </p>
          </div>
        </div>
      </div>
    </AgScene>
  );
}

/* ── Row 2: the client's approval of one exact version ─────────────────────── */

const CONFIRMING = [
  'The brand feels right',
  'Booking is easy to find',
  'Arabic and English match',
  'The phone layout works',
] as const;

export function CreativeReviewScene() {
  const t = useT();
  return (
    <AgScene
      label={t('SolutionsAgenciesScenes.clientApprovalAlt')}
      address="app.tmanage.com/reviews"
    >
      <div className="tm-web-ag-approval">
        <div className="tm-web-ag-approval__top">
          <span className="tm-web-ag-portal__mark">
            <WebIcon name="building" size={12} />
          </span>
          <span className="tm-web-ag-approval__crumb">Atlas Hospitality · Website relaunch</span>
          <span className="tm-web-chip">← Back to your actions</span>
          <span className="tm-web-ag-approval__who">
            <Avatar name="Youssef Kamal" audience="client" size="compact" decorative />
            Youssef Kamal · Reviewer
          </span>
        </div>
        <div className="tm-web-ag-approval__grid">
          <div className="tm-web-ag-approval__main">
            <p className="tm-web-scene__mono">Approval · Homepage Concept v2</p>
            <p className="tm-web-ag-approval__title">Does this direction work for you?</p>
            <div className="tm-web-ag-approval__preview">
              <span className="tm-web-ag-approval__views">
                <span>Desktop</span>
                <span className="is-on">Mobile</span>
                <span>Arabic</span>
              </span>
            </div>
          </div>
          <div className="tm-web-ag-approval__side">
            <div className="tm-web-ag-approval__box">
              <p className="tm-web-scene__mono">What you are deciding on</p>
              <p className="tm-web-ag-approval__version">
                <span>v2 · 8f2c·d41a</span>
                <span className="tm-web-scene__mono">13 Aug 09:12</span>
              </p>
              <p className="tm-web-ag-approval__note">
                Your decision is recorded against this exact version.
              </p>
              <p className="tm-web-scene__mono">What you are confirming</p>
              <ul className="tm-web-ag-approval__checks">
                {CONFIRMING.map((item) => (
                  <li key={item}>
                    <span className="tm-web-ag-approval__box-mark" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button tone="lime" size="compact">
                Approve version 2
              </Button>
              <Button tone="outline" size="compact">
                Request changes
              </Button>
              <p className="tm-web-ag-approval__note">Requesting changes needs a short reason.</p>
            </div>
            <div className="tm-web-ag-approval__box">
              <p className="tm-web-scene__mono">Why it matters now</p>
              <p className="tm-web-ag-approval__note">
                Content migration starts once this direction is approved.
              </p>
              <span className="tm-web-ag-approval__who">
                <Avatar name="Omar Adel" size="compact" decorative />
                Questions? Message Omar
              </span>
            </div>
          </div>
        </div>
      </div>
    </AgScene>
  );
}

/* ── Row 3: the request inbox, grouped by the object it belongs to ─────────── */

interface InboxEvent {
  who: string;
  text: string;
  time: string;
  hot?: boolean;
  client?: boolean;
}

interface InboxGroup {
  title: string;
  events: string;
  state?: { state: CapsuleState; label: string };
  rows: readonly InboxEvent[];
}

const INBOX: readonly InboxGroup[] = [
  {
    title: 'Homepage Concept v2',
    events: '6 events',
    state: { state: 'current', label: 'Needs you' },
    rows: [
      {
        who: 'Youssef Kamal',
        text: 'Approval still not started · reviewer Youssef',
        time: '26h',
        hot: true,
        client: true,
      },
      { who: 'Lina Samir', text: 'Marked v2 ready for client review', time: '11:02' },
      { who: 'Maya Hassan', text: 'Passed internal review · 4 of 4 criteria', time: '09:48' },
    ],
  },
  {
    title: '#atlas-relaunch',
    events: '14 events',
    rows: [
      { who: 'Salma Riad', text: 'Mentioned you in a thread', time: '10:58', client: true },
      { who: 'Karim Nabil', text: 'Shared 3 files in the channel', time: '09:12' },
    ],
  },
  {
    title: 'Automation · Chase client approvals',
    events: '3 events',
    rows: [{ who: '', text: 'Run skipped · reviewer already reminded today', time: '08:00' }],
  },
];

export function RetainerPlanScene() {
  const t = useT();
  return (
    <AgScene
      label={t('SolutionsAgenciesScenes.requestsInboxAlt')}
      address="app.tmanage.com/requests"
    >
      <div className="tm-web-ag-inbox">
        {INBOX.map((group) => (
          <div key={group.title} className="tm-web-ag-inbox__group">
            <p className="tm-web-ag-inbox__head">
              <span className="tm-web-scene__mono">{group.title}</span>
              {group.state ? (
                <StateCapsule state={group.state.state}>{group.state.label}</StateCapsule>
              ) : null}
              <span className="tm-web-scene__mono tm-web-ag-inbox__count">{group.events}</span>
            </p>
            {group.rows.map((row) => (
              <p
                key={row.text}
                className={cx('tm-web-ag-inbox__row', row.hot && 'tm-web-ag-inbox__row--hot')}
              >
                {row.who ? (
                  <Avatar
                    name={row.who}
                    audience={row.client ? 'client' : 'internal'}
                    size="compact"
                    decorative
                  />
                ) : (
                  <span className="tm-web-ag-inbox__bot">
                    <WebIcon name="bolt" size={12} />
                  </span>
                )}
                <span className="tm-web-ag-inbox__text">{row.text}</span>
                <span className="tm-web-scene__mono">{row.time}</span>
              </p>
            ))}
          </div>
        ))}
        <p className="tm-web-ag-inbox__more tm-web-scene__mono">23 older events · load more</p>
      </div>
    </AgScene>
  );
}
