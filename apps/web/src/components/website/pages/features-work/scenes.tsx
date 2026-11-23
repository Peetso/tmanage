'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { localeDirection } from '../../../../lib/i18n/direction';
import { formatDay, formatNumber } from '../../../../lib/i18n/format';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Mini product scenes for Features · Work, requests & projects (Figma 03-features-work). Each
 * is real TManage UI composed from packages/ui parts (StateCapsule, Badge, Avatar, Button) and
 * Limeframe tokens, drawn at product size and scaled down by the page CSS — the "clone at
 * 0.5–0.75" rule of SITE-SPEC §0. Scenes are illustrations: the body is `inert` and hidden from
 * assistive tech, and `label` is the one-sentence alternative text.
 *
 * Every mock-up line reads from the `FeaturesWorkScenes.*` keys, so the Arabic page shows Arabic
 * product UI. Names, IDs (TSK-1042, REQ-64, WK-12) and version tags stay Latin.
 */

type Vars = Readonly<Record<string, string | number>>;
type SceneText = (key: string, vars?: Vars) => string;

/** The scene text for `key` under `FeaturesWorkScenes.`, with `{name}` placeholders filled. */
function useSceneText(): SceneText {
  const t = useT();
  return (key, vars) => {
    let text = t(`FeaturesWorkScenes.${key}` as MessageKey);
    for (const [name, value] of Object.entries(vars ?? {})) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };
}

interface SceneFormat {
  /** A count, digits by the app rule (Latin unless the member chose others). */
  num(value: number): string;
  /**
   * A calendar day. Arabic formats `iso` with the active locale (Arabic month, Latin digits by
   * the app rule); English keeps the design's own short form, `en`, so the English page is unchanged.
   */
  day(iso: string, en: string, options?: Intl.DateTimeFormatOptions): string;
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

function useSceneFormat(): SceneFormat {
  const locale = useActiveLocale();
  const rtl = localeDirection(locale) === 'rtl';
  return {
    num: (value) => formatNumber(value, { locale }),
    day: (iso, en, options = DAY_MONTH) =>
      rtl ? formatDay(`${iso}T12:00:00Z`, { locale, timeZone: 'UTC' }, options) : en,
  };
}

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
    <figure className={cx('tm-fw-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-fw-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

/**
 * Mono/Caption. The uppercase, tracked form takes the website's eyebrow style, so its tracking
 * comes from the shared layer rather than a value typed here; `caps={false}` is the plain mono
 * line the product uses for dates and counts.
 */
const Mono = ({
  children,
  className,
  caps = true,
}: {
  children: ReactNode;
  className?: string | undefined;
  caps?: boolean;
}) => <span className={cx(caps && 'tm-web-eyebrow', 'tm-fw-mono', className)}>{children}</span>;

/** Truncating text for dense rows: one line, ellipsis at the end. */
const Clip = ({ children }: { children: ReactNode }) => (
  <span className="tm-fw-clip">{children}</span>
);

/** A small initials disc for dense rows, where the 32 px Avatar would crowd the line. */
const Initials = ({ name, tone = 'paper' }: { name: string; tone?: 'paper' | 'ink' }) => (
  <span className={cx('tm-fw-initials', tone === 'ink' && 'tm-fw-initials--ink')}>{name}</span>
);

/* ── Hero: the Work board inside the app shell ───────────────────────────────── */

const RAIL: readonly { icon: WebIconName; key: string; on?: boolean }[] = [
  { icon: 'pulse', key: 'home' },
  { icon: 'mail', key: 'inbox' },
  { icon: 'chat', key: 'chat' },
  { icon: 'work', key: 'work', on: true },
  { icon: 'doc', key: 'docs' },
  { icon: 'flag', key: 'plan' },
  { icon: 'portal', key: 'clients' },
  { icon: 'chart', key: 'insights' },
  { icon: 'shield', key: 'control' },
];

interface BoardCardData {
  id: string;
  title: string;
  meta?: ReactNode;
  capsule?: { state: CapsuleState; label: string };
  selected?: boolean;
}

function BoardCard({ id, title, meta, capsule, selected }: BoardCardData) {
  return (
    <div className={cx('tm-fw-card', selected && 'tm-fw-card--selected')}>
      <div className="tm-fw-card__top">
        <Mono>{id}</Mono>
        <span className="tm-fw-card__orb">
          <span />
        </span>
      </div>
      <p className="tm-fw-card__title">{title}</p>
      {capsule ? <StateCapsule state={capsule.state}>{capsule.label}</StateCapsule> : null}
      {meta ? (
        <Mono caps={false} className="tm-fw-card__meta">
          {meta}
        </Mono>
      ) : null}
    </div>
  );
}

function BoardColumn({
  title,
  count,
  flag,
  cards,
}: {
  title: string;
  count: string;
  flag?: string;
  cards: readonly BoardCardData[];
}) {
  return (
    <div className="tm-fw-board__col">
      <p className="tm-fw-board__col-head">
        <span>{title}</span>
        <Mono>{count}</Mono>
        {flag ? <span className="tm-web-eyebrow tm-fw-flag">{flag}</span> : null}
      </p>
      {cards.map((card) => (
        <BoardCard key={card.title} {...card} />
      ))}
    </div>
  );
}

function notStartedCards(s: SceneText, f: SceneFormat): readonly BoardCardData[] {
  return [
    {
      id: 'TSK · NF',
      title: s('card.ctaMicrocopy'),
      meta: s('card.committed', { date: f.day('2026-08-20', '20 Aug') }),
    },
    {
      id: s('card.idUnowned'),
      title: s('card.accessibility'),
      capsule: { state: 'waiting', label: s('card.noOwner') },
    },
  ];
}

function inProgressCards(s: SceneText, f: SceneFormat): readonly BoardCardData[] {
  return [
    {
      id: 'TSK · LS',
      title: s('card.mobileConcepts'),
      capsule: { state: 'blocked', label: s('card.blockedBrand') },
      meta: (
        <>
          {s('card.committed', { date: f.day('2026-08-20', '20 Aug') })} ·{' '}
          <span className="tm-fw-late">
            {s('card.forecast', { date: f.day('2026-08-25', '25 Aug') })}
          </span>
        </>
      ),
      selected: true,
    },
    {
      id: 'TSK · NF',
      title: s('card.faqCopy'),
      meta: (
        <>
          {s('card.committed', { date: f.day('2026-09-01', '1 Sep') })} ·{' '}
          <span className="tm-fw-late">
            {s('card.forecast', { date: f.day('2026-09-08', '8 Sep') })}
          </span>
        </>
      ),
    },
  ];
}

function inReviewCards(s: SceneText, f: SceneFormat): readonly BoardCardData[] {
  return [
    {
      id: 'DEC · MH',
      title: s('card.homepageDecision'),
      meta: s('card.reviewers', { done: f.num(2), total: f.num(3) }),
    },
  ];
}

export function WorkBoardScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('WorkBoardScene.label')} className="tm-fw-scene--board">
      <div className="tm-fw-shell">
        <nav className="tm-fw-rail">
          <span className="tm-fw-rail__logo">
            <span />
          </span>
          {RAIL.map((item) => (
            <span key={item.key} className={cx('tm-fw-rail__item', item.on && 'is-on')}>
              <span className="tm-fw-rail__orb">
                <WebIcon name={item.icon} size={14} />
              </span>
              <span className="tm-fw-rail__label">{s(`rail.${item.key}`)}</span>
            </span>
          ))}
          <span className="tm-fw-rail__me">OA</span>
        </nav>
        <div className="tm-fw-board">
          <Mono>{s('board.crumb')}</Mono>
          <div className="tm-fw-board__head">
            <p className="tm-web-header__title tm-fw-board__title">{s('board.title')}</p>
            <span className="tm-fw-seg">
              <span>{s('view.list')}</span>
              <span className="is-on">{s('view.board')}</span>
              <span>{s('view.timeline')}</span>
            </span>
          </div>
          <p className="tm-fw-toast">
            <span className="tm-fw-toast__dot" />
            {s('board.moving', {
              title: s('card.mobileConcepts'),
              column: f.num(3),
              total: f.num(12),
            })}
          </p>
          <div className="tm-fw-board__cols">
            <BoardColumn
              title={s('col.notStarted')}
              count={f.num(10)}
              cards={notStartedCards(s, f)}
            />
            <BoardColumn
              title={s('col.inProgress')}
              count={s('col.wip', { count: f.num(9), limit: f.num(6) })}
              flag={s('col.atLimit')}
              cards={inProgressCards(s, f)}
            />
            <BoardColumn
              title={s('col.internalReview')}
              count={f.num(2)}
              cards={inReviewCards(s, f)}
            />
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Requests: a client request waiting with a manager ───────────────────────── */

export function RequestScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('RequestScene.label')} className="tm-fw-scene--request">
      <div className="tm-fw-request">
        <div className="tm-fw-request__card">
          <p className="tm-fw-request__ids">
            <Badge tone="client">{s('req.badge')}</Badge>
            <Mono>REQ-64 · Atlas Hospitality</Mono>
          </p>
          <p className="tm-fw-request__title">{s('req.title')}</p>
          <p className="tm-fw-request__body">{s('req.body')}</p>
          <p className="tm-fw-request__state">
            <StateCapsule state="waiting">{s('req.waiting')}</StateCapsule>
          </p>
          <Mono className="tm-fw-request__date">
            {s('req.desired', { date: f.day('2026-09-03', '3 Sep') })}
          </Mono>
          <div className="tm-fw-request__actions">
            <Button tone="ink" size="feature">
              {s('req.accept')}
            </Button>
            <Button tone="outline" size="feature">
              {s('req.defer')}
            </Button>
            <Button tone="text" size="feature">
              {s('req.decline')}
            </Button>
          </div>
        </div>
        <div className="tm-fw-reply">
          <div className="tm-fw-reply__who">
            <Avatar name="Salma Riad" audience="client" size="compact" decorative />
            <span>
              <span className="tm-fw-reply__name">Salma Riad</span>
              <Mono>{s('reply.meta')}</Mono>
            </span>
          </div>
          <p className="tm-fw-reply__text">{s('reply.text')}</p>
          <Badge mono>faq-arabic-v2.docx</Badge>
        </div>
      </div>
    </Scene>
  );
}

/* ── Work items: one work item, every detail ─────────────────────────────────── */

const SUBTASKS: readonly { key: string; done?: boolean; blocked?: boolean; who?: string }[] = [
  { key: 'audit', done: true, who: 'LS' },
  { key: 'research', done: true, who: 'NF' },
  { key: 'directions', blocked: true, who: 'LS' },
  { key: 'arabic', who: 'KN' },
];

export function WorkItemScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  const withYear: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  return (
    <Scene label={t('WorkItemScene.label')} className="tm-fw-scene--item">
      <div className="tm-fw-item">
        <div className="tm-fw-item__main">
          <div className="tm-fw-panel">
            <p className="tm-fw-item__crumb">
              <span className="tm-fw-back">
                <WebIcon name="arrow-right" size={12} className="tm-fw-back__icon" />
                {s('item.back')}
              </span>
              <Mono>TSK-1042 · Atlas Website Relaunch</Mono>
            </p>
            <p className="tm-section-head__title tm-fw-item__title">{s('card.mobileConcepts')}</p>
            <p className="tm-fw-item__chips">
              <StateCapsule state="blocked">{s('item.blocked')}</StateCapsule>
              <span className="tm-fw-pill">
                <Initials name="LS" tone="ink" />
                Lina Samir
              </span>
              <span className="tm-fw-pill">
                <span className="tm-fw-pill__ring" />
                {s('item.internal')}
              </span>
            </p>
            <div className="tm-fw-next">
              <span className="tm-fw-next__orb">
                <WebIcon name="play" size={12} />
              </span>
              <span className="tm-fw-next__text">
                <span className="tm-fw-next__title">{s('item.nextTitle')}</span>
                <span className="tm-fw-next__why">
                  {s('item.nextWhy', { date: f.day('2026-08-20', '20 Aug') })}
                </span>
              </span>
              <span className="tm-fw-next__go">
                <WebIcon name="arrow-right" size={12} />
              </span>
            </div>
            <dl className="tm-fw-facts">
              <div>
                <dt className="tm-web-eyebrow">{s('fact.committed')}</dt>
                <dd>{f.day('2026-08-20', '20 Aug 2026', withYear)}</dd>
              </div>
              <div>
                <dt className="tm-web-eyebrow">{s('fact.forecast')}</dt>
                <dd className="tm-fw-late">{f.day('2026-08-25', '25 Aug 2026', withYear)}</dd>
              </div>
              <div>
                <dt className="tm-web-eyebrow">{s('fact.milestone')}</dt>
                <dd>{s('milestone.homepage')}</dd>
              </div>
              <div>
                <dt className="tm-web-eyebrow">{s('fact.source')}</dt>
                <dd>#atlas-relaunch</dd>
              </div>
            </dl>
            <p className="tm-fw-item__desc">{s('item.desc')}</p>
          </div>
          <div className="tm-fw-panel tm-fw-item__subtasks">
            <p className="tm-fw-subtasks__head">
              <span className="tm-fw-subtasks__title">{s('subtasks.title')}</span>
              <Mono>{s('subtasks.progress', { done: f.num(2), total: f.num(4) })}</Mono>
            </p>
            <ul className="tm-fw-subtasks">
              {SUBTASKS.map((task) => (
                <li
                  key={task.key}
                  className={cx(
                    'tm-fw-subtask',
                    task.done && 'is-done',
                    task.blocked && 'is-blocked',
                  )}
                >
                  <span className="tm-fw-box">
                    {task.done ? <WebIcon name="check" size={12} /> : null}
                  </span>
                  <span className="tm-fw-subtask__title">{s(`subtask.${task.key}`)}</span>
                  {task.blocked ? <Mono className="tm-fw-late">{s('item.blocked')}</Mono> : null}
                  {task.who ? (
                    <Initials name={task.who} tone={task.done ? 'ink' : 'paper'} />
                  ) : null}
                </li>
              ))}
              <li className="tm-fw-subtask tm-fw-subtask--add">
                <span className="tm-fw-box tm-fw-box--ghost" />
                <span className="tm-fw-subtask__title">{s('subtask.add')}</span>
                <Mono>{s('subtask.reorder')}</Mono>
              </li>
            </ul>
          </div>
        </div>
        <div className="tm-fw-item__side">
          <div className="tm-fw-panel tm-fw-item__story">
            <Mono>{s('story.title')}</Mono>
            <ol className="tm-fw-story">
              <li>
                <Mono>{s('story.requested', { date: f.day('2026-08-14', '14 Aug') })}</Mono>
                <span>{s('story.requestedText')}</span>
              </li>
              <li>
                <Mono>{s('story.committed', { date: f.day('2026-08-14', '14 Aug') })}</Mono>
                <span>{s('story.committedText', { date: f.day('2026-08-20', '20 Aug') })}</span>
              </li>
              <li className="is-now">
                <Mono>{s('story.now', { hours: f.num(3) })}</Mono>
                <span>{s('story.nowText')}</span>
              </li>
            </ol>
          </div>
          <div className="tm-fw-deps">
            <Mono>{s('deps.title')}</Mono>
            <div className="tm-fw-deps__box">
              <Mono className="tm-fw-deps__label">{s('deps.blockedBy', { n: f.num(1) })}</Mono>
              <span>{s('deps.assetPack')}</span>
            </div>
            <span className="tm-fw-deps__plus">+</span>
            <div className="tm-fw-deps__box tm-fw-deps__box--this">
              <Mono className="tm-fw-deps__label">{s('deps.thisTask')}</Mono>
              <span>{s('card.mobileConcepts')}</span>
            </div>
            <span className="tm-fw-deps__plus">+</span>
            <div className="tm-fw-deps__box">
              <Mono className="tm-fw-deps__label">{s('deps.blocks', { n: f.num(2) })}</Mono>
              <span>{s('deps.mobileReview')}</span>
              <span>{s('deps.milestone')}</span>
            </div>
            <p className="tm-fw-deps__warn">{s('deps.warn')}</p>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Views: list, board, timeline ────────────────────────────────────────────── */

interface ListRow {
  type: string;
  title: string;
  who: string;
  state: CapsuleState;
  label: string;
  committed: string;
  forecast: string;
  late?: boolean;
  checked?: boolean;
}

function listRows(s: SceneText, f: SceneFormat): readonly ListRow[] {
  const aug18 = f.day('2026-08-18', '18 Aug');
  return [
    {
      type: 'DEL',
      title: s('deliverable.concept'),
      who: 'OA',
      state: 'client',
      label: s('state.clientReview'),
      committed: aug18,
      forecast: aug18,
      checked: true,
    },
    {
      type: 'TSK',
      title: s('card.mobileConcepts'),
      who: 'LS',
      state: 'blocked',
      label: s('item.blocked'),
      committed: f.day('2026-08-20', '20 Aug'),
      forecast: f.day('2026-08-25', '25 Aug'),
      late: true,
      checked: true,
    },
    {
      type: 'TSK',
      title: s('card.ctaMicrocopy'),
      who: 'NF',
      state: 'future',
      label: s('col.notStarted'),
      committed: f.day('2026-08-19', '19 Aug'),
      forecast: f.day('2026-08-19', '19 Aug'),
      checked: true,
    },
    {
      type: 'DEC',
      title: s('card.homepageDecision'),
      who: 'MH',
      state: 'current',
      label: s('col.inProgress'),
      committed: aug18,
      forecast: aug18,
    },
    {
      type: 'TSK',
      // Already Arabic on the English page: the list shows a bilingual workspace.
      title: 'ترجمة صفحة الأسئلة الشائعة',
      who: 'NF',
      state: 'future',
      label: s('col.notStarted'),
      committed: f.day('2026-09-01', '1 Sep'),
      forecast: f.day('2026-09-08', '8 Sep'),
      late: true,
    },
    {
      type: 'REQ',
      title: s('req.title'),
      who: 'SR',
      state: 'waiting',
      label: s('state.needsTriage'),
      committed: s('list.notSet'),
      forecast: s('list.desired', { date: f.day('2026-09-03', '3 Sep') }),
    },
  ];
}

export function ListViewScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('ListViewScene.label')} className="tm-fw-scene--mini">
      <div className="tm-fw-list">
        <div className="tm-fw-list__row tm-fw-list__row--head">
          <span className="tm-fw-box tm-fw-box--ghost" />
          <Mono className="tm-fw-list__title">{s('list.workItem')}</Mono>
          <Mono>{s('list.owner')}</Mono>
          <Mono className="tm-fw-list__state">{s('list.state')}</Mono>
          <Mono>{s('fact.committed')}</Mono>
          <Mono>{s('fact.forecast')}</Mono>
        </div>
        <div className="tm-fw-list__row tm-fw-list__row--group">
          <Mono>{s('list.group')}</Mono>
          <StateCapsule state="current">{s('list.groupState', { days: f.num(4) })}</StateCapsule>
          <Mono>{s('list.items', { n: f.num(6) })}</Mono>
        </div>
        {listRows(s, f).map((row) => (
          <div key={row.title} className={cx('tm-fw-list__row', row.checked && 'is-checked')}>
            <span className={cx('tm-fw-box', row.checked && 'tm-fw-box--on')}>
              {row.checked ? <WebIcon name="check" size={12} /> : null}
            </span>
            <span className="tm-fw-list__title">
              <Mono>{row.type}</Mono>
              <Clip>{row.title}</Clip>
            </span>
            <Initials name={row.who} tone="ink" />
            <span className="tm-fw-list__state">
              <StateCapsule state={row.state}>{row.label}</StateCapsule>
            </span>
            <Mono>{row.committed}</Mono>
            <Mono className={row.late ? 'tm-fw-late' : undefined}>{row.forecast}</Mono>
          </div>
        ))}
      </div>
    </Scene>
  );
}

export function BoardViewScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('BoardViewScene.label')} className="tm-fw-scene--mini">
      <div className="tm-fw-board__cols tm-fw-board__cols--mini">
        <BoardColumn title={s('col.notStarted')} count={f.num(10)} cards={notStartedCards(s, f)} />
        <BoardColumn
          title={s('col.inProgress')}
          count={s('col.wip', { count: f.num(9), limit: f.num(6) })}
          flag={s('col.atLimit')}
          cards={inProgressCards(s, f)}
        />
      </div>
    </Scene>
  );
}

const TIMELINE_ROWS: readonly {
  type: string;
  key: string;
  start: number;
  span: number;
  tone: 'ink' | 'late' | 'outline';
  slipDays?: number;
}[] = [
  { type: 'DEL', key: 'deliverable.concept', start: 8, span: 26, tone: 'ink' },
  { type: 'TSK', key: 'tl.mobileShort', start: 14, span: 24, tone: 'late', slipDays: 5 },
  { type: 'TSK', key: 'card.faqCopy', start: 36, span: 22, tone: 'outline' },
  { type: 'TSK', key: 'tl.validation', start: 46, span: 30, tone: 'late' },
  { type: 'TSK', key: 'tl.quality', start: 66, span: 20, tone: 'outline' },
];

export function TimelineViewScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('TimelineViewScene.label')} className="tm-fw-scene--mini">
      <div className="tm-fw-timeline">
        <div className="tm-fw-timeline__row tm-fw-timeline__row--head">
          <Mono className="tm-fw-timeline__name">{s('tl.work')}</Mono>
          <span className="tm-fw-timeline__track tm-fw-timeline__scale">
            <Mono>{f.day('2026-08-12', 'Aug 12')}</Mono>
            <Mono className="tm-fw-timeline__today">{f.day('2026-08-18', 'Aug 18')}</Mono>
            <Mono>{f.day('2026-08-25', 'Aug 25')}</Mono>
          </span>
        </div>
        <div className="tm-fw-timeline__row">
          <Mono className="tm-fw-timeline__name">{s('tl.milestones')}</Mono>
          <span className="tm-fw-timeline__track">
            <span className="tm-fw-timeline__milestone">
              <StateCapsule state="current">
                {s('tl.milestone', { date: f.day('2026-08-18', '18 Aug') })}
              </StateCapsule>
            </span>
          </span>
        </div>
        {TIMELINE_ROWS.map((row) => (
          <div key={row.key} className="tm-fw-timeline__row">
            <span className="tm-fw-timeline__name">
              <Mono>{row.type}</Mono>
              <Clip>{s(row.key)}</Clip>
            </span>
            <span className="tm-fw-timeline__track">
              <span
                className={cx('tm-fw-bar', `tm-fw-bar--${row.tone}`)}
                style={{ insetInlineStart: `${row.start}%`, inlineSize: `${row.span}%` }}
              />
              {row.slipDays ? (
                <Mono className="tm-fw-bar__slip tm-fw-late">
                  {s('tl.slip', { days: f.num(row.slipDays) })}
                </Mono>
              ) : null}
            </span>
          </div>
        ))}
        <Mono className="tm-fw-timeline__legend">{s('tl.legend')}</Mono>
      </div>
    </Scene>
  );
}

/* ── Projects & portfolio: Project Pulse plan ────────────────────────────────── */

interface MilestoneRow {
  key: string;
  title: string;
  mark: 'done' | 'current' | 'risk' | 'future';
  tag?: ReactNode;
  baseline: string;
  committed: string;
  forecast: string;
  late?: boolean;
  evidence: string;
}

function milestones(s: SceneText, f: SceneFormat): readonly MilestoneRow[] {
  const evidence = (done: number, total: number) => `${f.num(done)} / ${f.num(total)}`;
  const jul20 = f.day('2026-07-20', '20 Jul');
  const aug18 = f.day('2026-08-18', '18 Aug');
  const sep1 = f.day('2026-09-01', '1 Sep');
  const sep30 = f.day('2026-09-30', '30 Sep');
  return [
    {
      key: 'discovery',
      title: s('m.discovery'),
      mark: 'done',
      baseline: jul20,
      committed: jul20,
      forecast: s('pulse.done'),
      evidence: evidence(3, 3),
    },
    {
      key: 'homepage',
      title: s('milestone.homepage'),
      mark: 'current',
      tag: <StateCapsule state="current">{s('pulse.current')}</StateCapsule>,
      baseline: aug18,
      committed: aug18,
      forecast: aug18,
      evidence: evidence(2, 6),
    },
    {
      key: 'migration',
      title: s('m.migration'),
      mark: 'risk',
      baseline: sep1,
      committed: sep1,
      forecast: f.day('2026-09-03', '3 Sep'),
      late: true,
      evidence: evidence(4, 11),
    },
    {
      key: 'quality',
      title: s('m.quality'),
      mark: 'future',
      baseline: f.day('2026-09-18', '18 Sep'),
      committed: f.day('2026-09-20', '20 Sep'),
      forecast: f.day('2026-09-24', '24 Sep'),
      late: true,
      evidence: evidence(0, 6),
    },
    {
      key: 'launch',
      title: s('m.launch'),
      mark: 'future',
      tag: <Badge mono>{s('pulse.clientCommitment')}</Badge>,
      baseline: sep30,
      committed: sep30,
      forecast: sep30,
      evidence: evidence(0, 4),
    },
  ];
}

const PULSE_TABS = ['overview', 'plan', 'work', 'story', 'team', 'settings'] as const;

export function ProjectPulseScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('ProjectPulseScene.label')} className="tm-fw-scene--pulse">
      <div className="tm-fw-pulse">
        <span className="tm-fw-seg tm-fw-seg--tabs">
          {PULSE_TABS.map((tab) => (
            <span key={tab} className={tab === 'plan' ? 'is-on' : undefined}>
              {s(`pulse.tab.${tab}`)}
            </span>
          ))}
        </span>
        <Mono className="tm-fw-pulse__eyebrow">{s('pulse.eyebrow')}</Mono>
        <p className="tm-web-header__title tm-fw-pulse__title">{s('pulse.title')}</p>
        <div className="tm-fw-pulse__table">
          <div className="tm-fw-pulse__row tm-fw-pulse__row--head">
            <Mono>{s('fact.milestone')}</Mono>
            <Mono className="tm-fw-pulse__baseline">{s('pulse.baseline')}</Mono>
            <Mono>{s('fact.committed')}</Mono>
            <Mono>{s('fact.forecast')}</Mono>
            <Mono>{s('pulse.evidence')}</Mono>
          </div>
          {milestones(s, f).map((m) => (
            <div
              key={m.key}
              className={cx('tm-fw-pulse__row', m.mark === 'current' && 'is-current')}
            >
              <span className="tm-fw-pulse__name">
                <span className={cx('tm-fw-mark', `tm-fw-mark--${m.mark}`)} />
                <span className="tm-fw-pulse__label">{m.title}</span>
                {m.tag}
              </span>
              <Mono className="tm-fw-pulse__baseline">{m.baseline}</Mono>
              <span className="tm-fw-pulse__strong">{m.committed}</span>
              <span className={cx('tm-fw-pulse__strong', m.late && 'tm-fw-late')}>
                {m.forecast}
              </span>
              <Mono>{m.evidence}</Mono>
            </div>
          ))}
          <p className="tm-fw-pulse__note">{s('pulse.note')}</p>
        </div>
      </div>
    </Scene>
  );
}

/* ── Templates: phase strip preview ──────────────────────────────────────────── */

export type PhaseTone = 'internal' | 'client' | 'launch';

export function TemplatePreview({
  label,
  phases,
  steps,
}: {
  label: string;
  phases: readonly PhaseTone[];
  steps: readonly { title: string; when: string; tone: PhaseTone }[];
}) {
  return (
    <Scene label={label} className="tm-fw-scene--template">
      <div className="tm-fw-tpl">
        <span className="tm-fw-tpl__phases">
          {phases.map((tone, index) => (
            // The strip is a fixed, ordered sequence; the index is its identity.
            <span key={index} className={cx('tm-fw-tpl__phase', `tm-fw-tpl__phase--${tone}`)} />
          ))}
        </span>
        <ul className="tm-fw-tpl__steps">
          {steps.map((step) => (
            <li key={step.title}>
              <span className={cx('tm-fw-tpl__dot', `tm-fw-tpl__dot--${step.tone}`)} />
              <span className="tm-fw-tpl__step">{step.title}</span>
              <Mono>{step.when}</Mono>
            </li>
          ))}
        </ul>
      </div>
    </Scene>
  );
}
