'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';

/**
 * Product scenes for Solutions · Agencies & studios (WEB-08), cloned from the round-2 Figma frame
 * 308:33: the portfolio, the client portal home, the client approval and the request inbox, each
 * in a browser frame. Illustrations: the body is `inert` and hidden from assistive tech, and
 * `label` is the one-sentence alt text. Built from packages/ui parts on TManage tokens. Every
 * visible string is a `SolutionsAgenciesScenes.*` catalog key; names, IDs and version tags stay
 * Latin.
 */

/** `t()` scoped to `SolutionsAgenciesScenes.*`. */
function useSceneT(): (key: string) => string {
  const t = useT();
  return (key) => t(`SolutionsAgenciesScenes.${key}` as MessageKey);
}

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

/**
 * One portfolio row; `key` names the `SolutionsAgenciesScenes.row<Key>Project/Owner/Why/
 * Committed/Forecast/Wait` keys.
 */
interface DecisionRow {
  key: string;
  tone?: 'danger' | 'warning' | 'muted';
}

const DECISION_ROWS: readonly DecisionRow[] = [
  { key: 'Meridian', tone: 'danger' },
  { key: 'Atlas', tone: 'warning' },
  { key: 'Harbour' },
  { key: 'Northwind' },
  { key: 'Internal' },
  { key: 'Archived', tone: 'muted' },
];

export function PortfolioScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <AgScene
      label={t('SolutionsAgenciesScenes.decisionPortfolioAlt')}
      address="app.tmanage.com/portfolio"
      className="tm-web-ag-scene--portfolio"
    >
      <div className="tm-web-ag-portfolio">
        <div className="tm-web-ag-portfolio__head">
          <div>
            <p className="tm-web-scene__mono">{s('portfolioEyebrow')}</p>
            <p className="tm-web-ag-portfolio__title">{s('portfolioTitle')}</p>
          </div>
          <div className="tm-web-ag-counters">
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">
                2<span className="tm-web-ag-counter__flag">{s('actNow')}</span>
              </span>
              <span className="tm-web-ag-counter__label">{s('datesAtRisk')}</span>
            </span>
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">4</span>
              <span className="tm-web-ag-counter__label">{s('holding')}</span>
            </span>
          </div>
        </div>
        <div className="tm-web-ag-table">
          <div className="tm-web-ag-table__row tm-web-ag-table__row--head">
            <span>{s('colProject')}</span>
            <span>{s('colWhy')}</span>
            <span>{s('colCommitted')}</span>
            <span>{s('colForecast')}</span>
            <span>{s('colWait')}</span>
          </div>
          {DECISION_ROWS.map((row) => (
            <div
              key={row.key}
              className={cx(
                'tm-web-ag-table__row',
                row.tone && `tm-web-ag-table__row--${row.tone}`,
              )}
            >
              <span className="tm-web-ag-table__project">
                <span className="tm-web-ag-table__name">{s(`row${row.key}Project`)}</span>
                <span className="tm-web-ag-table__client">{s(`row${row.key}Owner`)}</span>
              </span>
              <span className="tm-web-ag-table__why">{s(`row${row.key}Why`)}</span>
              <span className="tm-web-ag-table__date">{s(`row${row.key}Committed`)}</span>
              <span className="tm-web-ag-table__date">{s(`row${row.key}Forecast`)}</span>
              <span className="tm-web-ag-table__date">{s(`row${row.key}Wait`)}</span>
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
  const s = useSceneT();
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
              <span className="tm-web-ag-portal__by">{s('portalBy')}</span>
            </span>
          </span>
          <span className="tm-web-chip">{s('portalAllWork')}</span>
          <span className="tm-web-ag-portal__user">
            <Avatar name="Salma Riad" audience="client" size="compact" decorative />
            Salma Riad
          </span>
        </div>
        <div className="tm-web-ag-portal__head">
          <div>
            <p className="tm-web-scene__mono">{s('portalEngagements')}</p>
            <p className="tm-web-ag-portal__title">{s('portalTitle')}</p>
          </div>
          <div className="tm-web-ag-counters">
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">2</span>
              <span className="tm-web-ag-counter__label">{s('thingsNeedYou')}</span>
            </span>
            <span className="tm-web-ag-counter">
              <span className="tm-web-ag-counter__value">1</span>
              <span className="tm-web-ag-counter__label">{s('dateMoved')}</span>
            </span>
          </div>
        </div>
        <div className="tm-web-ag-engagement tm-web-ag-engagement--focus">
          <p className="tm-web-ag-engagement__meta">
            <StateCapsule state="current">{s('needsYou')}</StateCapsule>
            <span className="tm-web-scene__mono">{s('launchCommitted')}</span>
          </p>
          <p className="tm-web-ag-engagement__title">{s('rowAtlasProject')}</p>
          <p className="tm-web-ag-engagement__body">{s('atlasBody')}</p>
          <ol className="tm-web-ag-track">
            <li className="is-done">{s('trackBrief')}</li>
            <li className="is-now">{s('trackNow')}</li>
            <li>{s('trackLaunch')}</li>
          </ol>
          <p className="tm-web-ag-engagement__foot">
            <Button tone="lime" size="compact">
              {s('openPortal')}
            </Button>
            <span className="tm-web-scene__mono">{s('atlasFoot')}</span>
          </p>
        </div>
        <div className="tm-web-ag-engagements">
          <div className="tm-web-ag-engagement">
            <p className="tm-web-ag-engagement__meta">
              <StateCapsule state="done">{s('onTrack')}</StateCapsule>
              <span className="tm-web-scene__mono">{s('nextShare')}</span>
            </p>
            <p className="tm-web-ag-engagement__title">{s('seasonalTitle')}</p>
            <p className="tm-web-ag-engagement__body">{s('seasonalBody')}</p>
            <p className="tm-web-ag-engagement__foot">
              <Button tone="outline" size="compact">
                {s('openPortal')}
              </Button>
              <span className="tm-web-scene__mono">Maya Hassan</span>
            </p>
          </div>
          <div className="tm-web-ag-engagement tm-web-ag-engagement--closed">
            <p className="tm-web-ag-engagement__meta">
              <StateCapsule state="archived">{s('closed')}</StateCapsule>
              <span className="tm-web-scene__mono">{s('finished')}</span>
            </p>
            <p className="tm-web-ag-engagement__title">{s('brandTitle')}</p>
            <p className="tm-web-ag-engagement__body">{s('brandBody')}</p>
            <p className="tm-web-ag-engagement__foot">
              <Button tone="outline" size="compact">
                {s('openArchive')}
              </Button>
            </p>
          </div>
        </div>
      </div>
    </AgScene>
  );
}

/* ── Row 2: the client's approval of one exact version ─────────────────────── */

const CONFIRMING = ['checkBrand', 'checkBooking', 'checkLanguages', 'checkPhone'] as const;

export function CreativeReviewScene() {
  const t = useT();
  const s = useSceneT();
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
          <span className="tm-web-ag-approval__crumb">{s('approvalCrumb')}</span>
          <span className="tm-web-chip">{s('backToActions')}</span>
          <span className="tm-web-ag-approval__who">
            <Avatar name="Youssef Kamal" audience="client" size="compact" decorative />
            {s('reviewer')}
          </span>
        </div>
        <div className="tm-web-ag-approval__grid">
          <div className="tm-web-ag-approval__main">
            <p className="tm-web-scene__mono">{s('approvalEyebrow')}</p>
            <p className="tm-web-ag-approval__title">{s('approvalTitle')}</p>
            <div className="tm-web-ag-approval__preview">
              <span className="tm-web-ag-approval__views">
                <span>{s('viewDesktop')}</span>
                <span className="is-on">{s('viewMobile')}</span>
                <span>{s('viewArabic')}</span>
              </span>
            </div>
          </div>
          <div className="tm-web-ag-approval__side">
            <div className="tm-web-ag-approval__box">
              <p className="tm-web-scene__mono">{s('decidingOn')}</p>
              <p className="tm-web-ag-approval__version">
                <span>v2 · 8f2c·d41a</span>
                <span className="tm-web-scene__mono">{s('versionDate')}</span>
              </p>
              <p className="tm-web-ag-approval__note">{s('recordedNote')}</p>
              <p className="tm-web-scene__mono">{s('confirming')}</p>
              <ul className="tm-web-ag-approval__checks">
                {CONFIRMING.map((item) => (
                  <li key={item}>
                    <span className="tm-web-ag-approval__box-mark" />
                    {s(item)}
                  </li>
                ))}
              </ul>
              <Button tone="lime" size="compact">
                {s('approveVersion2')}
              </Button>
              <Button tone="outline" size="compact">
                {s('requestChanges')}
              </Button>
              <p className="tm-web-ag-approval__note">{s('reasonNote')}</p>
            </div>
            <div className="tm-web-ag-approval__box">
              <p className="tm-web-scene__mono">{s('whyNow')}</p>
              <p className="tm-web-ag-approval__note">{s('whyNowNote')}</p>
              <span className="tm-web-ag-approval__who">
                <Avatar name="Omar Adel" size="compact" decorative />
                {s('messageOmar')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </AgScene>
  );
}

/* ── Row 3: the request inbox, grouped by the object it belongs to ─────────── */

/** One inbox event; `text` and `time` name `SolutionsAgenciesScenes.*` keys, or `time` is a clock. */
interface InboxEvent {
  who: string;
  text: string;
  time: string;
  timeKey?: boolean;
  hot?: boolean;
  client?: boolean;
}

/** One inbox group; `title` is a key unless `titleRaw` (a channel name) is set. */
interface InboxGroup {
  id: string;
  title: string;
  titleRaw?: boolean;
  events: string;
  state?: { state: CapsuleState; label: string };
  rows: readonly InboxEvent[];
}

const INBOX: readonly InboxGroup[] = [
  {
    id: 'concept',
    title: 'inboxConcept',
    events: 'inboxConceptEvents',
    state: { state: 'current', label: 'needsYou' },
    rows: [
      {
        who: 'Youssef Kamal',
        text: 'inboxNotStarted',
        time: 'inboxNotStartedTime',
        timeKey: true,
        hot: true,
        client: true,
      },
      { who: 'Lina Samir', text: 'inboxReady', time: '11:02' },
      { who: 'Maya Hassan', text: 'inboxPassed', time: '09:48' },
    ],
  },
  {
    id: 'channel',
    title: '#atlas-relaunch',
    titleRaw: true,
    events: 'inboxChannelEvents',
    rows: [
      { who: 'Salma Riad', text: 'inboxMention', time: '10:58', client: true },
      { who: 'Karim Nabil', text: 'inboxShared', time: '09:12' },
    ],
  },
  {
    id: 'automation',
    title: 'inboxAutomation',
    events: 'inboxAutomationEvents',
    rows: [{ who: '', text: 'inboxSkipped', time: '08:00' }],
  },
];

export function RetainerPlanScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <AgScene
      label={t('SolutionsAgenciesScenes.requestsInboxAlt')}
      address="app.tmanage.com/requests"
    >
      <div className="tm-web-ag-inbox">
        {INBOX.map((group) => (
          <div key={group.id} className="tm-web-ag-inbox__group">
            <p className="tm-web-ag-inbox__head">
              <span className="tm-web-scene__mono">
                {group.titleRaw ? group.title : s(group.title)}
              </span>
              {group.state ? (
                <StateCapsule state={group.state.state}>{s(group.state.label)}</StateCapsule>
              ) : null}
              <span className="tm-web-scene__mono tm-web-ag-inbox__count">{s(group.events)}</span>
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
                <span className="tm-web-ag-inbox__text">{s(row.text)}</span>
                <span className="tm-web-scene__mono">{row.timeKey ? s(row.time) : row.time}</span>
              </p>
            ))}
          </div>
        ))}
        <p className="tm-web-ag-inbox__more tm-web-scene__mono">{s('inboxMore')}</p>
      </div>
    </AgScene>
  );
}
